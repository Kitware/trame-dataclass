import { inject, ref, customRef, onMounted, onBeforeUnmount } from "vue";

function toRef(trame, name, triggers) {
  return customRef((track, trigger) => {
    triggers[name] = trigger;
    return {
      get() {
        track();
        return trame.state.get(name);
      },
      set(value) {
        trame.state.set(name, value);
        trigger();
      },
    };
  });
}

export function setup() {
  const trame = inject("trame");
  const tts = ref(0);
  const modifiedState = {};
  const publicAPI = { trame, window, utils: trame.utils, tts };

  // Dynamic state reactivity
  trame.state.getAllKeys().forEach((name) => {
    publicAPI[name] = toRef(trame, name, modifiedState);
  });

  // Server update reactivity
  const onDirty = ({ type, keys }) => {
    if (type === "new-keys") {
      for (let i = 0; i < keys.length; i++) {
        const name = keys[i];
        if (publicAPI[name] === undefined) {
          publicAPI[name] = toRef(trame, name, modifiedState);
        }
      }
    }

    if (type === "dirty-state") {
      for (let i = 0; i < keys.length; i++) {
        modifiedState[keys[i]]();
      }
    }
  };

  onMounted(() => {
    trame.state.addListener(onDirty);
  });

  onBeforeUnmount(() => {
    trame.state.removeListener(onDirty);
  });

  // Expose API
  publicAPI.trigger = (...args) => trame.trigger(...args);
  publicAPI.set = (name, value) => trame.state.set(name, value);
  publicAPI.get = (name) => publicAPI[name];
  publicAPI.setAll = (obj) => trame.state.update(obj);
  publicAPI.flushState = (...keys) => trame.state.flush(...keys);
  publicAPI.registerDecorator = (...args) =>
    trame.state.registerDecorator(...args);

  return publicAPI;
}
