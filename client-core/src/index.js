// Framework-agnostic half of the trame-dataclass client, bundled into both the
// Vue (vue-components) and the React (react-components) client.
//
// It owns everything that talks to the server: fetching instances and their
// class definitions, walking the instance graph, ordering publications, and
// pushing client edits back. A subclass owns how an instance is represented in
// its framework, by implementing:
//
// - `buildInstance(id, state)`: create an instance from its first snapshot.
// - `applyState(id, state)`: apply a delta to an instance already built.
//
// and optionally reacting to `instanceFetched(id)`, `instanceDiscarded(id)`
// and `graphCompleted(ids)`. Both are synchronous. A dataclass field in
// `state` holds instance ids - one, or a list or dict of them. The instances
// they name are complete when `applyState` runs; when `buildInstance` runs
// they may not have arrived yet, and are fetched right after it.

// Ids held by a dataclass field, whichever container holds them.
export function idsOf(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  return Object.values(value);
}

// A dataclass field's client value as the ids the server expects: whatever
// stands for an instance on the client carries its id as `_id`.
export function serializeDataClass(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  const idOf = (record) => record?._id ?? record;
  if (Array.isArray(value)) return value.map(idOf);
  if (value._id) return value._id;
  return Object.fromEntries(
    Object.entries(value).map(([key, record]) => [key, idOf(record)]),
  );
}

function encodeState(encoded, state) {
  for (const [key, value] of Object.entries(state || {})) {
    encoded[key] = JSON.stringify([value]);
  }
  return encoded;
}

function toSet(names) {
  return Object.fromEntries((names || []).map((name) => [name, 1]));
}

export class DataclassCore {
  constructor() {
    this.client = null;
    this.subscription = null;
    this.dataTypes = {}; // instance id -> class id
    this.typeDefinitions = {}; // class id -> definition, its field lists as sets
    // instance id -> field -> JSON of the value the server is known to hold, so
    // an edit the server already has is not sent back.
    this.serverState = {};
    this.references = {}; // instance id -> dataclass field -> instance ids
    this.revisions = {};
    this.pendingFetch = {};
    this.pendingDefinition = {};
    this.pendingPublications = {};
    this.completeInstances = new Set();
    this.pendingClientServerQueue = [];
    this.pendingFlushRequest = 0;
    // At most this many state and definition requests in flight: a graph of thousands
    // of instances queues behind it instead of flooding the server.
    this.maxConcurrentCalls = 16;
    this.activeCalls = 0;
    this.queuedCalls = [];
  }

  buildInstance() {
    throw new Error("DataclassCore subclasses must implement buildInstance");
  }

  applyState() {
    throw new Error("DataclassCore subclasses must implement applyState");
  }

  instanceFetched() {}

  instanceDiscarded() {}

