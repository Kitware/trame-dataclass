// Framework-agnostic half of the trame-dataclass client, bundled into both the
// Vue (vue-components) and the React (react-components) client.
//
// It owns everything that talks to the server: fetching instances and their
// class definitions, walking the instance graph, ordering publications, and
// pushing client edits back. A subclass owns how an instance is represented in
// its framework, by implementing:
//
// - `buildInstance(id, state)`: create an instance from its first snapshot.
// - `applyState(id, state)`: apply a delta to an instance already built.
//
// and optionally reacting to `instanceFetched(id)`, `instanceDiscarded(id)`
// and `graphCompleted(ids)`. Both are synchronous. A dataclass field in
// `state` holds instance ids - one, or a list or dict of them. The instances
// they name are complete when `applyState` runs; when `buildInstance` runs
// they may not have arrived yet, and are fetched right after it.

// Ids held by a dataclass field, whichever container holds them.
export function idsOf(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  return Object.values(value);
}

// A dataclass field's client value as the ids the server expects: whatever
// stands for an instance on the client carries its id as `_id`.
export function serializeDataClass(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  const idOf = (record) => record?._id ?? record;
  if (Array.isArray(value)) return value.map(idOf);
  if (value._id) return value._id;
  return Object.fromEntries(
    Object.entries(value).map(([key, record]) => [key, idOf(record)]),
  );
}

function encodeState(encoded, state) {
  for (const [key, value] of Object.entries(state || {})) {
    encoded[key] = JSON.stringify([value]);
  }
  return encoded;
}

function toSet(names) {
  return Object.fromEntries((names || []).map((name) => [name, 1]));
}

export class DataclassCore {
  constructor() {
    this.client = null;
    this.subscription = null;
    // The session every piece of work below belongs to. A reconnect replaces it,
    // and comparing it is how a late settlement knows it is speaking for a server
    // this page no longer talks to.
    this.session = null;
    this.dataTypes = {}; // instance id -> class id
    this.typeDefinitions = {}; // class id -> definition, its field lists as sets
    // instance id -> field -> JSON of the value the server is known to hold, so
    // an edit the server already has is not sent back.
    this.serverState = {};
    this.references = {}; // instance id -> dataclass field -> instance ids
    this.revisions = {};
    this.pendingFetch = {};
    this.pendingDefinition = {};
    this.pendingPublications = {};
    this.completeInstances = new Set();
    this.pendingClientServerQueue = [];
    // `{ session }` while a `state.update` is in flight, or null. The gate has an
    // OWNER: a batch handed to a transport that then died waits for an answer that
    // cannot arrive, and an unowned gate made every later edit wait with it.
    this.activeFlush = null;
    // The session a push last failed against, so held edits wait for a new
    // connection instead of spinning against the dead one.
    this.failedPushSession = null;
    // At most this many state and definition requests in flight: a graph of thousands
    // of instances queues behind it instead of flooding the server.
    this.maxConcurrentCalls = 16;
    // The concurrency gate, recreated per connection. See `callServer`.
    this.gate = this.newGate(null);
    // The `trame` objects whose client channel is already subscribed to. Weak,
    // because that subscription lives as long as the object and must not be what
    // keeps it alive.
    this.attached = new WeakSet();
  }

  buildInstance() {
    throw new Error("DataclassCore subclasses must implement buildInstance");
  }

  applyState() {
    throw new Error("DataclassCore subclasses must implement applyState");
  }

  instanceFetched() {}

  instanceDiscarded() {}

  graphCompleted() {}

  // A reconnect has replaced the connection and every cache above has been
  // retired. Whatever a subclass is SHOWING has to be fetched again -- a provider
  // cannot notice a reconnect itself, its instance never changed -- and anything
  // not on screen is fetched by whoever next asks for it.
  connectionReplaced() {}

