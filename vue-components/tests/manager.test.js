// The Vue layer over DataclassCore: refs, shared reactive objects, components
// and GUI templates. Fetching and publication ordering are covered by
// client-core's own tests.
import assert from "node:assert/strict";
import test from "node:test";
import { nextTick, reactive } from "vue";

import {
  connect,
  deferred,
  definition,
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

for (const [shape, reference, read] of [
  ["field", "child", (value) => value],
  ["list", ["child"], (value) => value[0]],
  ["dict", { only: "child" }, (value) => value.only],
]) {
  test(`a ${shape} reference resolves to the instance's shared reactive object`, async () => {
    const f = fixture(
      {
        parent: state({ child: null }, "Parent"),
        child: state({ count: 42 }, "Child"),
      },
      { Parent: definition(["child"]), Child: definition() },
    );
    await f.manager.fetchInstanceRecursive("parent");
    await f.publish("parent", { child: reference }, 1);
    const child = read(f.value("parent", "child"));
    assert.equal(child, f.manager.internalReactiveObjects.child);
    assert.equal(child._id, "child");
    assert.equal(child.count, 42);
  });
}

test("a shared reactive object is filled when its instance arrives", async () => {
  const gate = deferred(),
    f = fixture(
      {
        parent: state({ child: "child" }, "Parent"),
        child: state({ count: 42 }, "Child"),
      },
      { Parent: definition(["child"]), Child: gate },
    );
  const hydration = f.manager.fetchInstanceRecursive("parent");
  await tick();
  const child = f.value("parent", "child");
  assert.deepEqual({ ...child }, { _id: "child" });
  gate.resolve(definition());
  await hydration;
  assert.equal(child.count, 42);
});

test("a component is not linked until the graph it shows is complete", async () => {
  const gate = deferred(),
    f = fixture(
      {
        parent: state({ child: "child" }, "Parent"),
        child: state({ count: 42 }, "Child"),
      },
      { Parent: definition(["child"]), Child: gate },
    );
  // Something else started the fetch: a publication, a parent, another provider.
  f.manager.fetchInstance("parent");
  await tick();
  const data = reactive({});
  const link = f.manager.connectVueComponent("provider", {
    id: "parent",
    data,
    guards: {},
  });
  await tick();
  assert.equal(data._id, undefined);
  gate.resolve(definition());
  await link;
  assert.equal(data._id, "parent");
  assert.equal(data.child.count, 42);
});

test("a component that moved on is not linked to the instance it left", async () => {
  const gate = deferred(),
    f = fixture(
      {
        slow: state({ value: "slow" }, "Slow"),
        fast: state({ value: "fast" }),
      },
      { Slow: gate, Layer: definition() },
    );
  const data = reactive({});
  const slow = f.manager.connectVueComponent("provider", {
    id: "slow",
    data,
    guards: {},
  });
  await tick();
  await f.manager.connectVueComponent("provider", {
    id: "fast",
    data,
    guards: {},
  });
  gate.resolve(definition());
  await slow;
  assert.equal(data._id, "fast");
  assert.equal(data.value, "fast");
});

test("a component is not linked to an instance the server does not know", async () => {
  const f = fixture({});
  const data = reactive({});
  await f.manager.connectVueComponent("provider", {
    id: "gone",
    data,
    guards: {},
  });
  assert.equal(data._id, undefined);
});

test("a GUI template waits for the class definition", async () => {
  const gate = deferred(),
    f = fixture({ layer: state({ value: 0 }) }, { Layer: gate });
  f.manager.fetchInstance("layer");
  await tick();
  const template = f.manager.getGUITemplate("layer");
  gate.resolve(definition([], { template: "<b>layer</b>" }));
  assert.equal(await template, "<b>layer</b>");
});

test("a class without a template gets a placeholder GUI", async () => {
  const f = fixture({ layer: state({ value: 0 }) });
  assert.equal(
    await f.manager.getGUITemplate("layer"),
    "No GUI for dataclass Layer",
  );
});

test("an edit of a ref is pushed to the server", async () => {
  const f = fixture({ layer: state({ value: 1 }) });
  await f.manager.fetchInstanceRecursive("layer");
  f.manager.dataStates.layer.refs.value.value = 2;
  await nextTick();
  await tick();
  assert.deepEqual(f.updates(), [{ layer: { value: 2 } }]);
});

test("a value published by the server is not echoed back to it", async () => {
  const f = fixture({ layer: state({ value: 1 }) });
  await f.manager.fetchInstanceRecursive("layer");
  await f.publish("layer", { value: 7 }, 1);
  await nextTick();
  await tick();
  assert.equal(f.value("layer", "value"), 7);
  assert.deepEqual(f.updates(), []);
});
