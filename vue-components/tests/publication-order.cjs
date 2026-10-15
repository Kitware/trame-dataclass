/* eslint-env node */
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Vue = require("vue");
const source =
  fs
    .readFileSync(
      process.env.DATACLASS_CORE || path.join(__dirname, "../src/core.js"),
      "utf8",
    )
    .replace(
      'import { ref, reactive, watch } from "vue";',
      "const { ref, reactive, watch } = Vue;",
    )
    .replace("export class DataclassManager", "class DataclassManager") +
  "\nmodule.exports = { DataclassManager };";
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const definition = (containers = []) => ({
  dataclass_containers: containers,
  client_only: [],
  deep_reactive: [],
});
const state = (values, type = "Layer", revision = 0, hold = null) => ({
  definition: type,
  state: values,
  revision,
  hold,
});
function fixture(states, definitions = { Layer: definition() }) {
  const errors = [],
    calls = [];
  let inFlight = 0,
    maxInFlight = 0;
  const context = {
    Vue,
    module: { exports: {} },
    console: { error: (...args) => errors.push(args) },
  };
  vm.runInNewContext(source, context);
  const manager = new context.module.exports.DataclassManager();
  let publication;
  const session = {
    async call(name, args) {
      calls.push([name, args]);
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      try {
        // Reply asynchronously, as a server would, so requests can overlap.
        await Promise.resolve();
        if (name === "trame.dataclass.state.get") {
          const original = states[args[0]];
          const snapshot = structuredClone({
            definition: original.definition,
            state: original.state,
            revision: original.revision,
          });
          if (original.hold) await original.hold.promise;
          return snapshot;
        }
        if (name === "trame.dataclass.definition.get") {
          const result = definitions[args[0]];
          return await (result.promise || result);
        }
        return null;
      } finally {
        inFlight--;
      }
    },
    subscribe(topic, callback) {
      publication = callback;
      return {};
    },
  };
  manager.connect({ getConnection: () => ({ getSession: () => session }) });
  return {
    manager,
    errors,
    calls,
    maxInFlight: () => maxInFlight,
    publish: (id, values, revision) =>
      publication([{ id, state: values, revision }]),
    value: (id, key) => manager.dataStates[id].refs[key].value,
  };
}

test("publication waits for the missing class definition", async () => {
  const gate = deferred(),
    f = fixture({ layer: state({ visible: false }) }, { Layer: gate });
  const hydration = f.manager.fetchInstanceRecursive("layer");
  await tick();
  const update = f.publish("layer", { visible: true }, 1);
  await tick();
  assert.equal(f.manager.dataStates.layer?.refs.visible, undefined);
  gate.resolve(definition());
  await Promise.all([hydration, update]);
  assert.equal(f.value("layer", "visible"), true);
  assert.deepEqual(f.errors, []);
});

test("publication applies to its own refs while its children are still arriving", async () => {
  const gate = deferred(),
    f = fixture(
      {
        parent: state({ child: "child", title: "old" }, "Parent"),
        child: state({ value: 1 }, "Child"),
      },
      { Parent: definition(["child"]), Child: gate },
    );
  const hydration = f.manager.fetchInstanceRecursive("parent");
  await tick();
  await f.publish("parent", { title: "new" }, 1);
  assert.equal(f.value("parent", "title"), "new");
  assert.equal(f.manager.completeInstances.has("parent"), false);
  gate.resolve(definition());
  await hydration;
  assert.equal(f.value("parent", "child").value, 1);
  assert.deepEqual(f.errors, []);
});

test("a newer delta survives the first outstanding state reply", async () => {
  const gate = deferred(),
    f = fixture({ layer: state({ visible: false }, "Layer", 0, gate) });
  const hydration = f.manager.fetchInstanceRecursive("layer");
  const update = f.publish("layer", { visible: true }, 1);
  await tick();
  gate.resolve();
  await Promise.all([hydration, update]);
  assert.equal(f.value("layer", "visible"), true);
  assert.deepEqual(f.errors, []);
});

test("a newer publication cannot overtake an older callback fetching a child", async () => {
  const gate = deferred(),
    f = fixture(
      {
        parent: state({ children: [], visible: false }, "Parent"),
        child: state({ value: 1 }, "Child"),
      },
      { Parent: definition(["children"]), Child: gate },
    );
  await f.manager.fetchInstanceRecursive("parent");
  const older = f.publish("parent", { children: ["child"], visible: false }, 1);
  await tick();
  const newer = f.publish("parent", { visible: true }, 2);
  await tick();
  assert.equal(f.value("parent", "visible"), false);
  gate.resolve(definition());
  await Promise.all([older, newer]);
  await Vue.nextTick();
  assert.equal(f.value("parent", "visible"), true);
  assert.deepEqual(f.errors, []);
  assert.equal(
    f.calls.filter(([name]) => name === "trame.dataclass.state.update").length,
    0,
  );
});