  // Subscribe to a `trame` object's client and to its REPLACEMENTS, and connect
  // whichever client is there now. Idempotent per object.
  //
  // A reconnect does not reconnect a client: it builds a new one and puts it on
  // `trame.client`. Mount is therefore not a reliable signal -- a component that
  // stays mounted across the reconnect never calls `connect` again -- so the
  // channel that reports the identity change is what this listens to.
  attach(trame) {
    if (!trame) return;
    this.connect(trame.client);
    if (this.attached.has(trame)) return;
    const [owner, subscribe] = this.clientChannel(trame);
    if (typeof subscribe !== "function") return;
    this.attached.add(trame);
    subscribe.call(owner, () => this.connect(trame.client));
  }

  // Where "the client may have been replaced" is announced, as `[owner, method]`.
  clientChannel(trame) {
    return [trame, trame.addConnectListener];
  }

  connect(client) {
    if (!client) return;
    // ADOPT a replacement, rather than keeping the first client for the life of
    // the page. A core that kept it goes on asking a dead socket for everything:
    // its session never appears to change, so none of the retirement below ever
    // runs, the publication subscription stays on the retired transport, and a
    // client edit is pushed into a connection nobody is listening to. The view
    // comes back after a reconnect and editing does not.
    this.client = client;
    const session = client.getConnection().getSession();
    if (this.session === session) return;

    const retired = this.session;
    const retiredGate = this.gate;
    if (retired && this.subscription && retired.unsubscribe) {
      try {
        retired.unsubscribe(this.subscription);
      } catch (error) {
        // A closed transport may refuse this; its subscription dies with it.
        console.warn(
          "Dataclass could not release a retired subscription",
          error,
        );
      }
    }
    this.session = session;
    this.gate = this.newGate(session);
    // The session is CAPTURED, not read when the event is delivered: unsubscribing
    // cannot recall a callback that is already queued, and that callback has to be
    // identifiable as retired when it runs.
    this.subscription = session.subscribe(
      "trame.dataclass.publish",
      ([event]) => this.enqueuePublication(event, session),
    );
    if (retired) this.retire(retiredGate);
  }

  // A replaced connection retires every claim the old one made. Finished DATA is
  // not session-scoped -- a snapshot does not become wrong because a socket did --
  // but everything that can still SPEAK for an instance is: the fetches and
  // definition requests in flight, the publication chains, the completeness claim,
  // the concurrency gate and the outbound gate. Two rules cover all of them:
  // fresh work never waits behind retired work, and a late settlement from a
  // retired session writes nothing.
  retire(retiredGate) {
    // Wake everything queued on the retired gate: each one refuses itself at the
    // check in `callServer` and hands the slot on. Nothing else would wake them --
    // wslink does not reject the calls a dead socket swallowed, so the requests
    // ahead of them in that queue may never settle at all.
    retiredGate.queued.splice(0).forEach((resolve) => resolve());
    this.pendingFetch = {};
    this.pendingDefinition = {};
    // Chains, not just entries: an event still waiting on the old transport's
    // child fetch would otherwise hold every fresh event for that instance behind
    // it, with nothing left to settle it.
    this.pendingPublications = {};
    // A class definition belongs to the server that published it. A replacement
    // may be a different process, and a field its schema now calls a dataclass
    // container would otherwise be read with the retired server's shape.
    //
    // `dataTypes` is deliberately KEPT -- it is data, like a snapshot, and the
    // replacement overwrites it on the next fetch. What matters is that the two are
    // read together: `updateServer` refuses to push anything for an instance whose
    // class is not in `typeDefinitions`, so the window where the id names a class
    // nobody can describe is a window where nothing is sent, rather than one where
    // every field looks like an ordinary server field.
    this.typeDefinitions = {};
    // "Complete" is a claim about a graph on a server; the replacement has sent
    // none of it yet, so every graph is walked again.
    this.completeInstances.clear();
    // What the server holds is unknown until it says so again. Keeping it would
    // suppress an edit as redundant against a value only the retired server had.
    this.serverState = {};
    // The outbound gate's batch was handed to a transport whose answer can never
    // arrive, and the new connection is exactly the one that can carry a push the
    // old one lost.
    this.activeFlush = null;
    this.failedPushSession = null;
    this.connectionReplaced();
    if (this.pendingClientServerQueue.length) this.flushToServer();
  }

  // One concurrency gate per connection: a slot held by a request the old
  // transport will never answer must not count against the new one, and a waiter
  // admitted to the retired queue must be woken rather than left hanging there.
  newGate(session) {
    return { session, active: 0, queued: [] };
  }

