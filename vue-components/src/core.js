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
  }

  buildInstance(id, state) {
    const refs = { _id: id };
    this.dataStates[id] = { refs };

    for (const [key, value] of Object.entries(state)) {
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
    if (!id || !(await this.fetchInstance(id))) return "";
    const classId = this.dataTypes[id];
    const definition = this.typeDefinitions[classId];
    if (!("template" in definition)) {
      return `No GUI for dataclass ${classId}`;
    }
    return definition.template || "";
  }

  async link(dataId, componentId) {
    // A component only ever sees a complete graph, and one the server knows.
    const exists = await this.fetchInstanceRecursive(dataId);
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
