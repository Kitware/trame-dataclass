import { inject, ref, reactive, watchEffect, onBeforeUnmount } from "vue";

import { DataclassManager } from "../core";

const GLOBAL_DATA_MANAGER = new DataclassManager();
let GLOBAL_VUE_INSTANCE_ID = 1;

export default {
  props: ["instance"],
  setup(props) {
    const trame = inject("trame");
    const available = ref(false);
    const data = reactive({});
    const guards = { serverPush: false };
    const vueInstanceId = `vueDataClass${GLOBAL_VUE_INSTANCE_ID++}`;

    GLOBAL_DATA_MANAGER.connect(trame.client);
    watchEffect(() => {
      if (!props.instance) {
        available.value = false;
        GLOBAL_DATA_MANAGER.disconnectVueComponent(vueInstanceId);
        const keys = Object.keys(data);
        while (keys.length) {
          delete data[keys.pop()];
        }
      } else {
        available.value = true;
        GLOBAL_DATA_MANAGER.connectVueComponent(vueInstanceId, {
          id: props.instance,
          data,
          guards,
        });
      }
    });
    onBeforeUnmount(() => {
      GLOBAL_DATA_MANAGER.disconnectVueComponent(vueInstanceId);
    });

    return { data, available };
  },
  template: '<slot :dataclass="data" :dataclassAvailable="available" ></slot>',
};