  // MARKED, not matched on its message: a caller that recovers from this by asking
  // the live connection again has to be able to tell it from a real failure, and a
  // retired session is not one -- nothing was lost and nothing needs reporting.
  retiredError(what) {
    const error = new Error(`Dataclass ${what} belongs to a retired session`);
    error.retiredSession = true;
    return error;
  }

  // Is this rejection the client's own "I have no socket", rather than an answer?
  // wslink rejects a call made while the connection is down with its CLIENT_ERROR
  // code (-32099) and no `data`; a server that ANSWERED with a failure sends its own
  // code (EXCEPTION_ERROR -32001, AUTHENTICATION_ERROR -32000, ...). The difference
  // decides whether resending can possibly help -- see `flushToServer`.
  static CLIENT_ERROR = -32099;

  isTransportFailure(error) {
    return error?.code === DataclassCore.CLIENT_ERROR;
  }

  enqueuePublication(event, session = this.session) {
    // Delivered by a transport this page no longer has: it describes a server
    // that is gone, and unsubscribing could not recall it.
    if (session !== this.session) return;
    const { id } = event;
    // A delta only needs this instance's own state, not the instances it points at.
    const hydration = this.fetchInstance(id);
    // Started before it is known whether this event will still be current when its
    // turn comes. If it is not, nothing awaits it, and a rejection would be
    // reported against the page as an unhandled one.
    hydration.catch(() => {});
    const previous = this.pendingPublications[id] || Promise.resolve();
    const next = previous.then(async () => {
      // Checked on ENTRY is not enough: this body runs behind the instance's
      // existing chain and behind its own hydration, and the connection can be
      // replaced in either gap. An event admitted while the old transport was
      // current must still write nothing once it is not.
      if (session !== this.session) return;
      if (!(await hydration)) return;
      if (session !== this.session) return;
      const { state, revision } = event;
      // The snapshot, or an earlier delta, already holds this one. That includes the
      // publication that announced the instance and started its fetch.
      if (revision <= this.revisions[id]) return;

      // Never commit a reference to a graph that is still arriving: wait for every
      // instance this delta points at, and everything those reach. Fetching never
      // waits on this queue, so a cycle in the graph cannot deadlock here.
      await Promise.all(
        this.referencedInstances(id, state).map((childId) =>
          this.fetchInstanceRecursive(childId),
        ),
      );
      if (session !== this.session) return;

      // A whole asynchronous publication owns the instance until its referenced
      // instances are complete, and the commit below is synchronous. No newer
      // callback can overwrite its cache and then be rolled back.
      encodeState(this.serverState[id], state);
      this.recordReferences(id, state);
      this.applyState(id, state);
      this.revisions[id] = revision;
    });
    // A failed update is reported, but cannot poison all future queue entries.
    const settled = next.catch((error) => {
      console.error(`Dataclass publication failed for ${id}`, error);
    });
    this.pendingPublications[id] = settled;
    settled.then(() => {
      if (this.pendingPublications[id] === settled) {
        delete this.pendingPublications[id];
      }
    });
    return settled;
  }

  isDataClass(id, name) {
    return !!this.typeDefinitions[this.dataTypes[id]]?.dataclass_containers[
      name
    ];
  }

  isClientOnly(id, name) {
    return !!this.typeDefinitions[this.dataTypes[id]]?.client_only[name];
  }

  isDeepReactive(id, name) {
    return !!this.typeDefinitions[this.dataTypes[id]]?.deep_reactive[name];
  }

  // Ids of the instances a delta points at.
  referencedInstances(id, state) {
    return Object.entries(state)
      .filter(([key]) => this.isDataClass(id, key))
      .flatMap(([, value]) => idsOf(value));
  }

  recordReferences(id, state) {
    for (const [key, value] of Object.entries(state)) {
      if (this.isDataClass(id, key)) {
        this.references[id][key] = idsOf(value);
      }
    }
  }

  // Ids of the instances `id` points at now.
  childIds(id) {
    return Object.values(this.references[id] || {}).flat();
  }

