// Client-side counterpart to trame_dataclass's server-side StateDataModel.
//
// Talks to the exact same wslink RPC/pubsub surface the Vue implementation
// uses (trame.dataclass.state.get/update, trame.dataclass.definition.get,
// trame.dataclass.publish) - see vue-components/src/core.js for the sibling
// port - but the reactivity primitive differs: Vue gives each field its own
// customRef, so a template only re-renders the exact spot that reads it.
// React has nothing built in that fine-grained; useSyncExternalStore is the
// closest fit, and it works by comparing a per-instance "snapshot" reference
// across renders. So instead of per-field refs, every instance keeps ONE
// plain target object plus a version counter: reads go through a thin Proxy
// (rebuilt only when the version bumps, so useSyncExternalStore sees a new
// reference exactly when something actually changed), and writes through
// that Proxy intercept `set` to push the new value to the server. Updates
// that originate from the server bypass the Proxy entirely (setField),
// mutating the target directly - so, unlike the Vue port, there is no need
// for a server-echo dedup cache to avoid re-sending back what the server
// just sent: origin (user vs. server) is tracked explicitly instead.

function deepReactive(value, onChange) {
  if (value === null || typeof value !== "object") return value;

  const target = Array.isArray(value)
    ? value.map((v) => deepReactive(v, onChange))
    : Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, deepReactive(v, onChange)]),
      );

  return new Proxy(target, {
    set(t, prop, val) {
      t[prop] = deepReactive(val, onChange);
      onChange();
      return true;
    },
    deleteProperty(t, prop) {
      delete t[prop];
      onChange();
      return true;
    },
  });
}

class InstanceState {
  constructor(id) {
    this.id = id;
    this.target = { _id: id };
    this.version = 0;
    this.snapshot = null;
    this.snapshotVersion = -1;
    this.listeners = new Set();
  }

  notify() {
    this.version += 1;
    this.listeners.forEach((cb) => cb());
  }
}

export class DataclassManager {
  constructor() {
    this.client = null;
    this.states = {}; // id -> InstanceState
    this.dataTypes = {}; // id -> definition id
    this.typeDefinitions = {}; // definition id -> { dataclass_containers, client_only, deep_reactive }
    this.fetched = new Set();
    this.pendingFetch = {};
    this.pendingClientServerQueue = [];
    this.pendingFlushRequest = 0;
  }

  connect(client) {
    if (this.client || !client) return;
    this.client = client;

    client
      .getConnection()
      .getSession()
      .subscribe("trame.dataclass.publish", async ([event]) => {
        const { id, state } = event;
        if (!this.fetched.has(id) && !this.pendingFetch[id]) {
          await this.fetchState(id);
          return;
        }
        await this._applyState(id, state);
      });
  }

