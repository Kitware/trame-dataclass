import { ref, reactive, watch } from "vue";

function updateWidget(id, objectState, widgetState) {
  if (widgetState.data._id !== id) {
    widgetState.data._id = id;
    const keys = Object.keys(widgetState.data);
    for (let name of keys) {
      delete widgetState.data[name];
    }
  }

  Object.assign(widgetState.data, objectState.refs);
}

function updateServerState(serverState, partialState) {
  if (!partialState) {
    return serverState;
  }
  for (const [key, value] of Object.entries(partialState)) {
    serverState[key] = JSON.stringify([value]);
  }
  return serverState;
}

export class DataclassManager {
  constructor() {
    this.client = null;
    this.subscription = null;
    this.dataStates = {};
    this.dataTypes = {};
    this.typeDefinitions = {};
    this.vueComponents = {};
    this.internalReactiveObjects = {};
    this.pendingClientServerQueue = [];
    this.pendingFlushRequest = 0;
    this.triggers = {};
    this.deepReactiveWatchers = {};
    this.pendingDeepReactives = {};
    this.pendingFetch = {};
    this.pendingDefinition = {};
    this.pendingPublications = {};
    this.revisions = {};
    this.completeInstances = new Set();
    // At most this many state and definition requests in flight: a graph of thousands
    // of instances queues behind it instead of flooding the server.
    this.maxConcurrentCalls = 16;
    this.activeCalls = 0;
    this.queuedCalls = [];
  }

  connect(client) {
    if (this.client || !client) return;
    this.client = client;

    this.subscription = client
      .getConnection()
      .getSession()
      .subscribe("trame.dataclass.publish", ([event]) =>
        this.enqueuePublication(event),
      );
  }

  enqueuePublication(event) {
    const { id } = event;
    // Capture discovery now, before a promise callback can let a later message
    // mistake the same instance for another first publication.
    const discovery = !this.pendingFetch[id] && !this.dataStates[id];
    // A delta only needs this instance's own refs, not the instances it points at.
    const hydration = this.fetchInstance(id);
    const previous = this.pendingPublications[id] || Promise.resolve();
    const next = previous.then(async () => {
      await hydration;
      const { state, revision } = event;
      if (revision === undefined) {
        // The v1 protocol, which also uses this client, does not carry revisions.
        // Its discovery publication precedes the state request and is already
        // represented by that reply.
        if (discovery) return;
      } else if (revision <= this.revisions[id]) {
        return;
      }

      // Never commit a reference to a graph that is still arriving: wait for every
      // instance this delta points at, and everything those reach. Fetching never
      // waits on this queue, so a cycle in the graph cannot deadlock here.
      await Promise.all(
        this.referencedInstances(id, state).map((childId) =>
          this.fetchInstanceRecursive(childId),
        ),
      );

      // A whole asynchronous publication owns the instance until its referenced
      // instances are complete, and the commit below is synchronous. No newer
      // callback can overwrite its cache and then be rolled back.
      updateServerState(this.dataStates[id].server, state);
      for (const [key, value] of Object.entries(state)) {
        if (this.isDataClass(id, key)) {
          this.handleNestedDataClass(id, key, value);
        } else {
          this.dataStates[id].refs[key].value = this.wrapValue(id, key, value);
        }
      }
      this.revisions[id] = revision;
    });
    // A failed update is reported, but cannot poison all future queue entries.
    const settled = next.catch((error) => {
      console.error(`Dataclass publication failed for ${id}`, error);
    });
    this.pendingPublications[id] = settled;
    settled.then(() => {
      if (this.pendingPublications[id] === settled) {
        delete this.pendingPublications[id];
      }
    });
    return settled;
  }

  updateServer(id, name, value) {
    if (this.isDataClass(id, name)) {
      this.pendingClientServerQueue.push([
        id,
        name,
        JSON.stringify([this.serializeDataClass(value)]),
      ]);
    } else {
      this.pendingClientServerQueue.push([id, name, JSON.stringify([value])]);
    }
    this.flushToServer();
  }