  // A client edit. A dataclass field may hold the client's own records; they are
  // sent, and remembered as references, by id.
  updateServer(id, name, value) {
    // Nothing is pushed for an instance whose SHAPE the live connection has not
    // described. Every question this method asks -- is the field client-only, is it
    // a dataclass container -- is answered out of `typeDefinitions`, and a missing
    // schema answers "no" to all of them: between `retire()` and the replacement's
    // `definition.get` landing, a client_only field would be sent to the server for
    // the first time in its life. Refusing is the safe direction, and it costs
    // nothing real: the re-hydration that follows a reconnect refreshes these cells
    // from the authoritative snapshot, so a value pushed from inside that window is
    // one the user is about to stop seeing anyway.
    if (!this.typeDefinitions[this.dataTypes[id]]) return;
    if (this.isClientOnly(id, name)) return;
    if (this.isDataClass(id, name)) {
      value = serializeDataClass(value);
      (this.references[id] ||= {})[name] = idsOf(value);
    }
    this.pendingClientServerQueue.push([id, name, value]);
    this.flushToServer();
  }

  async flushToServer() {
    const session = this.session;
    // The gate has an OWNER, so a gate held by a retired session is simply not
    // this session's gate and does not hold a fresh edit back.
    if (this.activeFlush && this.activeFlush.session === session) {
      return;
    }
    const flush = { session };
    this.activeFlush = flush;
    // Edits queued while a request was in flight: the last value of each field
    // wins, and a field whose value the server already holds is not sent. Comparing
    // each edit in turn instead would drop X -> Y -> X as "X is already there"
    // while still sending Y.
    const msg = {};
    const sent = this.pendingClientServerQueue.splice(0);
    for (const [id, name, value] of sent) {
      (msg[id] ||= {})[name] = value;
    }
    let sendingSomething = 0;
    const rollback = {};
    for (const [id, fields] of Object.entries(msg)) {
      const known = (this.serverState[id] ||= {});
      for (const [name, value] of Object.entries(fields)) {
        const encoded = JSON.stringify([value]);
        if (known[name] === encoded) {
          delete fields[name];
        } else {
          (rollback[id] ||= {})[name] = known[name];
          known[name] = encoded;
          sendingSomething++;
        }
      }
      if (!Object.keys(fields).length) delete msg[id];
    }
    if (sendingSomething) {
      try {
        await session.call("trame.dataclass.state.update", [msg]);
      } catch (error) {
        // What a failed push means depends on WHY it failed, and the three cases
        // want three different things. The cache is rolled back in two of them,
        // because it says "the server already holds this" and in both it does not;
        // the QUEUE is only restored when resending can actually help.
        const restoreCache = () => {
          for (const [id, fields] of Object.entries(rollback)) {
            for (const [name, previous] of Object.entries(fields)) {
              if (previous === undefined) {
                delete this.serverState[id][name];
              } else {
                this.serverState[id][name] = previous;
              }
            }
          }
        };
        // ...and the cache is only half of it: the VIEW still shows what the user
        // typed, which nobody holds. Put the server's own value back where there is
        // one, through `applyState` -- the same server-origin path a publication
        // takes, so a client that distinguishes the two (React's `setField` versus
        // `userSetField`) treats this as what it is.
        //
        // What keeps that write from bouncing straight back out is the CACHE, not
        // the order of these two calls: Vue's outbound watcher wakes a tick later
        // and finds the restored value already there, so its echo is dropped as
        // redundant. Measured: skip `restoreCache` and the Vue suite does not merely
        // fail, it RUNS AWAY -- the echo is sent, refused, reverted, echoed again,
        // and the file times out. React never reaches `updateServer` at all from
        // this path.
        const revertView = () => {
          for (const [id, fields] of Object.entries(rollback)) {
            if (!this.serverState[id]) continue;
            const held = {};
            for (const [name, previous] of Object.entries(fields)) {
              // No previous value is no value to show: that field was not in the
              // cache, so there is nothing to revert TO and inventing one would be
              // worse than leaving what the user typed.
              if (previous === undefined) continue;
              // A field the user has edited AGAIN since this batch left is not
              // reverted. That newer edit is both what they are looking at and what
              // the next flush sends; replacing it with an older server value would
              // undo a keystroke the server has not even been told about yet.
              if (
                this.pendingClientServerQueue.some(
                  ([queuedId, queuedName]) =>
                    queuedId === id && queuedName === name,
                )
              ) {
                continue;
              }
              held[name] = JSON.parse(previous)[0];
            }
            if (!Object.keys(held).length) continue;
            this.recordReferences(id, held);
            this.applyState(id, held);
          }
        };
        if (this.session !== session) {
          // RETIRED before it settled: the outcome is unknowable and the
          // replacement's snapshot is authoritative for what the server holds.
          // Rolling the cache back would make a NEWER edit look redundant against
          // a stale value, and re-queueing would push the dead transport's values
          // over the live one -- both lose the user's latest intent.
          console.error(
            "Dropping a state update that belonged to a retired session",
            error,
          );
        } else if (this.isTransportFailure(error)) {
          // The CLIENT refused to send: there is no socket. The outcome is known --
          // the server did not get it -- and an edit is acknowledged by the SERVER,
          // not by a socket having accepted it, so leaving the cache saying "already
          // sent" is how a value the user typed disappears with no request and no
          // error. Put the cache and the queue back; it goes out on the next
          // connection.
          restoreCache();
          this.pendingClientServerQueue.unshift(...sent);
          this.failedPushSession = session;
          console.error("Network error when pushing client state", error);
        } else {
          // The SERVER answered, with a failure. Re-queueing here is how one
          // refused field poisons the page: the batch goes back at the head of the
          // queue, every later edit of every instance is merged into it, and the
          // server refuses the merged batch for the same reason -- so nothing is
          // ever sent again until a reconnect. Drop the batch, as upstream does,
          // and roll the cache back so an identical edit can be sent again rather
          // than suppressed as redundant against a value the server never took.
          //
          // This is also the one case where the refusal is FINAL -- there is no
          // resend coming -- so it is the one case where the view has to be told:
          // otherwise the control keeps showing a value the server rejected, and
          // the next thing that refreshes it silently changes it back.
          restoreCache();
          revertView();
          console.error(
            "The server refused a state update; dropping that batch",
            error,
          );
        }
      }
    }

    // Only the flush that still owns the gate may open it.
    if (this.activeFlush === flush) this.activeFlush = null;
    if (
      this.pendingClientServerQueue.length &&
      this.failedPushSession !== this.session
    ) {
      // ...but never spin against a connection that is still down. The held queue
      // goes out when `retire` sees a new one.
      this.flushToServer();
    }
  }

