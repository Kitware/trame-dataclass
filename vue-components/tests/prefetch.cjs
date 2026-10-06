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
const settle = async (times = 6) => {
  for (let i = 0; i < times; i++) await tick();
};
const definition = (containers = []) => ({
  dataclass_containers: containers,
  client_only: [],
  deep_reactive: [],
});
const state = (values, type = "Layer", hold = null) => ({
  definition: type,
  state: values,
  hold,
});
// The component, loaded from source against the manager the fixture built. Its `vue`
// and `./TrameDataclass` imports are the only things it needs from a bundler.
function loadPrefetchComponent(manager, logger) {
  const code = fs
    .readFileSync(
      path.join(__dirname, "../src/components/TrameDataclassPrefetch.js"),
      "utf8",
    )
    .replace(/import \{([^}]+)\} from "vue";/, "const {$1} = Vue;")
    .replace(/import[^;]+;/g, "")
    .replace("export default", "module.exports =");
  const context = { Vue, console: logger, GLOBAL_DATA_MANAGER: manager };
  context.module = { exports: {} };
  vm.runInNewContext(code, context);
  const component = context.module.exports;
  return { ...component, render: Vue.compile(component.template) };
}

// A host-less Vue renderer: these tests are about what the component asks for, so
// they need a component tree, not a DOM.
function mount(render, client, logger) {
  const node = (type, text = "") => ({
    type,
    text,
    children: [],
    parent: null,
  });
  const host = {
    createElement: (type) => node(type),
    createText: (text) => node("text", text),
    createComment: (text) => node("comment", text),
    setText: (n, t) => (n.text = t),
    setElementText: (n, t) => {
      n.text = t;
      n.children = [];
    },
    parentNode: (n) => n.parent,
    nextSibling: (n) =>
      n.parent?.children[n.parent.children.indexOf(n) + 1] || null,
    patchProp: () => {},
    insert(n, parent) {
      n.parent = parent;
      parent.children.push(n);
    },
    remove(n) {
      const index = n.parent?.children.indexOf(n) ?? -1;
      if (index >= 0) n.parent.children.splice(index, 1);
      n.parent = null;
    },
  };
  const root = node("root");
  const app = Vue.createRenderer(host).createApp({ render });
  app.provide("trame", { client });
  app.config.warnHandler = (message) => logger.error(["Vue", message]);
  app.mount(root);
  return { app, root };
}

