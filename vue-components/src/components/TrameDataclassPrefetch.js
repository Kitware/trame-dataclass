import { inject, watch, onBeforeUnmount } from "vue";

import { GLOBAL_DATA_MANAGER } from "./TrameDataclass";

/**
 * Start a whole wave of instances hydrating, without gating anything on the result.
 *
 * Providers nest, and a provider's slot waits for its own instance, so provider N+1
 * is not created until provider N's state has landed: N of them pay N round trips END
 * TO END. This component asks the manager for all of them at once, so each provider
 * finds its own hydration already in flight.
 *
 * **It renders its slot immediately and always.** Opening the slot only once every id
 * is ready would also suppress partial renders -- but each provider already does that
 * for itself, and a page-wide gate would buy that for the price of a new way for the
 * page to stay blank. Warming is strictly additive: if this component did nothing at
 * all, every provider would fetch exactly as it does without it.
 */
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
    // A generation token, not a flag: an unmount or a replaced list must not let a
    // retired wave's failures be reported against the live page.
    let generation = 0;
    watch(
      () => props.instances,
      (instances) => {
        const mine = ++generation;
        if (!Array.isArray(instances)) {
          // The way this prop goes wrong is that it arrives `undefined` from a binding
          // that rendered as a bare identifier, and a silent no-op is indistinguishable
          // from a working prefetch.
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
              "Dataclass prefetch could not hydrate",
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