  // Every fetch goes through here, so at most `maxConcurrentCalls` requests are in
  // flight. A slot is held for one request only, never while waiting on another, so
  // this cannot deadlock. An `urgent` request skips the queue: a class definition
  // unblocks every instance of its class.
  //
  // The gate and the call both belong to ONE connection: a request still queued
  // when the connection was replaced refuses itself rather than being issued on a
  // transport its caller never asked for.
  async callServer(method, args, urgent = false) {
    const gate = this.gate;
    if (gate.active < this.maxConcurrentCalls) {
      gate.active++;
    } else {
      // A finishing call hands its slot straight over, so none is taken twice.
      await new Promise((resolve) =>
        urgent ? gate.queued.unshift(resolve) : gate.queued.push(resolve),
      );
    }
    try {
      if (gate.session !== this.session) throw this.retiredError(method);
      return await gate.session.call(method, args);
    } finally {
      const next = gate.queued.shift();
      if (next) {
        next();
      } else {
        gate.active--;
      }
    }
  }

  // One instance: its state, its class definition and its client representation.
  // Resolves to whether the server knows it. The instances it points at are started,
  // never awaited, so this never waits on another instance and no cycle in the graph
  // can deadlock it.
  async fetchInstance(id) {
    if (this.pendingFetch[id]) {
      return await this.pendingFetch[id];
    }
    const session = this.session;
    const pending = (async () => {
      const data = await this.callServer("trame.dataclass.state.get", [id]);
      // A reply that was already on the wire when the connection was replaced
      // describes a server this page no longer talks to: it must not be built
      // into an instance the fresh session is in the middle of fetching.
      if (session !== this.session) throw this.retiredError(`fetch of ${id}`);
      if (data.state === null) {
        // Not cached: the instance may exist by the time someone asks again.
        if (this.pendingFetch[id] === pending) delete this.pendingFetch[id];
        return false;
      }
      if (!this.typeDefinitions[data.definition]) {
        await this.fetchDefinition(data.definition);
        if (session !== this.session) throw this.retiredError(`fetch of ${id}`);
      }

      this.dataTypes[id] = data.definition;
      this.serverState[id] = encodeState({}, data.state);
      this.references[id] = {};
      this.recordReferences(id, data.state);
      this.buildInstance(id, data.state);
      this.revisions[id] = data.revision;
      this.instanceFetched(id);

      // Whoever needs these complete waits with `fetchInstanceRecursive`, which
      // also surfaces a failure and retries it.
      for (const childId of this.childIds(id)) {
        this.fetchInstance(childId).catch(() => {});
      }
      return true;
    })().catch((error) => {
      // Forget the failed attempt, so the next request for this id starts over
      // instead of every later caller re-awaiting the same rejection -- but only
      // if it is still the attempt that owns this id. A retired session's failure
      // must not evict the fresh session's fetch, which would then go out twice
      // and discard whatever the first one had already built.
      if (this.pendingFetch[id] === pending) {
        delete this.pendingFetch[id];
        delete this.dataTypes[id];
        delete this.serverState[id];
        delete this.references[id];
        this.instanceDiscarded(id);
      }
      throw error;
    });
    this.pendingFetch[id] = pending;
    return await pending;
  }

