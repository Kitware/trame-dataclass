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
    this.dataToVue = {};
    this.pendingClientServerQueue = [];
    this.pendingFlushRequest = 0;
    this.triggers = {};
    this.deepReactiveWatchers = {};
    this.pendingDeepReactives = {};
    this.pendingFetch = {};
    this.pendingDefinition = {};
  }

  connect(client) {
    if (this.client || !client) return;
    this.client = client;

    this.subscription = client
      .getConnection()
      .getSession()
      .subscribe("trame.dataclass.publish", async ([event]) => {
        const { id, state } = event;
        if (!this.dataStates[id]) {
          await this.fetchState(id);
          return;
        }

        // Capture server state for update comparison
        updateServerState(this.dataStates[id].server, state);

        for (const [key, value] of Object.entries(state)) {
          if (this.isDataClass(id, key)) {
            await this.handleNestedDataClass(id, key, value);
          } else {
            this.dataStates[id].refs[key].value = this.wrapValue(
              id,
              key,
              value,
            );
          }
        }
      });
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

  async handleNestedDataClass(id, key, value) {
    if (value === null) {
      if (!this.dataStates[id].refs[key]) {
        this.dataStates[id].refs[key] = ref(value);
      } else {
        this.dataStates[id].refs[key].value = value;
      }
    } else if (Array.isArray(value)) {
      // array structure
      const newArray = this.wrapValue(id, key, []);
      for (let i = 0; i < value.length; i++) {
        const objId = value[i];
        let needUpdate = false;
        if (!this.internalReactiveObjects[objId]) {
          this.internalReactiveObjects[objId] = reactive({});
          needUpdate = true;
        }
        newArray.push(this.internalReactiveObjects[objId]);
        if (!this.dataStates[objId]) {
          needUpdate = false;
          await this.fetchState(objId);
        }

        if (needUpdate) {
          Object.assign(
            this.internalReactiveObjects[objId],
            this.dataStates[objId].refs,
          );
        }
      }
      if (!this.dataStates[id].refs[key]) {
        this.dataStates[id].refs[key] = ref(this.wrapValue(id, key, newArray));
      } else {
        this.dataStates[id].refs[key].value = this.wrapValue(id, key, newArray);
      }
    } else if (typeof value === "string") {
      // direct dataclass
      const objId = value;
      if (!this.internalReactiveObjects[objId]) {
        this.internalReactiveObjects[objId] = reactive({});
      }
      if (!this.dataStates[objId]) {
        await this.fetchState(objId);
      } else {
        Object.assign(
          this.internalReactiveObjects[objId],
          this.dataStates[objId].refs,
        );
      }
      if (!this.dataStates[id].refs[key]) {
        this.dataStates[id].refs[key] = ref(
          this.internalReactiveObjects[objId],
        );
      } else {
        this.dataStates[id].refs[key].value =
          this.internalReactiveObjects[objId];
      }
    } else {
      // dict structure
      const newStruct = this.wrapValue(id, key, {});

      for (const [k, objId] of Object.entries(value)) {
        if (!this.internalReactiveObjects[objId]) {
          this.internalReactiveObjects[objId] = reactive({});
        }
        newStruct[k] = this.internalReactiveObjects[objId];
        if (!this.dataStates[objId]) {
          await this.fetchState(objId);
        } else {
          Object.assign(
            this.internalReactiveObjects[objId],
            this.dataStates[objId].refs,
          );
        }
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
    if (!this.dataStates[id]) {
      await this.fetchState(id);
    }
    const definition = this.typeDefinitions[this.dataTypes[id]];
    return definition?.template || "";
  }

  // Start every one of these hydrating now, and resolve once all of them are done.
  //
  // Providers nest, and a provider's slot waits for its own instance, so provider N+1
  // is not created until provider N's reply has landed: N of them cost N round trips
  // END TO END rather than N requests in flight. Asking for them all up front leaves
  // each provider to find its own hydration already under way.
  //
  // This reuses `fetchState`, so each id is still completed over its whole graph, the
  // requests underneath are still deduplicated, and nothing is batched.
  //
  // `allSettled`, not `all`: one instance that is gone or refused must not take the
  // rest of the wave with it. The caller is told which ids are ready.
  async prefetch(ids) {
    const settled = await Promise.allSettled(
      ids.map((id) => this.fetchState(id)),
    );
    return ids.map((id, index) => ({
      id,
      ready: settled[index].status === "fulfilled",
      error:
        settled[index].status === "rejected" ? settled[index].reason : null,
    }));
  }

  async fetchState(id) {
    if (this.pendingFetch[id]) {
      return await this.pendingFetch[id];
    }
    this.pendingFetch[id] = new Promise(async (resolve) => {
      const refs = { _id: id };
      const data = await this.client
        .getConnection()
        .getSession()
        .call("trame.dataclass.state.get", [id]);

      this.dataTypes[id] = data.definition;
      this.dataStates[id] = {
        refs,
        server: updateServerState({}, data.state),
      };

      if (!this.typeDefinitions[data.definition]) {
        await this.fetchDefinition(data.definition);
      }

      for (const [key, value] of Object.entries(data.state)) {
        // check if nested dataclass
        if (this.isDataClass(id, key)) {
          refs[key] = ref(null);
          await this.handleNestedDataClass(id, key, value);
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

      if (this.dataToVue[id]) {
        this.dataToVue[id].forEach((componentId) => {
          updateWidget(
            id,
            this.dataStates[id],
            this.vueComponents[componentId],
          );
        });
      }
      if (this.internalReactiveObjects[id]) {
        Object.assign(
          this.internalReactiveObjects[id],
          this.dataStates[id].refs,
        );
      }
      resolve(this.dataStates[id]);
    });
    return await this.pendingFetch[id];
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
    const data = await this.client
      .getConnection()
      .getSession()
      .call("trame.dataclass.definition.get", [id]);

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

  unlink(dataId, componentId) {
    if (this.dataToVue[dataId]) {
      this.dataToVue[dataId] = this.dataToVue[dataId].filter(
        (v) => v !== componentId,
      );
    }
  }

  async link(dataId, componentId) {
    if (!this.dataToVue[dataId]) {
      this.dataToVue[dataId] = [componentId];
    } else {
      this.dataToVue[dataId].push(componentId);
    }

    // Put initial state. Await COMPLETION rather than testing the allocation:
    // `dataStates[id]` is created as soon as the state reply lands, before the class
    // definition and the nested refs are filled in, so a component that links during
    // that window used to be handed an instance whose fields are still undefined.
    // Serial hydration made the window hard to reach; starting a wave together makes
    // it ordinary. `fetchState` deduplicates, so this is a wait, not a request.
    await this.fetchState(dataId);

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
    this.unlink(prevDataId, componentId);
    this.vueComponents[componentId] = internals;
    await this.link(newDataId, componentId);
    return true;
  }

  disconnectVueComponent(componentId) {
    const dataId = this.vueComponents[componentId]?.id;
    delete this.vueComponents[componentId];
    this.unlink(dataId, componentId);
  }
}