  serializeDataClass(value) {
    if (value === null) {
      return value;
    }
    if (Array.isArray(value)) {
      // array[id...]
      return value.map((v) => v._id);
    }

    // dict[str, id] or direct dataclass
    if (value._id) {
      // => direct dataclass
      return value._id;
    }

    // => dict[str,id]
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = v._id;
    }

    return result;
  }

  async flushToServer() {
    if (this.pendingFlushRequest) {
      return;
    }
    this.pendingFlushRequest++;
    const msg = {};
    let sendingSomething = 0;
    while (this.pendingClientServerQueue.length) {
      const [id, name, strValue] = this.pendingClientServerQueue.shift();
      const [value] = JSON.parse(strValue);
      let valueToSend = value;

      if (this.dataStates[id].server[name] === strValue) {
        continue;
      }
      if (!msg[id]) {
        msg[id] = {};
      }
      msg[id][name] = valueToSend;
      sendingSomething++;
    }
    if (sendingSomething) {
      try {
        // Update server cache
        for (const [id, state] of Object.entries(msg)) {
          updateServerState(this.dataStates[id].server, state);
        }

        await this.client
          .getConnection()
          .getSession()
          .call("trame.dataclass.state.update", [msg]);
      } catch (error) {
        console.error("Network error when pushing client state", error);
      }
    }

    this.pendingFlushRequest--;
    if (this.pendingClientServerQueue.length) {
      this.flushToServer();
    }
  }

  isDataClass(id, name) {
    return this.typeDefinitions[this.dataTypes[id]].dataclass_containers[name];
  }

  // Ids held by a dataclass field, whichever container holds them.
  idsOf(value) {
    if (value === null || value === undefined) return [];
    if (typeof value === "string") return [value];
    return Object.values(value);
  }

  // Ids of the instances a delta points at.
  referencedInstances(id, state) {
    return Object.entries(state)
      .filter(([key]) => this.isDataClass(id, key))
      .flatMap(([, value]) => this.idsOf(value));
  }

  // Ids of the instances `id` points at now, read off its committed refs. Every
  // shared reactive object carries its `_id` from creation, so this works before the
  // instances it stands for have arrived.
  childIds(id) {
    const { refs } = this.dataStates[id];
    return Object.keys(refs)
      .filter((key) => this.isDataClass(id, key))
      .flatMap((key) => this.idsOf(this.serializeDataClass(refs[key].value)));
  }

  isClientOnly(id, name) {
    return this.typeDefinitions[this.dataTypes[id]]?.client_only[name];
  }

  isDeepReactive(id, name) {
    return this.typeDefinitions[this.dataTypes[id]]?.deep_reactive[name];
  }

  wrapValue(id, name, value) {
    if (!this.isDeepReactive(id, name)) {
      return value;
    }

    const fullKey = `${id}::${name}`;
    const unwatch = this.deepReactiveWatchers[fullKey];
    if (unwatch) {
      unwatch();
    }
    this.deepReactiveWatchers[fullKey] = null;

    if (value === null || value === undefined) {
      return value;
    }

    const r = reactive(value);
    const trigger = this.triggers[fullKey];
    if (!trigger) {
      if (!this.pendingDeepReactives[id]) {
        this.pendingDeepReactives[id] = [];
      }
      this.pendingDeepReactives[id].push([fullKey, r]);
    } else {
      this.deepReactiveWatchers[fullKey] = watch(r, trigger);
    }
    return r;
  }

  // The shared reactive object standing for `objId` wherever it is referenced. Its
  // fetch is started, not awaited: the fetch fills this object when it lands, and
  // whoever needs the instance complete waits with `fetchInstanceRecursive`.
  sharedInstance(objId) {
    if (!this.internalReactiveObjects[objId]) {
      this.internalReactiveObjects[objId] = reactive({ _id: objId });
      if (this.dataStates[objId]) {
        Object.assign(
          this.internalReactiveObjects[objId],
          this.dataStates[objId].refs,
        );
      }
    }
    // A failure surfaces to whoever waits on this instance, which also retries it.
    this.fetchInstance(objId).catch(() => {});
    return this.internalReactiveObjects[objId];
  }

  handleNestedDataClass(id, key, value) {
    if (value === null) {
      if (!this.dataStates[id].refs[key]) {
        this.dataStates[id].refs[key] = ref(value);
      } else {
        this.dataStates[id].refs[key].value = value;
      }
    } else if (Array.isArray(value)) {
      // array structure
      const newArray = this.wrapValue(id, key, []);
      for (const objId of value) {
        newArray.push(this.sharedInstance(objId));
      }
      if (!this.dataStates[id].refs[key]) {
        this.dataStates[id].refs[key] = ref(this.wrapValue(id, key, newArray));
      } else {
        this.dataStates[id].refs[key].value = this.wrapValue(id, key, newArray);
      }
    } else if (typeof value === "string") {
      // direct dataclass
      const shared = this.sharedInstance(value);
      if (!this.dataStates[id].refs[key]) {
        this.dataStates[id].refs[key] = ref(shared);
      } else {
        this.dataStates[id].refs[key].value = shared;
      }
    } else {
      // dict structure
      const newStruct = this.wrapValue(id, key, {});
      for (const [k, objId] of Object.entries(value)) {
        newStruct[k] = this.sharedInstance(objId);
      }
      this.dataStates[id].refs[key].value = newStruct;
    }
  }

  getTrigger(id, key, refs) {
    const fullKey = `${id}::${key}`;
    const fn = this.triggers[fullKey];
    if (fn) {
      return fn;
    }
    this.triggers[fullKey] = () => {
      this.updateServer(id, key, refs[key].value);
    };
    return this.triggers[fullKey];
  }

  async getGUITemplate(id) {
    if (!id) return "";
    await this.fetchInstance(id);
    const definition = this.typeDefinitions[this.dataTypes[id]];
    return definition?.template || "";
  }

  // Every fetch goes through here, so at most `maxConcurrentCalls` requests are in
  // flight. A slot is held for one request only, never while waiting on another, so
  // this cannot deadlock. An `urgent` request skips the queue: a class definition
  // unblocks every instance of its class.
  async callServer(method, args, urgent = false) {
    if (this.activeCalls < this.maxConcurrentCalls) {
      this.activeCalls++;
    } else {
      // A finishing call hands its slot straight over, so none is taken twice.
      await new Promise((resolve) =>
        urgent
          ? this.queuedCalls.unshift(resolve)
          : this.queuedCalls.push(resolve),
      );
    }
    try {
      return await this.client.getConnection().getSession().call(method, args);
    } finally {
      const next = this.queuedCalls.shift();
      if (next) {
        next();
      } else {
        this.activeCalls--;
      }
    }
  }

  // One instance: its state, its class definition and its own refs. The instances it
  // points at are started, never awaited, so this never waits on another instance and
  // no cycle in the graph can deadlock it. `dataStates[id]` is only set once its refs
  // are built, so its presence means this instance is usable.
  async fetchInstance(id) {
    if (this.pendingFetch[id]) {
      return await this.pendingFetch[id];
    }
    const pending = (async () => {
      const data = await this.callServer("trame.dataclass.state.get", [id]);
      if (!this.typeDefinitions[data.definition]) {
        await this.fetchDefinition(data.definition);
      }

      const refs = { _id: id };
      this.dataTypes[id] = data.definition;
      this.dataStates[id] = {
        refs,
        server: updateServerState({}, data.state),
      };

      for (const [key, value] of Object.entries(data.state)) {
        // check if nested dataclass
        if (this.isDataClass(id, key)) {
          refs[key] = ref(null);
          this.handleNestedDataClass(id, key, value);
        } else {
          refs[key] = ref(this.wrapValue(id, key, value));
        }
        if (!this.isClientOnly(id, key)) {
          const trigger = this.getTrigger(id, key, refs);
          watch(refs[key], trigger);

          const items = this.pendingDeepReactives[id] || [];
          while (items.length) {
            const [fullKey, r] = items.pop();
            const trigger = this.getTrigger(id, key, refs);
            this.deepReactiveWatchers[fullKey] = watch(r, trigger);
          }
        }
      }

      if (this.internalReactiveObjects[id]) {
        Object.assign(
          this.internalReactiveObjects[id],
          this.dataStates[id].refs,
        );
      }
      this.revisions[id] = data.revision;
      return this.dataStates[id];
    })().catch((error) => {
      // Forget the failed attempt, so the next request for this id starts over
      // instead of every later caller re-awaiting the same rejection.
      delete this.pendingFetch[id];
      delete this.dataStates[id];
      delete this.dataTypes[id];
      throw error;
    });
    this.pendingFetch[id] = pending;
    return await pending;
  }

  // `id` and every instance it reaches, one level of the graph at a time: each level
  // is fetched in parallel, and a cycle is only an instance already seen. A complete
  // instance stays complete, because a publication never commits a reference before
  // its target is complete, so it is not walked again.
  async fetchInstanceRecursive(id) {
    if (this.completeInstances.has(id)) {
      return this.dataStates[id];
    }
    const seen = new Set([id]);
    let level = [id];
    while (level.length) {
      await Promise.all(level.map((levelId) => this.fetchInstance(levelId)));
      const next = [];
      for (const parentId of level) {
        for (const childId of this.childIds(parentId)) {
          if (!seen.has(childId) && !this.completeInstances.has(childId)) {
            seen.add(childId);
            next.push(childId);
          }
        }
      }
      level = next;
    }
    seen.forEach((seenId) => this.completeInstances.add(seenId));
    return this.dataStates[id];
  }

  async fetchDefinition(id) {
    // `typeDefinitions[id]` is only set once the reply lands, so every instance of a
    // class hydrating at the same time saw it missing and asked again: a wave of N
    // instances of one class cost N definition requests. Share the in-flight promise.
    if (this.pendingDefinition[id]) {
      return await this.pendingDefinition[id];
    }
    const pending = this.callDefinition(id).catch((error) => {
      // Conditional, so a failure cannot evict a request that replaced it.
      if (this.pendingDefinition[id] === pending) {
        delete this.pendingDefinition[id];
      }
      throw error;
    });
    this.pendingDefinition[id] = pending;
    return await pending;
  }

  async callDefinition(id) {
    const data = await this.callServer(
      "trame.dataclass.definition.get",
      [id],
      true,
    );

    this.typeDefinitions[id] = {
      template: `No GUI for dataclass ${id}`,
      ...data,
      dataclass_containers: {},
      client_only: {},
      deep_reactive: {},
    };
    const toDict = ["dataclass_containers", "client_only", "deep_reactive"];
    while (toDict.length) {
      const arrayName = toDict.pop();
      for (let i = 0; i < data[arrayName].length; i++) {
        this.typeDefinitions[id][arrayName][data[arrayName][i]] = 1;
      }
    }
  }

  async link(dataId, componentId) {
    // A component only ever sees a complete graph.
    await this.fetchInstanceRecursive(dataId);
    // It may have moved on to another instance while this one arrived.
    if (this.vueComponents[componentId]?.id !== dataId) {
      return;
    }

    updateWidget(
      dataId,
      this.dataStates[dataId],
      this.vueComponents[componentId],
    );
  }

  async connectVueComponent(componentId, internals) {
    const prevDataId = this.vueComponents[componentId]?.id;
    const newDataId = internals.id;
    if (prevDataId === newDataId) {
      return false;
    }
    this.vueComponents[componentId] = internals;
    await this.link(newDataId, componentId);
    return true;
  }

  disconnectVueComponent(componentId) {
    delete this.vueComponents[componentId];
  }
}
