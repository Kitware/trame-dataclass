// The React layer over DataclassCore: records, snapshots and client edits.
// Fetching and publication ordering are covered by client-core's own tests.
import assert from "node:assert/strict";
import test from "node:test";

import {
  connect,
  deferred,
  definition,
  state,
  tick,
} from "../../client-core/tests/harness.js";
import { DataclassManager } from "../src/dataclassManager.js";

function fixture(states, definitions) {
  const f = connect(new DataclassManager(), states, definitions);
  return { ...f, value: (id, key) => f.manager.states[id].target[key] };
}

test("a snapshot is null until the whole graph has arrived", async () => {
  const gate = deferred(),
    f = fixture(
      {
        parent: state({ child: "child" }, "Parent"),
        child: state({ count: 42 }, "Child"),
      },
      { Parent: definition(["child"]), Child: gate },
    );
  let notified = 0;
  f.manager.subscribe("parent", () => notified++);
  const hydration = f.manager.fetchInstanceRecursive("parent");
  await tick();
  assert.equal(f.manager.getSnapshot("parent"), null);
  gate.resolve(definition());
  await hydration;
  assert.ok(notified > 0);
  const parent = f.manager.getSnapshot("parent");
  assert.equal(parent._id, "parent");
  assert.equal(parent.child.count, 42);
});

test("a cycle in the graph completes", async () => {
  const f = fixture(
    {
      a: state({ peer: "b" }, "Node"),
      b: state({ peer: "a" }, "Node"),
    },
    { Node: definition(["peer"]) },
  );
  await f.manager.fetchInstanceRecursive("a");
  assert.equal(f.manager.getSnapshot("a").peer.peer._id, "a");
});

test("a delta arriving during the first fetch is not rolled back", async () => {
  const gate = deferred(),
    f = fixture({ layer: state({ value: "old" }, "Layer", 0, gate) });
  const hydration = f.manager.fetchInstanceRecursive("layer");
  const update = f.publish("layer", { value: "new" }, 1);
  await tick();
  gate.resolve();
  await Promise.all([hydration, update]);
  assert.equal(f.value("layer", "value"), "new");
});

test("a reference arriving before its class definition becomes a record", async () => {
  const gate = deferred(),
    f = fixture(
      {
        parent: state({ child: null }, "Parent"),
        child: state({ v: 1 }, "Child"),
      },
      { Parent: gate, Child: definition() },
    );
  const hydration = f.manager.fetchInstanceRecursive("parent");
  await tick();
  const update = f.publish("parent", { child: "child" }, 1);
  await tick();
  gate.resolve(definition(["child"]));
  await Promise.all([hydration, update]);
  assert.equal(f.value("parent", "child").v, 1);
});

for (const [shape, reference, read] of [
  ["list", ["child"], (value) => value[0]],
  ["dict", { only: "child" }, (value) => value.only],
]) {
  test(`a ${shape} reference holds the instance's record`, async () => {
    const f = fixture(
      {
        parent: state({ child: reference }, "Parent"),
        child: state({ count: 42 }, "Child"),
      },
      { Parent: definition(["child"]), Child: definition() },
    );
    await f.manager.fetchInstanceRecursive("parent");
    assert.equal(read(f.manager.getSnapshot("parent").child).count, 42);
  });
}

test("an edit through a record is pushed, and one that changes nothing is not", async () => {
  const f = fixture({ layer: state({ value: 1 }) });
  await f.manager.fetchInstanceRecursive("layer");
  const record = f.manager.getSnapshot("layer");
  record.value = 1;
  await tick();
  assert.deepEqual(f.updates(), []);
  record.value = 2;
  await tick();
  assert.deepEqual(f.updates(), [{ layer: { value: 2 } }]);
  assert.equal(f.manager.getSnapshot("layer").value, 2);
});

test("an edit inside a deep reactive field pushes the whole field", async () => {
  const f = fixture(
    { layer: state({ items: [1, 2] }) },
    { Layer: definition([], { deep_reactive: ["items"] }) },
  );
  await f.manager.fetchInstanceRecursive("layer");
  f.manager.getSnapshot("layer").items[0] = 5;
  await tick();
  assert.deepEqual(f.updates(), [{ layer: { items: [5, 2] } }]);
});
