// Client-side counterpart to trame_dataclass's server-side StateDataModel.
//
// Fetching, publications and client edits are handled by DataclassCore,
// shared with the Vue client (vue-components/src/core.js); this file only
// decides how an instance is represented in React. Vue gives each field its
// own ref, so a template only re-renders the exact spot that reads it. React
// has nothing built in that fine-grained; useSyncExternalStore is the closest
// fit, and it works by comparing a per-instance "snapshot" reference across
// renders. So instead of per-field refs, every instance keeps ONE plain target
// object plus a version counter: reads go through a thin Proxy (rebuilt only
// when the version bumps, so useSyncExternalStore sees a new reference exactly
// when something actually changed), and writes through that Proxy intercept
// `set` to push the new value to the server. Updates that originate from the
// server bypass the Proxy entirely (setField), mutating the target directly,
// so they never reach `updateServer` to be sent back.

import { DataclassCore } from "../../client-core/src/index.js";

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

export class DataclassManager extends DataclassCore {
  constructor() {
    super();
    this.states = {}; // id -> InstanceState
  }

  ensureState(id) {
    if (!this.states[id]) this.states[id] = new InstanceState(id);
    return this.states[id];
  }

  buildInstance(id, state) {
    this.ensureState(id);
    this.applyState(id, state);
  }

  applyState(id, state) {
    for (const [key, value] of Object.entries(state)) {
      if (this.isDataClass(id, key)) {
        this.setField(id, key, this.recordsOf(value));
      } else if (this.isDeepReactive(id, key)) {
        this.setField(id, key, this.wrapDeepReactive(id, key, value));
      } else {
        this.setField(id, key, value);
      }
    }
  }

  // A dataclass field's ids as the records standing for those instances.
  recordsOf(value) {
    if (value === null) return null;
    if (typeof value === "string") return this.getRecordProxy(value);
    if (Array.isArray(value)) return value.map((id) => this.getRecordProxy(id));
    return Object.fromEntries(
      Object.entries(value).map(([k, id]) => [k, this.getRecordProxy(id)]),
    );
  }

  // A provider only shows an instance once its whole graph is there, so tell the
  // ones waiting on these.
  graphCompleted(ids) {
    ids.forEach((id) => this.states[id]?.notify());
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
    this.updateServer(id, key, value);
  }

  wrapDeepReactive(id, key, value) {
    const onChange = () => {
      const inst = this.states[id];
      if (!inst) return;
      inst.notify();
      this.updateServer(id, key, inst.target[key]);
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

  // Null until the instance and every instance it reaches have arrived, which is
  // what a provider's `{name}_available` reports.
  getSnapshot(id) {
    if (!id || !this.completeInstances.has(id)) return null;
    return this.getRecordProxy(id);
  }

  subscribe(id, callback) {
    if (!id) return () => {};
    const inst = this.ensureState(id);
    inst.listeners.add(callback);
    return () => inst.listeners.delete(callback);
  }
}

let singleton = null;

export function getManager() {
  if (!singleton) singleton = new DataclassManager();
  return singleton;
}
