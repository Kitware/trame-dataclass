import { inject, watch, onBeforeUnmount } from "vue";

import { GLOBAL_DATA_MANAGER } from "./TrameDataclass";

// Start loading a list of instances at once, and render the slot immediately.
//
// A provider only mounts its slot once its own instance is available, so providers
// nested inside each other load one after another. Wrapping them in this component
// asks the manager for every id up front, so each provider finds its instance
// already loading. It is not a barrier: the slot always renders, and each provider
// still waits for its own data. Removing it changes timing only.
export default {
  props: {
    instances: {
      type: Array,
      default: () => [],
    },
  },
  setup(props) {
    const trame = inject("trame");
    GLOBAL_DATA_MANAGER.connect(trame.client);
    // A later list, or an unmount, must not report an older wave's failures.
    let generation = 0;
    watch(
      () => props.instances,
      (instances) => {
        const mine = ++generation;
        if (!Array.isArray(instances)) {
          console.warn(
            "TrameDataclassPrefetch: `instances` must be an array, got",
            instances,
          );
          return;
        }
        const ids = instances.map(String).filter(Boolean);
        if (!ids.length) return;
        GLOBAL_DATA_MANAGER.prefetch(ids).then((results) => {
          if (mine !== generation) return;
          const failed = results.filter((result) => !result.ready);
          if (failed.length) {
            console.warn(
              "Dataclass prefetch could not load",
              failed.map((result) => result.id),
            );
          }
        });
      },
      { immediate: true },
    );
    onBeforeUnmount(() => {
      generation++;
    });
    return {};
  },
  template: "<slot></slot>",
};