test("a snapshot revision subsumes older and equal publications without rollback", async () => {
  const f = fixture({ layer: state({ value: "newest" }, "Layer", 3) });
  const first = f.publish("layer", { value: "old" }, 1);
  const equal = f.publish("layer", { value: "also old" }, 3);
  await Promise.all([first, equal]);
  assert.equal(f.value("layer", "value"), "newest");
  await f.publish("layer", { value: "later" }, 4);
  assert.equal(f.value("layer", "value"), "later");
});

test("a v1 protocol discovery snapshot is not overwritten by its older discovery message", async () => {
  const f = fixture({ layer: state({ value: "snapshot" }, "Layer", null) });
  await f.publish("layer", { value: "discovery" });
  assert.equal(f.value("layer", "value"), "snapshot");
  await f.publish("layer", { value: "subsequent" });
  assert.equal(f.value("layer", "value"), "subsequent");
});

test("a v1 protocol in-flight snapshot still replays a newer publication", async () => {
  const gate = deferred(),
    f = fixture({ layer: state({ value: "old" }, "Layer", null, gate) });
  const hydration = f.manager.fetchInstanceRecursive("layer");
  const update = f.publish("layer", { value: "new" });
  gate.resolve();
  await Promise.all([hydration, update]);
  assert.equal(f.value("layer", "value"), "new");
});

test("one blocked instance does not hold unrelated updates", async () => {
  const gate = deferred(),
    f = fixture({
      blocked: state({ value: 0 }, "Layer", 0, gate),
      live: state({ value: 0 }),
    });
  const hydration = f.manager.fetchInstanceRecursive("blocked");
  const blocked = f.publish("blocked", { value: 1 }, 1);
  await f.manager.fetchInstanceRecursive("live");
  await f.publish("live", { value: 2 }, 1);
  assert.equal(f.value("live", "value"), 2);
  gate.resolve();
  await Promise.all([hydration, blocked]);
  assert.equal(f.value("blocked", "value"), 1);
});

test("a rejected publication is reported and does not poison subsequent publications", async () => {
  const f = fixture({ layer: state({ value: 0 }) });
  await f.manager.fetchInstanceRecursive("layer");
  await f.publish("layer", { undeclared: 1 }, 1);
  assert.equal(f.errors.length, 1);
  await f.publish("layer", { value: 2 }, 2);
  assert.equal(f.value("layer", "value"), 2);
});

test("settling an old publication does not remove a newer active queue", async () => {
  const gate = deferred(),
    f = fixture(
      {
        parent: state({ children: [], visible: false }, "Parent"),
        child: state({ value: 1 }, "Child"),
      },
      { Parent: definition(["children"]), Child: gate },
    );
  await f.manager.fetchInstanceRecursive("parent");
  const first = f.publish("parent", { visible: true }, 1);
  const second = f.publish(
    "parent",
    { children: ["child"], visible: false },
    2,
  );
  await first;
  await tick();
  const third = f.publish("parent", { visible: true }, 3);
  await tick();
  gate.resolve(definition());
  await Promise.all([second, third]);
  assert.equal(f.value("parent", "visible"), true);
  assert.deepEqual(f.errors, []);
});

test("an RPC rejection rejects hydration rather than leaving a promise pending", async () => {
  const gate = deferred(),
    f = fixture({ layer: state({ value: 0 }, "Layer", 0, gate) });
  const hydration = f.manager.fetchInstanceRecursive("layer");
  const rejected = assert.rejects(hydration, /offline/);
  gate.reject(new Error("offline"));
  await rejected;
});

for (const [shape, reference] of [
  ["field", "child"],
  ["list", ["child"]],
  ["dict", { only: "child" }],
]) {
  test(`a publication waits for a ${shape} reference that is still hydrating`, async () => {
    const gate = deferred(),
      f = fixture(
        {
          first: state({ child: null }, "Parent"),
          second: state({ child: null }, "Parent"),
          child: state({ count: 42 }, "Child"),
        },
        { Parent: definition(["child"]), Child: gate },
      );
    await Promise.all([
      f.manager.fetchInstanceRecursive("first"),
      f.manager.fetchInstanceRecursive("second"),
    ]);
    // The first reference starts the child, which then holds on its definition.
    const first = f.publish("first", { child: reference }, 1);
    await tick();
    assert.ok(
      f.calls.some(
        ([name, args]) =>
          name === "trame.dataclass.state.get" && args[0] === "child",
      ),
    );
    const second = f.publish("second", { child: reference }, 1);
    await tick();
    assert.equal(f.value("second", "child"), null);
    gate.resolve(definition());
    await Promise.all([first, second]);
    const value = f.value("second", "child");
    const child = shape === "field" ? value : Object.values(value)[0];
    assert.equal(child.count, 42);
    assert.deepEqual(f.errors, []);
  });
}

