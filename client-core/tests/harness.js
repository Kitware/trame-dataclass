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
    maxInFlight = 0,
    publication;
  const session = {
    async call(name, args) {
      calls.push([name, args]);
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      try {
        // Reply asynchronously, as a server would, so requests can overlap.
        await Promise.resolve();
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
      publication = callback;
      return {};
    },
  };
  manager.connect({ getConnection: () => ({ getSession: () => session }) });
  return {
    manager,
    calls,
    maxInFlight: () => maxInFlight,
    publish: (id, values, revision) =>
      publication([{ id, state: values, revision }]),
    // The messages sent with `state.update`, in order.
    updates: () =>
      calls
        .filter(([name]) => name === "trame.dataclass.state.update")
        .map(([, args]) => args[0]),
  };
}
