// A reconnect does not reconnect the client: trame builds a NEW one, with a new
// session behind it, and puts it on `trame.client`. A core that keeps the first
// one is left talking to a socket nobody is listening to -- publications stop
// arriving and client edits go nowhere -- which presents as a page whose view
// comes back and whose editing does not.
//
// These cases are the whole contract: the replacement is adopted, everything the
// retired connection could still speak for is retired with it, and what a late
// settlement from that connection does is nothing.
import assert from "node:assert/strict";
import test from "node:test";

import { DataclassCore } from "../src/index.js";
import {
  connect,
  deferred,
  definition,
  serverFailure,
  state,
  tick,
  transportFailure,
} from "./harness.js";

class PlainManager extends DataclassCore {
  constructor() {
    super();
    this.values = {};
    this.replaced = 0;
    // Every server-origin write, in order. An assertion on the resulting VALUE
    // cannot tell a revert from a field that already held that value -- which is
    // exactly the shape of a test that passes against a do-nothing client.
    this.applied = [];
  }

  buildInstance(id, values) {
    this.values[id] = { ...values };
  }

  applyState(id, values) {
    this.applied.push([id, { ...values }]);
    Object.assign(this.values[id], values);
  }

  connectionReplaced() {
    this.replaced++;
  }
}

function fixture(states, definitions) {
  const f = connect(new PlainManager(), states, definitions);
  return { ...f, value: (id, key) => f.manager.values[id]?.[key] };
}

const quiet = (t) => t.mock.method(console, "error", () => {});

test("the replacement client is adopted, and the retired subscription released", async () => {
  const f = fixture({ layer: state({ visible: false }) });
  await f.manager.fetchInstanceRecursive("layer");
  const retired = f.session();

  f.reconnect();

  assert.equal(f.manager.session, f.session());
  assert.notEqual(f.manager.session, retired);
  assert.deepEqual(retired.unsubscribed, retired.subscriptions);
  assert.equal(f.session().subscriptions.length, 1);
  assert.equal(f.manager.replaced, 1);
});

test("connecting the same session again changes nothing", async () => {
  const f = fixture({ layer: state({ visible: false }) });
  await f.manager.fetchInstanceRecursive("layer");

  f.manager.attach(f.trame);
  f.manager.connect(f.trame.client);

  assert.equal(f.session().subscriptions.length, 1);
  assert.equal(f.session().unsubscribed.length, 0);
  assert.equal(f.manager.replaced, 0);
});

test("a publication on the new session is applied", async () => {
  const f = fixture({ layer: state({ visible: false }) });
  await f.manager.fetchInstanceRecursive("layer");

  f.reconnect();
  await f.manager.fetchInstanceRecursive("layer");
  await f.publish("layer", { visible: true }, 1);

  assert.equal(f.value("layer", "visible"), true);
});

test("a publication from the retired transport writes nothing", async () => {
  const f = fixture({ layer: state({ visible: false }) });
  await f.manager.fetchInstanceRecursive("layer");
  const retired = f.session();

  f.reconnect();
  await f.publish("layer", { visible: true }, 1, retired);

  assert.equal(f.value("layer", "visible"), false);
});

test("a state reply still in flight when the connection is replaced builds nothing", async (t) => {
  quiet(t);
  const hold = deferred();
  const f = fixture({ layer: state({ visible: false }, "Layer", 0, hold) });
  const abandoned = f.manager.fetchInstanceRecursive("layer");
  await tick();

  f.reconnect();
  hold.resolve();
  await assert.rejects(abandoned, /retired session/);
  assert.equal(f.manager.values.layer, undefined);

  // ...and the id is not left owned by the attempt that was abandoned.
  assert.equal(await f.manager.fetchInstanceRecursive("layer"), true);
  assert.equal(f.value("layer", "visible"), false);
});

test("a definition from the retired session is not installed", async (t) => {
  quiet(t);
  const gate = deferred();
  const f = fixture({ layer: state({ visible: false }) }, { Layer: gate });
  const abandoned = f.manager.fetchInstanceRecursive("layer");
  await tick();

  f.reconnect();
  gate.resolve(definition(["visible"]));
  await assert.rejects(abandoned, /retired session/);
  assert.equal(f.manager.typeDefinitions.Layer, undefined);
});

test("the concurrency gate is not held by the connection that died", async (t) => {
  quiet(t);
  const held = deferred();
  const children = ["a", "b", "c"];
  const f = fixture(
    {
      parent: state({ children }, "Parent"),
      ...Object.fromEntries(
        children.map((id) => [id, state({ value: id }, "Child", 0, held)]),
      ),
    },
    { Parent: definition(["children"]), Child: definition() },
  );
  f.manager.maxConcurrentCalls = 1;
  const abandoned = f.manager.fetchInstanceRecursive("parent");
  abandoned.catch(() => {});
  await tick();

  // Every slot and the whole queue belong to a transport that will never answer.
  f.reconnect();
  held.resolve();
  const fresh = await f.manager.fetchInstanceRecursive("a");

  assert.equal(fresh, true);
  assert.equal(f.value("a", "value"), "a");
});

