import weakref
from copy import deepcopy


class RevisionsMixin:
    """Per-instance revisions, shared by the v1 and v2 protocols.

    Every state snapshot and every published delta carries the revision of the instance
    it describes, so the client can drop a delta its snapshot already contains instead of
    rolling the value back. A protocol lists this mixin before ``LinkProtocol`` and sets
    ``find_instance`` to the lookup of its own model registry.
    """

    find_instance = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Revisions belong to live model instances and are keyed by the instance's
        # own ``_id``, not by the instance: keying by instance would require every
        # ``StateDataModel`` subclass to be hashable (a subclass defining ``__eq__``
        # without ``__hash__`` is not), and two equal-but-distinct models would share
        # one revision row. ``_id`` comes from a monotonic counter, so unlike ``id()``
        # it is never reused by a later instance.
        self.state_revisions = {}

    def _track_revisions(self, obj):
        """The revision key for *obj*, with the weak lifetime the table used to get free.

        A ``finalize`` and not a ``__del__`` hook: it fires when the model is collected,
        it does not keep the model alive, and the registry holds it for us. Retired
        geometry therefore leaves no row behind -- which is the property
        ``test_revision_bookkeeping_does_not_retain_a_deleted_model`` pins.
        """
        key = obj._id
        if key not in self.state_revisions:
            self.state_revisions[key] = 0
            weakref.finalize(obj, self.state_revisions.pop, key, None)
        return key

    def snapshot(self, obj):
        """The client state of *obj*, and the revision it is at."""
        return {
            # The reply may be serialized after another publication. Freeze its
            # contents so the revision describes this snapshot, not a mutable cache.
            "state": deepcopy(obj.client_state),
            "revision": self.state_revisions.get(obj._id, 0),
        }

    def push_delta(self, msg):
        """Publish a state delta to all connected clients via the ``trame.dataclass.publish`` topic."""
        # Only a live model flushes, and every model registers itself on creation, so
        # its id always resolves and every publication carries a revision.
        key = self._track_revisions(self.find_instance(msg["id"]))
        revision = self.state_revisions[key] + 1
        self.state_revisions[key] = revision
        self.publish("trame.dataclass.publish", {**deepcopy(msg), "revision": revision})
