import { inject, reactive, watchEffect, onBeforeUnmount } from "vue";

import { DataclassManager } from "../core";

const GLOBAL_DATA_MANAGER = new DataclassManager();
let GLOBAL_VUE_INSTANCE_ID = 1;

export default {
  props: ["instance"],
  setup(props) {
    const trame = inject("trame");
    const data = reactive({});
    const guards = { serverPush: false };
    const vueInstanceId = `vueDataClass${GLOBAL_VUE_INSTANCE_ID++}`;

    GLOBAL_DATA_MANAGER.connect(trame.client);
    watchEffect(() => {
      GLOBAL_DATA_MANAGER.connectVueComponent(vueInstanceId, {
        id: props.instance,
        data,
        guards,
      });
    });
    onBeforeUnmount(() => {
      GLOBAL_DATA_MANAGER.disconnectVueComponent(vueInstanceId);
    });

    return { data };
  },
  template: '<slot :dataclass="data"></slot>',
};