  ensureState(id) {
    if (!this.states[id]) this.states[id] = new InstanceState(id);
    return this.states[id];
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

  // Server-origin update: no push back to the server, just record the value
  // and notify subscribers.
  setField(id, key, value) {
    const inst = this.ensureState(id);
    inst.target[key] = value;
    inst.notify();
  }

  // Client-origin update (a Callback expression mutating the record Proxy
  // returned by getRecordProxy, e.g. `active_user.name = $event...`):
  // records the value, notifies subscribers, and pushes to the server
  // unless the field is CLIENT_ONLY.
  userSetField(id, key, value) {
    const inst = this.ensureState(id);
    inst.target[key] = value;
    inst.notify();
    if (!this.isClientOnly(id, key)) {
      this.updateServer(id, key, value);
    }
  }

  wrapDeepReactive(id, key, value) {
    const onChange = () => {
      const inst = this.states[id];
      if (!inst) return;
      inst.notify();
      if (!this.isClientOnly(id, key)) {
        this.updateServer(id, key, inst.target[key]);
      }
    };
    return deepReactive(value, onChange);
  }

  // A stable-until-changed view of an instance's fields: reads pass through,
  // writes route through userSetField(). Rebuilt only when the instance's
  // version changes, so useSyncExternalStore's snapshot comparison sees a
  // new reference exactly when (and only when) something changed.
  getRecordProxy(id) {
    const inst = this.ensureState(id);
    if (inst.snapshotVersion !== inst.version) {
      inst.snapshot = new Proxy(inst.target, {
        set: (target, prop, value) => {
          if (typeof prop !== "string" || prop.startsWith("_")) {
            target[prop] = value;
            return true;
          }
          if (target[prop] === value) return true;
          this.userSetField(id, prop, value);
          return true;
        },
        deleteProperty: (target, prop) => {
          delete target[prop];
          return true;
        },
      });
      inst.snapshotVersion = inst.version;
    }
    return inst.snapshot;
  }

  getSnapshot(id) {
    if (!id) return null;
    return this.getRecordProxy(id);
  }

  subscribe(id, callback) {
    if (!id) return () => {};
    const inst = this.ensureState(id);
    inst.listeners.add(callback);
    return () => inst.listeners.delete(callback);
  }

  ensureFetched(id) {
    if (!id || this.fetched.has(id) || this.pendingFetch[id]) return;
    this.fetchState(id);
  }

  async _applyState(id, state) {
    for (const [key, value] of Object.entries(state)) {
      if (this.isDataClass(id, key)) {
        await this._setNestedField(id, key, value);
      } else if (this.isDeepReactive(id, key)) {
        this.setField(id, key, this.wrapDeepReactive(id, key, value));
      } else {
        this.setField(id, key, value);
      }
    }
  }

  async _setNestedField(id, key, value) {
    if (value === null) {
      this.setField(id, key, null);
      return;
    }
    if (Array.isArray(value)) {
      const items = [];
      for (const objId of value) {
        items.push(this.getRecordProxy(objId));
        this.ensureFetched(objId);
        if (this.pendingFetch[objId]) await this.pendingFetch[objId];
      }
      this.setField(id, key, items);
      return;
    }
    if (typeof value === "string") {
      this.ensureFetched(value);
      if (this.pendingFetch[value]) await this.pendingFetch[value];
      this.setField(id, key, this.getRecordProxy(value));
      return;
    }
    // dict[str, id]
    const result = {};
    for (const [k, objId] of Object.entries(value)) {
      result[k] = this.getRecordProxy(objId);
      this.ensureFetched(objId);
      if (this.pendingFetch[objId]) await this.pendingFetch[objId];
    }
    this.setField(id, key, result);
  }

  updateServer(id, name, value) {
    const valueToSend = this.isDataClass(id, name)
      ? this._serializeDataClassValue(value)
      : value;
    this.pendingClientServerQueue.push([id, name, valueToSend]);
    this.flushToServer();
  }

  _serializeDataClassValue(value) {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.map((v) => v?._id ?? v);
    if (typeof value === "string") return value; // already an id
    if (value._id) return value._id;
    const result = {};
    for (const [k, v] of Object.entries(value)) result[k] = v?._id ?? v;
    return result;
  }

  async flushToServer() {
    if (this.pendingFlushRequest) return;
    this.pendingFlushRequest++;

    const msg = {};
    let sendingSomething = 0;
    while (this.pendingClientServerQueue.length) {
      const [id, name, value] = this.pendingClientServerQueue.shift();
      if (!msg[id]) msg[id] = {};
      msg[id][name] = value;
      sendingSomething++;
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

  async fetchState(id) {
    if (this.pendingFetch[id]) return this.pendingFetch[id];

    this.pendingFetch[id] = (async () => {
      const data = await this.client
        .getConnection()
        .getSession()
        .call("trame.dataclass.state.get", [id]);

      if (data.state === null) {
        delete this.pendingFetch[id];
        return null;
      }

      this.dataTypes[id] = data.definition;
      const inst = this.ensureState(id);

      if (!this.typeDefinitions[data.definition]) {
        await this.fetchDefinition(data.definition);
      }

      await this._applyState(id, data.state);

      this.fetched.add(id);
      delete this.pendingFetch[id];
      return inst;
    })();

    return this.pendingFetch[id];
  }

  async fetchDefinition(definitionId) {
    const data = await this.client
      .getConnection()
      .getSession()
      .call("trame.dataclass.definition.get", [definitionId]);

    const toSet = (arr) => Object.fromEntries((arr || []).map((k) => [k, 1]));

    this.typeDefinitions[definitionId] = {
      ...data,
      dataclass_containers: toSet(data.dataclass_containers),
      client_only: toSet(data.client_only),
      deep_reactive: toSet(data.deep_reactive),
    };
  }
}

let singleton = null;

export function getManager() {
  if (!singleton) singleton = new DataclassManager();
  return singleton;
}