test("a failed hydration is retried instead of dropping every later publication", async () => {
  let attempts = 0;
  const f = fixture(
    { layer: state({ value: 0 }) },
    {
      Layer: {
        get promise() {
          return attempts++ === 0
            ? Promise.reject(new Error("offline"))
            : Promise.resolve(definition());
        },
      },
    },
  );
  await f.publish("layer", { value: 1 }, 1);
  assert.equal(f.errors.length, 1);
  assert.equal(f.manager.dataStates.layer, undefined);
  await f.publish("layer", { value: 2 }, 2);
  assert.equal(f.value("layer", "value"), 2);
  assert.equal(f.errors.length, 1);
});

test("waiting for a referenced instance does not deadlock on a cycle", async () => {
  const f = fixture(
    {
      a: state({ peer: null }, "Node"),
      b: state({ peer: "a" }, "Node"),
    },
    { Node: definition(["peer"]) },
  );
  await f.manager.fetchInstanceRecursive("a");
  await f.publish("a", { peer: "b" }, 1);
  assert.equal(f.value("a", "peer").peer._id, "a");
  assert.deepEqual(f.errors, []);
});

test("an instance is complete only once every instance it reaches is", async () => {
  const gate = deferred(),
    f = fixture(
      {
        first: state({ child: "child" }, "Parent"),
        second: state({ child: "child" }, "Parent"),
        child: state({ count: 42 }, "Child"),
      },
      { Parent: definition(["child"]), Child: gate },
    );
  const first = f.manager.fetchInstanceRecursive("first");
  await tick();
  let secondDone = false;
  const second = f.manager
    .fetchInstanceRecursive("second")
    .then(() => (secondDone = true));
  await tick();
  assert.equal(secondDone, false);
  gate.resolve(definition());
  await Promise.all([first, second]);
  assert.equal(f.value("second", "child").count, 42);
});

test("a graph is fetched one level at a time, not one instance at a time", async () => {
  const children = Array.from({ length: 5 }, (_, i) => `child${i}`);
  const f = fixture(
    {
      parent: state({ children }, "Parent"),
      ...Object.fromEntries(
        children.map((id) => [id, state({ grandchild: `${id}g` }, "Child")]),
      ),
      ...Object.fromEntries(
        children.map((id) => [`${id}g`, state({ value: id }, "Leaf")]),
      ),
    },
    {
      Parent: definition(["children"]),
      Child: definition(["grandchild"]),
      Leaf: definition(),
    },
  );
  await f.manager.fetchInstanceRecursive("parent");
  assert.equal(f.maxInFlight(), 5);
  assert.equal(f.value("parent", "children")[4].grandchild.value, "child4");
  assert.equal(
    f.calls.filter(([name]) => name === "trame.dataclass.definition.get")
      .length,
    3,
  );
});

test("requests in flight never exceed maxConcurrentCalls", async () => {
  const children = Array.from({ length: 40 }, (_, i) => `child${i}`);
  const f = fixture(
    {
      parent: state({ children }, "Parent"),
      ...Object.fromEntries(
        children.map((id) => [id, state({ value: id }, "Child")]),
      ),
    },
    { Parent: definition(["children"]), Child: definition() },
  );
  f.manager.maxConcurrentCalls = 4;
  await f.manager.fetchInstanceRecursive("parent");
  assert.equal(f.maxInFlight(), 4);
  assert.equal(f.manager.activeCalls, 0);
  assert.equal(f.value("parent", "children")[39].value, "child39");
  // The definition jumps the queue rather than waiting behind every child: it goes
  // after the parent, its definition, the first four children and the four handed
  // their slots as those replied - ahead of the 32 still queued.
  const definitionAt = f.calls.findIndex(
    ([name, args]) =>
      name === "trame.dataclass.definition.get" && args[0] === "Child",
  );
  assert.equal(definitionAt, 10);
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
  assert.equal(f.value("a", "peer").peer._id, "a");
  assert.deepEqual([...f.manager.completeInstances].sort(), ["a", "b"]);
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
  const data = Vue.reactive({});
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
  const data = Vue.reactive({});
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

test("a GUI template waits for the class definition", async () => {
  const gate = deferred(),
    f = fixture({ layer: state({ value: 0 }) }, { Layer: gate });
  f.manager.fetchInstance("layer");
  await tick();
  const template = f.manager.getGUITemplate("layer");
  gate.resolve({ ...definition(), template: "<b>layer</b>" });
  assert.equal(await template, "<b>layer</b>");
});