  // `id` and every instance it reaches, one level of the graph at a time: each level
  // is fetched in parallel, and a cycle is only an instance already seen. A complete
  // instance stays complete, because a publication never commits a reference before
  // its target is complete, so it is not walked again. Resolves to whether the
  // server knows `id`.
  async fetchInstanceRecursive(id) {
    if (this.completeInstances.has(id)) {
      return true;
    }
    const session = this.session;
    if (!(await this.fetchInstance(id))) {
      return false;
    }
    const seen = new Set([id]);
    let level = [id];
    while (level.length) {
      await Promise.all(level.map((levelId) => this.fetchInstance(levelId)));
      const next = [];
      for (const parentId of level) {
        for (const childId of this.childIds(parentId)) {
          if (!seen.has(childId) && !this.completeInstances.has(childId)) {
            seen.add(childId);
            next.push(childId);
          }
        }
      }
      level = next;
    }
    // Completeness is a claim about the connection the walk ran on.
    if (session !== this.session) throw this.retiredError(`graph of ${id}`);
    // An id the server does not know is not an instance, complete or otherwise.
    const completed = [...seen].filter((seenId) => this.serverState[seenId]);
    completed.forEach((completedId) => this.completeInstances.add(completedId));
    this.graphCompleted(completed);
    return true;
  }

  async fetchDefinition(id) {
    // `typeDefinitions[id]` is only set once the reply lands, so every instance of a
    // class hydrating at the same time saw it missing and asked again: a wave of N
    // instances of one class cost N definition requests. Share the in-flight promise.
    if (this.pendingDefinition[id]) {
      return await this.pendingDefinition[id];
    }
    const pending = this.callDefinition(id).catch((error) => {
      // Conditional, so a failure cannot evict a request that replaced it.
      if (this.pendingDefinition[id] === pending) {
        delete this.pendingDefinition[id];
      }
      throw error;
    });
    this.pendingDefinition[id] = pending;
    return await pending;
  }

  async callDefinition(id) {
    const session = this.session;
    const data = await this.callServer(
      "trame.dataclass.definition.get",
      [id],
      true,
    );
    // A retired session does not get to describe this page's classes: installing
    // its schema over the live one turns a field the live server calls a dataclass
    // container back into a raw id string that nothing hydrates.
    if (session !== this.session) throw this.retiredError(`definition ${id}`);
    this.typeDefinitions[id] = {
      ...data,
      dataclass_containers: toSet(data.dataclass_containers),
      client_only: toSet(data.client_only),
      deep_reactive: toSet(data.deep_reactive),
    };
  }
}