  graphCompleted() {}

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
    // A delta only needs this instance's own state, not the instances it points at.
    const hydration = this.fetchInstance(id);
    const previous = this.pendingPublications[id] || Promise.resolve();
    const next = previous.then(async () => {
      if (!(await hydration)) return;
      const { state, revision } = event;
      // The snapshot, or an earlier delta, already holds this one. That includes the
      // publication that announced the instance and started its fetch.
      if (revision <= this.revisions[id]) return;

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
      encodeState(this.serverState[id], state);
      this.recordReferences(id, state);
      this.applyState(id, state);
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

  isDataClass(id, name) {
    return !!this.typeDefinitions[this.dataTypes[id]]?.dataclass_containers[
      name
    ];
  }

  isClientOnly(id, name) {
    return !!this.typeDefinitions[this.dataTypes[id]]?.client_only[name];
  }

  isDeepReactive(id, name) {
    return !!this.typeDefinitions[this.dataTypes[id]]?.deep_reactive[name];
  }

  // Ids of the instances a delta points at.
  referencedInstances(id, state) {
    return Object.entries(state)
      .filter(([key]) => this.isDataClass(id, key))
      .flatMap(([, value]) => idsOf(value));
  }

  recordReferences(id, state) {
    for (const [key, value] of Object.entries(state)) {
      if (this.isDataClass(id, key)) {
        this.references[id][key] = idsOf(value);
      }
    }
  }

  // Ids of the instances `id` points at now.
  childIds(id) {
    return Object.values(this.references[id] || {}).flat();
  }

  // A client edit. A dataclass field may hold the client's own records; they are
  // sent, and remembered as references, by id.
  updateServer(id, name, value) {
    if (this.isClientOnly(id, name)) return;
    if (this.isDataClass(id, name)) {
      value = serializeDataClass(value);
      (this.references[id] ||= {})[name] = idsOf(value);
    }
    this.pendingClientServerQueue.push([id, name, value]);
    this.flushToServer();
  }

  async flushToServer() {
    if (this.pendingFlushRequest) {
      return;
    }
    this.pendingFlushRequest++;
    // Edits queued while a request was in flight: the last value of each field
    // wins, and a field whose value the server already holds is not sent. Comparing
    // each edit in turn instead would drop X -> Y -> X as "X is already there"
    // while still sending Y.
    const msg = {};
    for (const [id, name, value] of this.pendingClientServerQueue.splice(0)) {
      (msg[id] ||= {})[name] = value;
    }
    let sendingSomething = 0;
    for (const [id, fields] of Object.entries(msg)) {
      const known = (this.serverState[id] ||= {});
      for (const [name, value] of Object.entries(fields)) {
        const encoded = JSON.stringify([value]);
        if (known[name] === encoded) {
          delete fields[name];
        } else {
          known[name] = encoded;
          sendingSomething++;
        }
      }
      if (!Object.keys(fields).length) delete msg[id];
    }
    if (sendingSomething) {
      try {
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

  // One instance: its state, its class definition and its client representation.
  // Resolves to whether the server knows it. The instances it points at are started,
  // never awaited, so this never waits on another instance and no cycle in the graph
  // can deadlock it.
  async fetchInstance(id) {
    if (this.pendingFetch[id]) {
      return await this.pendingFetch[id];
    }
    const pending = (async () => {
      const data = await this.callServer("trame.dataclass.state.get", [id]);
      if (data.state === null) {
        // Not cached: the instance may exist by the time someone asks again.
        delete this.pendingFetch[id];
        return false;
      }
      if (!this.typeDefinitions[data.definition]) {
        await this.fetchDefinition(data.definition);
      }

      this.dataTypes[id] = data.definition;
      this.serverState[id] = encodeState({}, data.state);
      this.references[id] = {};
      this.recordReferences(id, data.state);
      this.buildInstance(id, data.state);
      this.revisions[id] = data.revision;
      this.instanceFetched(id);

      // Whoever needs these complete waits with `fetchInstanceRecursive`, which
      // also surfaces a failure and retries it.
      for (const childId of this.childIds(id)) {
        this.fetchInstance(childId).catch(() => {});
      }
      return true;
    })().catch((error) => {
      // Forget the failed attempt, so the next request for this id starts over
      // instead of every later caller re-awaiting the same rejection.
      delete this.pendingFetch[id];
      delete this.dataTypes[id];
      delete this.serverState[id];
      delete this.references[id];
      this.instanceDiscarded(id);
      throw error;
    });
    this.pendingFetch[id] = pending;
    return await pending;
  }

  // `id` and every instance it reaches, one level of the graph at a time: each level
  // is fetched in parallel, and a cycle is only an instance already seen. A complete
  // instance stays complete, because a publication never commits a reference before
  // its target is complete, so it is not walked again. Resolves to whether the
  // server knows `id`.
  async fetchInstanceRecursive(id) {
    if (this.completeInstances.has(id)) {
      return true;
    }
    if (!(await this.fetchInstance(id))) {
      return false;
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
    // An id the server does not know is not an instance, complete or otherwise.
    const completed = [...seen].filter((seenId) => this.serverState[seenId]);
    completed.forEach((completedId) => this.completeInstances.add(completedId));
    this.graphCompleted(completed);
    return true;
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
      ...data,
      dataclass_containers: toSet(data.dataclass_containers),
      client_only: toSet(data.client_only),
      deep_reactive: toSet(data.deep_reactive),
    };
  }
}
