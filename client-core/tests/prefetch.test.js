import assert from "node:assert/strict";
import test from "node:test";

import { DataclassCore } from "../src/index.js";
import { connect, definition, state, tick } from "./harness.js";

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

const stateRequests = (calls) =>
  calls
    .filter(([name]) => name === "trame.dataclass.state.get")
    .map(([, args]) => args[0]);

test("prefetch requests every id in one wave", async () => {
  const states = {};
  for (let i = 0; i < 6; i++) states[`m${i}`] = state({ value: i });
  const f = connect(new PlainManager(), states);
  const results = await f.manager.prefetch(Object.keys(states));
  assert.deepEqual(
    results.map(({ id, ready }) => [id, ready]),
    Object.keys(states).map((id) => [id, true]),
  );
  assert.equal(f.maxInFlight() > 1, true);
  assert.deepEqual(stateRequests(f.calls).sort(), Object.keys(states).sort());
});

test("prefetch loads the children of a container", async () => {
  const f = connect(
    new PlainManager(),
    {
      parent: state({ items: ["c1", "c2"] }, "Parent"),
      c1: state({ value: 1 }),
      c2: state({ value: 2 }),
    },
    { Parent: definition(["items"]), Layer: definition() },
  );
  await f.manager.prefetch(["parent"]);
  assert.deepEqual(stateRequests(f.calls).sort(), ["c1", "c2", "parent"]);
  assert.equal(f.manager.values.c2.value, 2);
});

test("an id already loading or loaded is not fetched again", async () => {
  const f = connect(new PlainManager(), {
    a: state({ value: 1 }),
    b: state({ value: 2 }),
  });
  const first = f.manager.prefetch(["a"]);
  await f.manager.prefetch(["a", "b"]);
  await first;
  await f.manager.prefetch(["a", "b"]);
  await tick();
  assert.deepEqual(stateRequests(f.calls).sort(), ["a", "b"]);
});

test("an unknown id is reported without failing the rest of the wave", async () => {
  const f = connect(new PlainManager(), { a: state({ value: 1 }) });
  const results = await f.manager.prefetch(["a", "missing"]);
  assert.deepEqual(
    results.map(({ id, ready }) => [id, ready]),
    [
      ["a", true],
      ["missing", false],
    ],
  );
});
