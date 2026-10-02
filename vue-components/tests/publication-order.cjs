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
        return result.promise || result;
      }
      return null;
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
    publish: (id, values, revision) =>
      publication([{ id, state: values, revision }]),
    value: (id, key) => manager.dataStates[id].refs[key].value,
  };
}

test("publication waits for the missing class definition", async () => {
  const gate = deferred(),
    f = fixture({ layer: state({ visible: false }) }, { Layer: gate });
  const hydration = f.manager.fetchState("layer");
  await tick();
  const update = f.publish("layer", { visible: true }, 1);
  await tick();
  assert.equal(f.manager.dataStates.layer.refs.visible, undefined);
  gate.resolve(definition());
  await Promise.all([hydration, update]);
  assert.equal(f.value("layer", "visible"), true);
  assert.deepEqual(f.errors, []);
});

test("publication waits for nested refs after the definition arrives", async () => {
  const gate = deferred(),
    f = fixture(
      {
        parent: state({ child: "child", title: "old" }, "Parent"),
        child: state({ value: 1 }, "Child"),
      },
      { Parent: definition(["child"]), Child: gate },
    );
  const hydration = f.manager.fetchState("parent");
  await tick();
  const update = f.publish("parent", { title: "new" }, 1);
  await tick();
  assert.equal(f.manager.dataStates.parent.refs.title, undefined);
  gate.resolve(definition());
  await Promise.all([hydration, update]);
  assert.equal(f.value("parent", "title"), "new");
  assert.deepEqual(f.errors, []);
});

test("a newer delta survives the first outstanding state reply", async () => {
  const gate = deferred(),
    f = fixture({ layer: state({ visible: false }, "Layer", 0, gate) });
  const hydration = f.manager.fetchState("layer");
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
  await f.manager.fetchState("parent");
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

test("a legacy discovery snapshot is not overwritten by its older discovery message", async () => {
  const f = fixture({ layer: state({ value: "snapshot" }, "Layer", null) });
  await f.publish("layer", { value: "discovery" });
  assert.equal(f.value("layer", "value"), "snapshot");
  await f.publish("layer", { value: "subsequent" });
  assert.equal(f.value("layer", "value"), "subsequent");
});

test("a legacy in-flight snapshot still replays a newer publication", async () => {
  const gate = deferred(),
    f = fixture({ layer: state({ value: "old" }, "Layer", null, gate) });
  const hydration = f.manager.fetchState("layer");
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
  const hydration = f.manager.fetchState("blocked");
  const blocked = f.publish("blocked", { value: 1 }, 1);
  await f.manager.fetchState("live");
  await f.publish("live", { value: 2 }, 1);
  assert.equal(f.value("live", "value"), 2);
  gate.resolve();
  await Promise.all([hydration, blocked]);
  assert.equal(f.value("blocked", "value"), 1);
});

test("a rejected publication is reported and does not poison subsequent publications", async () => {
  const f = fixture({ layer: state({ value: 0 }) });
  await f.manager.fetchState("layer");
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
  await f.manager.fetchState("parent");
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
  const hydration = f.manager.fetchState("layer");
  const rejected = assert.rejects(hydration, /offline/);
  gate.reject(new Error("offline"));
  await rejected;
});

test("only an integer revision advances the last applied server version", async () => {
  const f = fixture({ layer: state({ value: "snapshot" }, "Layer", 3) });
  await f.manager.fetchState("layer");
  await f.publish("layer", { value: "four" }, 4);
  await f.publish("layer", { value: "stale duplicate" }, 4);
  assert.equal(f.value("layer", "value"), "four");
  await f.publish("layer", { value: "legacy" });
  await f.publish("layer", { value: "still stale" }, 3);
  assert.equal(f.value("layer", "value"), "legacy");
});
