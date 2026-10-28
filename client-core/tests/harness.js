/* eslint-env node */
// A fake wslink session for client tests, shared by client-core, vue-components
// and react-components: it answers `state.get` and `definition.get` from fixed
// tables, records every call, and lets a test publish deltas.

export function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));

// What wslink's client rejects with when it is asked to call on a closed socket:
// its own CLIENT_ERROR code, and no `data`, because no server was involved.
export const transportFailure = (method = "trame.dataclass.state.update") => ({
  code: -32099,
  message: `RPC call ${method} unsuccessful: connection not open`,
});

// ...and what a server that RAN the call and raised sends back: EXCEPTION_ERROR,
// with the method and traceback it failed in.
export const serverFailure = (method = "trame.dataclass.state.update") => ({
  code: -32001,
  message: "Exception raised",
  data: { method, exception: "ValueError", trace: ["..."] },
});

export const definition = (containers = [], extra = {}) => ({
  dataclass_containers: containers,
  client_only: [],
  deep_reactive: [],
  ...extra,
});

export const state = (values, type = "Layer", revision = 0, hold = null) => ({
  definition: type,
  state: values,
  revision,
  hold,
});

// `states` maps instance ids to `state(...)`; an id missing from it is unknown
// to the server. `definitions` maps class ids to a definition, a `deferred()`,
// or anything with a `promise` getter.
export function connect(
  manager,
  states,
  definitions = { Layer: definition() },
) {
  const calls = [];
  let inFlight = 0,
    maxInFlight = 0;

  // A reconnect gives the page a NEW session behind the same client object, so
  // one is built per connection rather than once.
  function newSession() {
    const session = {
      calls: [],
      subscriptions: [],
      unsubscribed: [],
      publication: null,
      // `undefined` answers normally; set it to a rejection value and every call
      // rejects with it. Use `transportFailure()` for "there is no socket" and a
      // `serverFailure()` for "the server answered with an error" -- the client
      // treats those two as opposites, so a test must say which it means.
      failure: null,
      async call(name, args) {
        calls.push([name, args]);
        session.calls.push([name, args]);
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        try {
          // Reply asynchronously, as a server would, so requests can overlap.
          await Promise.resolve();
          if (session.failure) throw session.failure;
          if (name === "trame.dataclass.state.get") {
            const original = states[args[0]];
            if (!original) return { id: args[0], state: null };
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
        session.publication = callback;
        const token = { topic };
        session.subscriptions.push(token);
        return token;
      },
      unsubscribe(token) {
        session.unsubscribed.push(token);
      },
    };
    return session;
  }

  let session = newSession();
  const listeners = [];
  const client = { getConnection: () => ({ getSession: () => session }) };
  // A `trame`-shaped object: `attach` connects to whatever client is on it now
  // and asks to be told when that becomes a different one.
  const trame = {
    client,
    addConnectListener: (listener) => listeners.push(listener),
  };
  manager.attach(trame);
  return {
    manager,
    trame,
    calls,
    maxInFlight: () => maxInFlight,
    session: () => session,
    // The client object is replaced and the channel fires, exactly as a
    // reconnect does it. Returns the retired session.
    reconnect: () => {
      const retired = session;
      session = newSession();
      trame.client = { getConnection: () => ({ getSession: () => session }) };
      listeners.forEach((listener) => listener());
      return retired;
    },
    publish: (id, values, revision, on = session) =>
      on.publication([{ id, state: values, revision }]),
    // The messages sent with `state.update`, in order.
    updates: (on = null) =>
      (on ? on.calls : calls)
        .filter(([name]) => name === "trame.dataclass.state.update")
        .map(([, args]) => args[0]),
  };
}
