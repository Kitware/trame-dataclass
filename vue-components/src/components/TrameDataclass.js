import { inject, toRef, reactive, onBeforeUnmount, computed, watch } from "vue";

import { DataclassManager } from "../core";

export const GLOBAL_DATA_MANAGER = new DataclassManager();
let GLOBAL_VUE_INSTANCE_ID = 1;

export default {
  props: {
    instance: String,
    always: Boolean,
  },
  setup(props) {
    const always = toRef(props, "always");
    const trame = inject("trame");
    const data = reactive({});
    const available = computed(() => !!data._id);
    const guards = { serverPush: false };
    const vueInstanceId = `vueDataClass${GLOBAL_VUE_INSTANCE_ID++}`;

    GLOBAL_DATA_MANAGER.connect(trame.client);
    watch(
      () => props.instance,
      async (instanceId) => {
        available.value = false;
        const keys = Object.keys(data);
        while (keys.length) {
          delete data[keys.pop()];
        }
        if (!props.instance) {
          GLOBAL_DATA_MANAGER.disconnectVueComponent(vueInstanceId);
        } else {
          await GLOBAL_DATA_MANAGER.connectVueComponent(vueInstanceId, {
            id: `${instanceId}`,
            data,
            guards,
          });
          available.value = true;
        }
      },
      { immediate: true },
    );
    onBeforeUnmount(() => {
      GLOBAL_DATA_MANAGER.disconnectVueComponent(vueInstanceId);
    });

    return { data, available, always };
  },
  template:
    '<slot  v-if="available || always" :dataclass="data" :dataclassAvailable="available"></slot>',
};