test("a client edit after a reconnect goes to the new connection", async () => {
  const f = fixture({ layer: state({ visible: false }) });
  await f.manager.fetchInstanceRecursive("layer");
  const retired = f.session();

  f.reconnect();
  await f.manager.fetchInstanceRecursive("layer");
  f.manager.updateServer("layer", "visible", true);
  await tick();

  assert.deepEqual(f.updates(f.session()), [{ layer: { visible: true } }]);
  assert.deepEqual(f.updates(retired), []);
});

test("an edit the dying connection refused is sent on the next one", async (t) => {
  quiet(t);
  const f = fixture({ layer: state({ visible: false }) });
  await f.manager.fetchInstanceRecursive("layer");
  const retired = f.session();

  // The socket is gone, but nothing has told this page so yet: wslink refuses the
  // call itself rather than the server answering.
  retired.failure = transportFailure();
  f.manager.updateServer("layer", "visible", true);
  await tick();
  assert.deepEqual(f.updates(retired), [{ layer: { visible: true } }]);
  assert.equal(f.manager.pendingClientServerQueue.length, 1);

  f.reconnect();
  await tick();

  // The value is sent again, rather than remembered as delivered: an edit is
  // acknowledged by the SERVER, not by a socket having accepted it.
  assert.deepEqual(f.updates(f.session()), [{ layer: { visible: true } }]);
});

test("an edit the retired session never answered is abandoned, not replayed", async (t) => {
  quiet(t);
  const f = fixture({ layer: state({ visible: false }) });
  await f.manager.fetchInstanceRecursive("layer");
  const retired = f.session();
  retired.failure = transportFailure();

  const pushed = f.manager.updateServer("layer", "visible", true);
  f.reconnect();
  await Promise.resolve(pushed);
  await tick();

  // Its outcome is unknowable and the replacement's snapshot is authoritative,
  // so the dead transport's value is not pushed over the live one...
  assert.deepEqual(f.updates(f.session()), []);
  // ...and the gate it was holding is not this session's gate.
  assert.equal(f.manager.activeFlush, null);
  // An edit sent once the instance has been hydrated on the NEW connection goes out
  // normally. The re-hydration is a precondition, not a formality: until the
  // replacement has described the class, `updateServer` refuses to push anything for
  // this instance -- see "nothing is pushed while the live connection has not
  // described the instance".
  await f.manager.fetchInstanceRecursive("layer");
  f.manager.updateServer("layer", "visible", true);
  await tick();
  assert.deepEqual(f.updates(f.session()), [{ layer: { visible: true } }]);
});

test("a page with no client channel still adopts on the next connect", async () => {
  const manager = new PlainManager();
  const f = connect(manager, { layer: state({ visible: false }) });
  // A `trame` that announces nothing: `attach` must not throw, and a component
  // calling it again on mount is then the only adoption signal there is.
  const bare = { client: f.trame.client };
  manager.attach(bare);
  assert.equal(manager.session, f.session());
});

test("a batch the server REFUSES is dropped, and the next edit still goes out", async (t) => {
  quiet(t);
  const f = fixture({ layer: state({ visible: false, opacity: 1 }) });
  await f.manager.fetchInstanceRecursive("layer");
  const session = f.session();
  const raw = session.call.bind(session);
  // The server runs the call and raises on one field -- an exception in
  // `update_state`, which wslink answers with EXCEPTION_ERROR.
  session.call = async (name, args) => {
    if (
      name === "trame.dataclass.state.update" &&
      "visible" in (args[0].layer || {})
    ) {
      session.calls.push([name, args]);
      await Promise.resolve();
      throw serverFailure();
    }
    return raw(name, args);
  };

  f.manager.updateServer("layer", "visible", true);
  await tick();
  f.manager.updateServer("layer", "opacity", 0.5);
  await tick();

  // Re-queueing a REFUSED batch is how one field poisons the page: it goes back at
  // the head of the queue, every later edit of every instance is merged into it, and
  // the server refuses the merged batch for the same reason -- forever.
  const sent = f.updates(session);
  assert.deepEqual(sent.at(-1), { layer: { opacity: 0.5 } });
  assert.deepEqual(f.manager.pendingClientServerQueue, []);
});

