import assert from "node:assert/strict";
import test from "node:test";

import { DataclassCore } from "../src/index.js";
import { connect, deferred, definition, state, tick } from "./harness.js";

// The smallest client: an instance is a plain object holding the state as sent,
// dataclass fields included as ids.
class PlainManager extends DataclassCore {
  constructor() {
    super();
    this.values = {};
  }

  buildInstance(id, values) {
    this.values[id] = { ...values };
  }

  applyState(id, values) {
    Object.assign(this.values[id], values);
  }
}

function fixture(states, definitions) {
  const f = connect(new PlainManager(), states, definitions);
  return { ...f, value: (id, key) => f.manager.values[id]?.[key] };
}

const failing = () => ({
  get promise() {
    return Promise.reject(new Error("offline"));
  },
});

test("publication waits for the missing class definition", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  const gate = deferred(),
    f = fixture({ layer: state({ visible: false }) }, { Layer: gate });
  const hydration = f.manager.fetchInstanceRecursive("layer");
  await tick();
  const update = f.publish("layer", { visible: true }, 1);
  await tick();
  assert.equal(f.value("layer", "visible"), undefined);
  gate.resolve(definition());
  await Promise.all([hydration, update]);
  assert.equal(f.value("layer", "visible"), true);
  assert.equal(error.mock.callCount(), 0);
});

test("publication applies to its own state while its children are still arriving", async () => {
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
  assert.equal(f.manager.completeInstances.has("parent"), true);
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
});

test("a newer publication cannot overtake an older one waiting on a child", async () => {
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
  assert.deepEqual(f.value("parent", "children"), ["child"]);
  assert.equal(f.value("parent", "visible"), true);
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

test("a failed publication is reported and does not poison later ones", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  const f = fixture(
    {
      parent: state({ child: null, value: 0 }, "Parent"),
      broken: state({}, "Broken"),
    },
    { Parent: definition(["child"]), Broken: failing() },
  );
  await f.manager.fetchInstanceRecursive("parent");
  await f.publish("parent", { child: "broken" }, 1);
  assert.equal(error.mock.callCount(), 1);
  assert.equal(f.value("parent", "child"), null);
  await f.publish("parent", { value: 2 }, 2);
  assert.equal(f.value("parent", "value"), 2);
});

test("settling an old publication does not remove a newer active queue", async (t) => {
  const error = t.mock.method(console, "error", () => {});
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
  assert.equal(error.mock.callCount(), 0);
});

test("an RPC rejection rejects hydration rather than leaving a promise pending", async () => {
  const gate = deferred(),
    f = fixture({ layer: state({ value: 0 }, "Layer", 0, gate) });
  const hydration = f.manager.fetchInstance("layer");
  const rejected = assert.rejects(hydration, /offline/);
  gate.reject(new Error("offline"));
  await rejected;
});

for (const [shape, reference] of [
  ["field", "child"],
  ["list", ["child"]],
  ["dict", { only: "child" }],
]) {
  test(`a publication waits for a ${shape} reference that is still arriving`, async () => {
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
    assert.deepEqual(f.value("second", "child"), reference);
    assert.ok(f.manager.completeInstances.has("child"));
  });
}

test("a failed hydration is retried instead of dropping every later publication", async (t) => {
  const error = t.mock.method(console, "error", () => {});
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
  assert.equal(error.mock.callCount(), 1);
  assert.equal(f.manager.serverState.layer, undefined);
  await f.publish("layer", { value: 2 }, 2);
  assert.equal(f.value("layer", "value"), 2);
  assert.equal(error.mock.callCount(), 1);
});

test("an instance the server does not know is not cached", async () => {
  const states = {};
  const f = fixture(states);
  assert.equal(await f.manager.fetchInstanceRecursive("late"), false);
  states.late = state({ value: 1 });
  assert.equal(await f.manager.fetchInstanceRecursive("late"), true);
  assert.equal(f.value("late", "value"), 1);
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
  assert.equal(f.value("a", "peer"), "b");
  assert.ok(f.manager.completeInstances.has("b"));
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
  assert.equal(f.value("child", "count"), 42);
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
  assert.equal(f.value("child4g", "value"), "child4");
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
  assert.equal(f.value("child39", "value"), "child39");
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
  assert.deepEqual([...f.manager.completeInstances].sort(), ["a", "b"]);
});

test("graphCompleted reports every instance a walk completed", async () => {
  const f = fixture(
    {
      parent: state({ child: "child" }, "Parent"),
      child: state({ value: 1 }, "Child"),
    },
    { Parent: definition(["child"]), Child: definition() },
  );
  const completed = [];
  f.manager.graphCompleted = (ids) => completed.push(...ids);
  await f.manager.fetchInstanceRecursive("parent");
  assert.deepEqual(completed.sort(), ["child", "parent"]);
});

test("a client edit is sent, and one the server already holds is not", async () => {
  const f = fixture({ layer: state({ value: 1 }) });
  await f.manager.fetchInstanceRecursive("layer");
  f.manager.updateServer("layer", "value", 1);
  await tick();
  assert.deepEqual(f.updates(), []);
  f.manager.updateServer("layer", "value", 2);
  await tick();
  assert.deepEqual(f.updates(), [{ layer: { value: 2 } }]);
});

test("edits queued behind a request send the last value of each field", async () => {
  const f = fixture({ layer: state({ value: "x" }) });
  await f.manager.fetchInstanceRecursive("layer");
  // The first edit goes out at once; the next two queue behind it and return the
  // field to the value just sent, so nothing more needs sending.
  f.manager.updateServer("layer", "value", "z");
  f.manager.updateServer("layer", "value", "y");
  f.manager.updateServer("layer", "value", "z");
  await tick();
  assert.deepEqual(f.updates(), [{ layer: { value: "z" } }]);
});

test("a client edit of a dataclass field is sent, and walked, by id", async () => {
  const f = fixture(
    {
      parent: state({ child: null }, "Parent"),
      other: state({ value: 1 }, "Child"),
    },
    { Parent: definition(["child"]), Child: definition() },
  );
  await f.manager.fetchInstanceRecursive("parent");
  f.manager.updateServer("parent", "child", { _id: "other", value: 1 });
  await tick();
  assert.deepEqual(f.updates(), [{ parent: { child: "other" } }]);
  assert.deepEqual(f.manager.childIds("parent"), ["other"]);
});