function fixture(states, definitions = { Layer: definition() }) {
  const errors = [],
    warnings = [],
    calls = [];
  const context = {
    Vue,
    module: { exports: {} },
    console: {
      error: (...args) => errors.push(args),
      warn: (...args) => warnings.push(args),
    },
  };
  vm.runInNewContext(source, context);
  const manager = new context.module.exports.DataclassManager();
  const session = {
    async call(name, args) {
      calls.push([name, args]);
      if (name === "trame.dataclass.state.get") {
        const original = states[args[0]];
        const snapshot = structuredClone({
          definition: original.definition,
          state: original.state,
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
    subscribe() {
      return {};
    },
  };
  const client = { getConnection: () => ({ getSession: () => session }) };
  manager.connect(client);
  return {
    manager,
    client,
    errors,
    warnings,
    logger: context.console,
    requested: (method) =>
      calls.filter(([name]) => name === method).map(([, args]) => args[0]),
    value: (id, key) => manager.dataStates[id].refs[key].value,
  };
}

test("every id is requested in the same wave, not one after another", async () => {
  const holds = { a: deferred(), b: deferred(), c: deferred() };
  const f = fixture({
    a: state({ v: "a" }, "Layer", holds.a),
    b: state({ v: "b" }, "Layer", holds.b),
    c: state({ v: "c" }, "Layer", holds.c),
  });
  const wave = f.manager.prefetch(["a", "b", "c"]);
  await tick();
  assert.deepEqual(f.requested("trame.dataclass.state.get"), ["a", "b", "c"]);
  Object.values(holds).forEach((hold) => hold.resolve());
  const results = await wave;
  assert.deepEqual(
    results.map(({ id, ready }) => ({ id, ready })),
    [
      { id: "a", ready: true },
      { id: "b", ready: true },
      { id: "c", ready: true },
    ],
  );
  assert.equal(f.value("a", "v"), "a");
  assert.deepEqual(f.errors, []);
});

test("a repeated or already-started id is not fetched twice", async () => {
  const hold = deferred();
  const f = fixture({ a: state({ v: 1 }, "Layer", hold) });
  const first = f.manager.fetchState("a");
  await tick();
  const wave = f.manager.prefetch(["a", "a"]);
  hold.resolve();
  const results = await wave;
  await first;
  assert.deepEqual(f.requested("trame.dataclass.state.get"), ["a"]);
  assert.ok(results.every((result) => result.ready));
});

test("prefetching a container hydrates its children too", async () => {
  const f = fixture(
    {
      parent: state({ child: "child", title: "parent" }, "Parent"),
      child: state({ required: "child-ready" }, "Child"),
    },
    { Parent: definition(["child"]), Child: definition() },
  );
  const results = await f.manager.prefetch(["parent"]);
  assert.ok(results[0].ready);
  assert.equal(f.value("parent", "child").required, "child-ready");
  assert.deepEqual(f.errors, []);
});

test("a component linked mid-wave waits for complete refs", async () => {
  const gate = deferred();
  const f = fixture(
    {
      parent: state({ child: "child", title: "parent" }, "Parent"),
      child: state({ required: "child-ready" }, "Child"),
    },
    { Parent: definition(["child"]), Child: gate },
  );
  const wave = f.manager.prefetch(["parent"]);
  await settle();
  // The instance is allocated -- the state reply landed -- but its class definition
  // and nested refs are not there yet. This is the window a wave makes ordinary.
  assert.ok(f.manager.dataStates.parent);
  const data = Vue.reactive({});
  const linked = f.manager.connectVueComponent("component", {
    id: "parent",
    data,
    guards: { serverPush: false },
  });
  await settle();
  assert.equal(data._id, undefined, "component saw an incomplete instance");
  gate.resolve(definition());
  await Promise.all([wave, linked]);
  assert.equal(data._id, "parent");
  assert.equal(data.title, "parent");
  assert.equal(data.child.required, "child-ready");
  assert.deepEqual(f.errors, []);
});

test("the component renders its slot while every id is still in flight", async () => {
  const holds = { a: deferred(), b: deferred() };
  const f = fixture({
    a: state({ v: "a" }, "Layer", holds.a),
    b: state({ v: "b" }, "Layer", holds.b),
  });
  const Prefetch = loadPrefetchComponent(f.manager, f.logger);
  const mounted = mount(
    () =>
      Vue.h(Prefetch, { instances: ["a", "b"] }, () => Vue.h("span", "now")),
    f.client,
    f.logger,
  );
  await tick();
  // Nothing has hydrated, and the slot content is already there: this is a warm-up,
  // not a barrier. (A fragment also inserts empty text anchors around it.)
  assert.deepEqual(
    mounted.root.children.filter((node) => node.type === "span"),
    [{ type: "span", text: "now", children: [], parent: mounted.root }],
  );
  assert.deepEqual(f.requested("trame.dataclass.state.get"), ["a", "b"]);
  Object.values(holds).forEach((hold) => hold.resolve());
  await settle();
  mounted.app.unmount();
  assert.deepEqual(f.warnings, []);
  assert.deepEqual(f.errors, []);
});

test("a replaced list warms the new ids only", async () => {
  const f = fixture({ a: state({ v: "a" }), b: state({ v: "b" }) });
  const Prefetch = loadPrefetchComponent(f.manager, f.logger);
  const ids = Vue.ref(["a"]);
  const mounted = mount(
    () => Vue.h(Prefetch, { instances: ids.value }, () => Vue.h("span", "now")),
    f.client,
    f.logger,
  );
  await settle();
  ids.value = ["a", "b"];
  await settle();
  assert.deepEqual(f.requested("trame.dataclass.state.get"), ["a", "b"]);
  mounted.app.unmount();
  assert.deepEqual(f.warnings, []);
  assert.deepEqual(f.errors, []);
});

test("one class definition is requested once for a whole wave", async () => {
  const f = fixture({
    a: state({ v: "a" }),
    b: state({ v: "b" }),
    c: state({ v: "c" }),
  });
  const results = await f.manager.prefetch(["a", "b", "c"]);
  assert.ok(results.every((result) => result.ready));
  // Without this, warming N instances of one class costs N state requests AND N
  // definition requests: the wave doubles the traffic it was meant to overlap.
  assert.deepEqual(f.requested("trame.dataclass.definition.get"), ["Layer"]);
  assert.deepEqual(f.errors, []);
});