test("a refused batch leaves no cache claiming the server holds it", async (t) => {
  quiet(t);
  const f = fixture({ layer: state({ visible: false }) });
  await f.manager.fetchInstanceRecursive("layer");
  const session = f.session();
  const raw = session.call.bind(session);
  let refusals = 0;
  session.call = async (name, args) => {
    if (name === "trame.dataclass.state.update" && refusals < 1) {
      refusals++;
      session.calls.push([name, args]);
      await Promise.resolve();
      throw serverFailure();
    }
    return raw(name, args);
  };

  f.manager.updateServer("layer", "visible", true);
  await tick();
  // The user tries the same edit again. The cache must not say "the server already
  // has that", because it does not: it refused.
  f.manager.updateServer("layer", "visible", true);
  await tick();

  assert.deepEqual(f.updates(session), [
    { layer: { visible: true } },
    { layer: { visible: true } },
  ]);
});

test("nothing is pushed while the live connection has not described the instance", async (t) => {
  quiet(t);
  const held = deferred();
  const definitions = { Layer: definition([], { client_only: ["draft"] }) };
  const f = fixture(
    { layer: state({ visible: false, draft: "" }) },
    definitions,
  );
  await f.manager.fetchInstanceRecursive("layer");

  definitions.Layer = held;
  f.reconnect();
  await tick();
  // `retire` cleared the schema and the replacement's has not landed. Every question
  // `updateServer` asks is answered out of it, and a missing schema answers "no" to
  // all of them -- so a client_only field would be sent for the first time ever.
  assert.equal(f.manager.typeDefinitions.Layer, undefined);
  assert.equal(f.manager.dataTypes.layer, "Layer");
  f.manager.updateServer("layer", "draft", "typed in the window");
  f.manager.updateServer("layer", "visible", true);
  await tick();
  assert.deepEqual(f.updates(f.session()), []);

  held.resolve(definition([], { client_only: ["draft"] }));
  await f.manager.fetchInstanceRecursive("layer");
  f.manager.updateServer("layer", "draft", "still client only");
  f.manager.updateServer("layer", "visible", true);
  await tick();
  assert.deepEqual(f.updates(f.session()), [{ layer: { visible: true } }]);
});

// A refusal the client answers by refusing one that failed: see `revertView`.
function refusing(f, matches) {
  const session = f.session();
  const raw = session.call.bind(session);
  session.call = async (name, args) => {
    if (name === "trame.dataclass.state.update" && matches(args[0])) {
      session.calls.push([name, args]);
      await Promise.resolve();
      throw serverFailure();
    }
    return raw(name, args);
  };
  return session;
}

test("a refused field goes back to the value the server holds", async (t) => {
  quiet(t);
  const f = fixture({ layer: state({ visible: false, opacity: 1 }) });
  await f.manager.fetchInstanceRecursive("layer");
  const session = refusing(f, (msg) => "visible" in (msg.layer || {}));

  f.manager.updateServer("layer", "visible", true);
  await tick();

  // The refusal is final -- no resend is coming -- so leaving the user's value on
  // screen means the control shows something nobody holds until the next thing that
  // refreshes it silently changes it back.
  assert.deepEqual(f.manager.applied, [["layer", { visible: false }]]);
  assert.deepEqual(f.manager.values.layer, { visible: false, opacity: 1 });
  assert.equal(f.manager.serverState.layer.visible, JSON.stringify([false]));
  // ...and the revert is a server-origin write, so it does not bounce back out.
  assert.deepEqual(f.updates(session), [{ layer: { visible: true } }]);
});

test("a field with no value on the server is left as the user typed it", async (t) => {
  quiet(t);
  const f = fixture({ layer: state({ visible: false }) });
  await f.manager.fetchInstanceRecursive("layer");
  const session = refusing(f, () => true);

  // `fresh` was never in the cache: there is nothing to revert TO, and inventing a
  // value would be worse than leaving what the user typed.
  f.manager.updateServer("layer", "fresh", "typed");
  await tick();

  assert.deepEqual(f.manager.applied, []);
  assert.equal(f.manager.values.layer.fresh, undefined);
  assert.equal("fresh" in f.manager.serverState.layer, false);
  assert.equal(f.updates(session).length, 1);
});

test("an edit made while the refused batch was in flight is not reverted over", async (t) => {
  quiet(t);
  const f = fixture({ layer: state({ opacity: 1 }) });
  await f.manager.fetchInstanceRecursive("layer");
  const session = refusing(f, (msg) => msg.layer?.opacity === 0.5);

  f.manager.updateServer("layer", "opacity", 0.5);
  // ...and the user moves the slider again before the refusal lands. Three distinct
  // values on purpose: the server's 1, the refused 0.5, and 0.25, which is what they
  // are looking at and what the next flush must send. Reverting to 1 would undo a
  // drag the server has not even been told about.
  f.manager.updateServer("layer", "opacity", 0.25);
  await tick();
  await tick();

  assert.deepEqual(f.manager.applied, [], "no revert was applied");
  assert.deepEqual(f.updates(session), [
    { layer: { opacity: 0.5 } },
    { layer: { opacity: 0.25 } },
  ]);
  assert.deepEqual(f.manager.pendingClientServerQueue, []);
  assert.equal(f.manager.serverState.layer.opacity, JSON.stringify([0.25]));
});
