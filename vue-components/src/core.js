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

        Object.assign(this.dataStates[id].server, state);
        for (const [key, value] of Object.entries(state)) {
          if (this.isDataClass(id, key)) {
            await this.handleNestedDataClass(id, key, value);
          } else {
            this.dataStates[id].refs[key].value = value;
          }
        }
      });
  }

  updateServer(id, name, value) {
    this.pendingClientServerQueue.push([id, name, value]);
    this.flushToServer();
  }

  async flushToServer() {
    if (this.pendingFlushRequest) {
      return;
    }
    this.pendingFlushRequest++;
    const msg = {};
    let sendingSomething = 0;
    while (this.pendingClientServerQueue.length) {
      const [id, name, value] = this.pendingClientServerQueue.shift();
      let valueToSend = value;

      // Handle nested dataclass
      if (value !== null && this.isDataClass(id, name)) {
        if (Array.isArray(value)) {
          // array[id...]
          valueToSend = value.map((v) => v._id);
        } else {
          // dict[str, id] or direct dataclass
          if (value._id) {
            // => direct dataclass
            valueToSend = value._id;
          } else {
            // => dict[str,id]
            valueToSend = {};
            for (const [k, v] in Object.entries(value)) {
              valueToSend[k] = v._id;
            }
          }
        }
      }
      if (
        JSON.stringify(this.dataStates[id].server[name]) ===
        JSON.stringify(valueToSend)
      ) {
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
    return this.typeDefinitions[
      this.dataTypes[id]
    ].dataclass_containers.includes(name);
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
      const newArray = [];
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
        this.dataStates[id].refs[key] = ref(newArray);
      } else {
        this.dataStates[id].refs[key].value = newArray;
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
    } else {
      // dict structure
      const newStruct = reactive({});

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

  async fetchState(id) {
    const refs = { _id: id };
    const data = await this.client
      .getConnection()
      .getSession()
      .call("trame.dataclass.state.get", [id]);

    this.dataTypes[id] = data.definition;
    this.dataStates[id] = { refs, server: data.state };

    if (!this.typeDefinitions[data.definition]) {
      await this.fetchDefinition(data.definition);
    }

    for (const [key, value] of Object.entries(data.state)) {
      // check if nested dataclass
      if (this.isDataClass(id, key)) {
        refs[key] = ref(null);
        await this.handleNestedDataClass(id, key, value);
      } else {
        refs[key] = ref(value);
      }
      watch(
        () => refs[key].value,
        (v) => this.updateServer(id, key, v),
      );
    }

    if (this.dataToVue[id]) {
      this.dataToVue[id].forEach((componentId) => {
        updateWidget(id, this.dataStates[id], this.vueComponents[componentId]);
      });
    }
    if (this.internalReactiveObjects[id]) {
      Object.assign(this.internalReactiveObjects[id], this.dataStates[id].refs);
    }
    return this.dataStates[id];
  }

  async fetchDefinition(id) {
    const data = await this.client
      .getConnection()
      .getSession()
      .call("trame.dataclass.definition.get", [id]);

    this.typeDefinitions[id] = data;
  }

  unlink(dataId, componentId) {
    if (this.dataToVue[dataId]) {
      this.dataToVue[dataId] = this.dataToVue[dataId].filter(
        (v) => v !== componentId,
      );
    }
  }

  link(dataId, componentId) {
    if (!this.dataToVue[dataId]) {
      this.dataToVue[dataId] = [componentId];
    } else {
      this.dataToVue[dataId].push(componentId);
    }

    // Put initial state
    if (!this.dataStates[dataId]) {
      this.fetchState(dataId);
    } else {
      updateWidget(
        dataId,
        this.dataStates[dataId],
        this.vueComponents[componentId],
      );
    }
  }

  connectVueComponent(componentId, internals) {
    const prevDataId = this.vueComponents[componentId]?.id;
    const newDataId = internals.id;
    this.unlink(prevDataId, componentId);
    this.vueComponents[componentId] = internals;
    this.link(newDataId, componentId);
  }

  disconnectVueComponent(componentId) {
    const dataId = this.vueComponents[componentId]?.id;
    delete this.vueComponents[componentId];
    this.unlink(dataId, componentId);
  }
}
