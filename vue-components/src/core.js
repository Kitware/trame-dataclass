import { ref, reactive, watch } from "vue";

import { DataclassCore } from "../../client-core/src/index.js";

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

// The Vue client: an instance is a set of refs, one per field, each watched to
// push client edits to the server. Fetching, publications and edits themselves
// are handled by DataclassCore, shared with the React client.
export class DataclassManager extends DataclassCore {
  constructor() {
    super();
    this.dataStates = {};
    this.vueComponents = {};
    this.internalReactiveObjects = {};
    this.triggers = {};
    this.deepReactiveWatchers = {};
    this.pendingDeepReactives = {};
    // `${id}::${field}` -> the cell its outbound watcher is registered on, so a
    // second fetch of the same instance cannot double-send every edit.
    this.outboundWatchers = {};
  }

  buildInstance(id, state) {
    // A re-fetch -- a reconnect is the only one -- fills the SAME refs object and
    // the same ref cells. A component's `data` holds those cells, the trigger that
    // pushes its edits closes over the instance rather than over one of them, and a
    // parent's shared object was assigned them: replacing them orphans all three,
    // so the view would come back bound to cells nothing writes to any more.
    //
    // Refs are additive for the same reason: a field the newest state omits keeps
    // its cell rather than having its identity pulled from under a live binding.
    const refs = this.dataStates[id]?.refs ?? { _id: id };
    this.dataStates[id] = { refs };

    for (const [key, value] of Object.entries(state)) {
      // check if nested dataclass
      if (this.isDataClass(id, key)) {
        refs[key] ??= ref(null);
        this.handleNestedDataClass(id, key, value);
      } else if (refs[key]) {
        refs[key].value = this.wrapValue(id, key, value);
      } else {
        refs[key] = ref(this.wrapValue(id, key, value));
      }
      if (!this.isClientOnly(id, key)) {
        this.watchOutbound(id, key);

        const items = this.pendingDeepReactives[id] || [];
        while (items.length) {
          const [fullKey, r] = items.pop();
          this.deepReactiveWatchers[fullKey] = watch(
            r,
            this.getTrigger(id, key),
          );
        }
      }
    }
  }

  // Exactly one outbound watcher per field, on whichever cell that field currently
  // is. A cell normally survives every fetch, so this reads as "do not watch it
  // twice"; if one were ever replaced, the old watcher is released rather than left
  // firing into an abandoned object.
  watchOutbound(id, key) {
    const fullKey = `${id}::${key}`;
    const cell = this.dataStates[id].refs[key];
    const existing = this.outboundWatchers[fullKey];
    if (existing) {
      if (existing.cell === cell) return;
      existing.unwatch();
    }
    this.outboundWatchers[fullKey] = {
      cell,
      unwatch: watch(cell, this.getTrigger(id, key)),
    };
  }

  // Re-hydrate what is on screen. A Provider cannot notice a reconnect itself --
  // its `instance` prop never changed -- and everything the core cached for the
  // retired connection is gone, so a mounted component would otherwise sit on a
  // graph nothing is refreshing. Anything NOT mounted is fetched again by whoever
  // next asks for it.
  connectionReplaced() {
    for (const [componentId, internals] of Object.entries(this.vueComponents)) {
      if (!internals?.id) continue;
      // `link` resolves whatever happens, and reports what is worth reporting.
      this.link(internals.id, componentId);
    }
  }

  // Fill the shared reactive object of an instance that is already referenced.
  instanceFetched(id) {
    if (this.internalReactiveObjects[id]) {
      Object.assign(this.internalReactiveObjects[id], this.dataStates[id].refs);
    }
  }

  instanceDiscarded(id) {
    delete this.dataStates[id];
  }

  applyState(id, state) {
    for (const [key, value] of Object.entries(state)) {
      if (this.isDataClass(id, key)) {
        this.handleNestedDataClass(id, key, value);
      } else {
        this.dataStates[id].refs[key].value = this.wrapValue(id, key, value);
      }
    }
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

  // The shared reactive object standing for `objId` wherever it is referenced,
  // filled once the instance has been fetched.
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

  // Reads the LIVE cell and closes over nothing but the instance: a trigger
  // outlives any one fetch, and one bound to an abandoned fetch's refs would send
  // that fetch's value -- which the server cache then matches, so the user's edit
  // disappears with no request and no error.
  getTrigger(id, key) {
    const fullKey = `${id}::${key}`;
    const fn = this.triggers[fullKey];
    if (fn) {
      return fn;
    }
    this.triggers[fullKey] = () => {
      this.updateServer(id, key, this.dataStates[id].refs[key].value);
    };
    return this.triggers[fullKey];
  }

  async getGUITemplate(id) {
    if (!id) return "";
    // Its caller is a `watchEffect` that assigns the result, so this resolves to a
    // template or to nothing -- the same reasoning as `link`. The template comes
    // back when the replacement's own fetch lands and the effect runs again.
    let known;
    try {
      known = await this.fetchInstance(id);
    } catch (error) {
      if (!error?.retiredSession) {
        console.error(`Dataclass template failed for ${id}`, error);
      }
      return "";
    }
    if (!known) return "";
    const classId = this.dataTypes[id];
    const definition = this.typeDefinitions[classId];
    if (!("template" in definition)) {
      return `No GUI for dataclass ${classId}`;
    }
    return definition.template || "";
  }

  async link(dataId, componentId) {
    // A component only ever sees a complete graph, and one the server knows.
    //
    // This RESOLVES whatever happens, because of who calls it: a component watcher
    // that does not await it and a replaced connection that re-links every mounted
    // component. A rejection reaching either one is an unhandled rejection in the
    // page with no instance id in it. A retired session is not even a failure --
    // `connectionReplaced` has already scheduled this very component's re-link on
    // the live connection, so it is the quiet case.
    let exists;
    try {
      exists = await this.fetchInstanceRecursive(dataId);
    } catch (error) {
      if (!error?.retiredSession) {
        console.error(`Dataclass hydration failed for ${dataId}`, error);
      }
      return;
    }
    // It may have moved on to another instance while this one arrived.
    if (!exists || this.vueComponents[componentId]?.id !== dataId) {
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
