// What a reconnect has to leave working on the Vue side: a mounted provider is
// re-hydrated without being told (its `instance` prop never changed), and it is
// re-hydrated onto the SAME ref cells -- a component's `data`, a parent's shared
// object and the trigger that pushes an edit all hold those cells, so building
// new ones would leave the view bound to cells nothing writes to any more.
import assert from "node:assert/strict";
import test from "node:test";
import { nextTick, reactive } from "vue";

import {
  connect,
  deferred,
  definition,
  serverFailure,
  state,
  tick,
} from "../../client-core/tests/harness.js";
import { DataclassManager } from "../src/core.js";

function fixture(states, definitions) {
  const f = connect(new DataclassManager(), states, definitions);
  return {
    ...f,
    value: (id, key) => f.manager.dataStates[id].refs[key].value,
  };
}

async function provider(f, id) {
  const data = reactive({});
  await f.manager.connectVueComponent("provider", { id, data, guards: {} });
  return data;
}

test("a mounted provider is re-hydrated on the same cells after a reconnect", async () => {
  const f = fixture({ layer: state({ value: 1 }) });
  const data = await provider(f, "layer");
  const cell = f.manager.dataStates.layer.refs.value;
  // `data` is reactive, so reading a field unwraps its ref: identity is compared
  // on the cells themselves.
  assert.equal(data.value, 1);

  cell.value = 2;
  await nextTick();
  await tick();
  f.reconnect();
  await tick();
  await tick();

  assert.equal(f.manager.dataStates.layer.refs.value, cell);
  assert.equal(data.value, 1);
  assert.equal(f.value("layer", "value"), 1);
  assert.deepEqual(f.session().calls[0], [
    "trame.dataclass.state.get",
    ["layer"],
  ]);
});

test("an edit made after a reconnect reaches the new connection once", async () => {
  const f = fixture({ layer: state({ value: 1 }) });
  const data = await provider(f, "layer");
  const retired = f.session();

  f.reconnect();
  await tick();
  await tick();
  data.value = 3;
  await nextTick();
  await tick();

  assert.deepEqual(f.updates(f.session()), [{ layer: { value: 3 } }]);
  assert.deepEqual(f.updates(retired), []);
});

test("a publication that arrives after a reconnect reaches the provider", async () => {
  const f = fixture({ layer: state({ value: 1 }) });
  const data = await provider(f, "layer");

  f.reconnect();
  await tick();
  await tick();
  await f.publish("layer", { value: 9 }, 1);

  assert.equal(data.value, 9);
});

test("a re-hydrated parent keeps the shared object its child is seen through", async () => {
  const f = fixture(
    {
      parent: state({ child: "child" }, "Parent"),
      child: state({ count: 42 }, "Child"),
    },
    { Parent: definition(["child"]), Child: definition() },
  );
  const data = await provider(f, "parent");
  const shared = f.manager.internalReactiveObjects.child;
  assert.equal(data.child, shared);

  f.reconnect();
  await tick();
  await tick();
  await tick();

  assert.equal(f.manager.internalReactiveObjects.child, shared);
  assert.equal(data.child, shared);
  assert.equal(shared.count, 42);
});

test("a refused edit is reverted in the cell the user is looking at, silently", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = fixture({ layer: state({ visible: false }) });
  const data = await provider(f, "layer");
  const session = f.session();
  const raw = session.call.bind(session);
  session.call = async (name, args) => {
    if (name === "trame.dataclass.state.update") {
      session.calls.push([name, args]);
      await Promise.resolve();
      throw serverFailure();
    }
    return raw(name, args);
  };

  data.visible = true;
  await nextTick();
  await tick();
  await tick();
  await nextTick();
  await tick();

  // The control goes back to what the server holds...
  assert.equal(data.visible, false);
  assert.equal(f.value("layer", "visible"), false);
  // ...and that write does not bounce out as a new edit. The outbound watcher it
  // wakes finds the restored cache already holding that value, so its echo is
  // dropped: one request, the refused one. MUTATION SEEN RED (and it is not a quiet
  // one): skip the cache restore and this file RUNS AWAY -- echo, refusal, revert,
  // echo -- until the 20 s case timeout stops it.
  assert.deepEqual(f.updates(session), [{ layer: { visible: true } }]);
  assert.deepEqual(f.manager.pendingClientServerQueue, []);
});
