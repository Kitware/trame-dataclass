import { ref, watchEffect, computed, inject } from "vue";
import { GLOBAL_DATA_MANAGER } from "./TrameDataclass";
import { setup } from "../setup";

export default {
  props: ["instance"],
  setup(props) {
    const innerTemplate = ref("");
    const trame = inject("trame");
    GLOBAL_DATA_MANAGER.connect(trame.client);

    watchEffect(async () => {
      innerTemplate.value = "";
      if (!props.instance) {
        return;
      }
      innerTemplate.value = await GLOBAL_DATA_MANAGER.getGUITemplate(
        `${props.instance}`,
      );
    });

    const DataClassGUI = computed(() => {
      const templateValue = innerTemplate.value;
      if (props.instance) {
        return {
          setup,
          template: `
            <trame-dataclass instance="${props.instance}" v-slot="{ dataclass: self, dataclassAvailable: self_available }">
              ${templateValue}
            </trame-dataclass>
          `,
        };
      }
      return { template: "" };
    });

    return { DataClassGUI };
  },
  template: '<component :is="DataClassGUI" />',
};
