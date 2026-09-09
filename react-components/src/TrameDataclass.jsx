import { useEffect, useSyncExternalStore } from "react";
import { getManager } from "./dataclassManager";

const manager = getManager();

// Registered under the "trame-dataclass" tag (see index.js), the react
// counterpart to vue-components/src/components/TrameDataclass.js. Unlike
// the Vue version - which projects a named scoped slot directly - this
// receives its content as an already-resolved `render` prop (a
// react.Slot(params=[name, f"{name}_available"]) render-prop function, see
// trame_dataclass/widgets/dataclass.py's Provider), because there is no
// runtime template compiler to turn Python-declared slot markup into a
// scoped Vue slot. `dataclass.Provider`'s own `with Provider(...):` syntax
// hides this difference from application authors.
export default function TrameDataclass({ instance, always, render }) {
  const trame = window.trame;

  useEffect(() => {
    if (trame?.client) manager.connect(trame.client);
  }, [trame]);

  useEffect(() => {
    if (!instance) return;
    if (trame?.client) manager.connect(trame.client);
    manager.ensureFetched(instance);
  }, [instance, trame]);

  const data = useSyncExternalStore(
    (onChange) => manager.subscribe(instance, onChange),
    () => manager.getSnapshot(instance),
  );

  const available = !!data;
  if (!render || (!available && !always)) return null;

  return render(data ?? {}, available);
}
