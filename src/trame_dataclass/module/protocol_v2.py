import weakref
from copy import deepcopy

from wslink import register as export_rpc
from wslink.websocket import LinkProtocol

from trame_dataclass.v2 import StateDataModel, get_instance


def compute_definition(trame_dataclass_class, server_to_use=None):
    """Build the class definition dict sent to the client when a model is registered.

    The dict includes the class name, lists of dataclass-container fields, client-only
    fields, deep-reactive fields, and the auto-generated GUI template string.
    """
    client_only = getattr(trame_dataclass_class, "CLIENT_ONLY_NAMES", [])

    return {
        "name": trame_dataclass_class.__name__,
        "dataclass_containers": list(trame_dataclass_class.DATACLASS_NAMES),
        "client_only": list(client_only),
        "deep_reactive": list(trame_dataclass_class.CLIENT_DEEP_REACTIVE),
        "template": trame_dataclass_class.generate_gui(server_to_use),
    }


class TrameDataclassProtocol(LinkProtocol):
    """wslink protocol that exposes the trame-dataclass RPC endpoints to the client.

    Tracks registered class definitions (shared across instances of the same class) and
    wires each ``StateDataModel`` instance to push state deltas over the WebSocket when
    its fields change.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.class_definitions = {}
        self.next_class_definition_id = 1
        # Revisions belong to live model instances and are keyed by the instance's
        # own ``_id``, not by the instance: keying by instance would require every
        # ``StateDataModel`` subclass to be hashable (a subclass defining ``__eq__``
        # without ``__hash__`` is not), and two equal-but-distinct models would share
        # one revision row. ``_id`` comes from a monotonic counter, so unlike ``id()``
        # it is never reused by a later instance.
        self.state_revisions = {}

    @export_rpc("trame.dataclass.register")
    def register_instance(self, trame_dataclass):
        """Register a model instance: ensure its class definition exists and wire up flushing."""
        if isinstance(trame_dataclass, StateDataModel):
            self.register_definition(trame_dataclass.__class__)
            trame_dataclass.register_flush_implementation(self.push_delta)

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

    def register_definition(self, trame_dataclass_class):
        """Register a model class definition, returning the existing one if already known."""
        if not issubclass(trame_dataclass_class, StateDataModel):
            return None

        if trame_dataclass_class in self.class_definitions:
            return self.class_definitions[trame_dataclass_class]

        definition_id = self.next_class_definition_id
        self.next_class_definition_id += 1

        definition = {
            "id": definition_id,
            **compute_definition(trame_dataclass_class, self.coreServer.server),
        }
        self.class_definitions[trame_dataclass_class] = definition

        return definition

    @export_rpc("trame.dataclass.definition.get")
    def get_definition(self, class_id):
        """Return the class definition dict for the given numeric class ID."""
        for definition in self.class_definitions.values():
            if definition["id"] == class_id:
                return definition
        return None

    @export_rpc("trame.dataclass.state.get")
    def get_state(self, instance_id):
        """
        {
            id: instance_id,
            definition: class_id,
            state: {},
        }
        """
        obj = get_instance(instance_id)
        if obj is None:
            return {
                "id": instance_id,
                "state": None,
            }

        return {
            "id": instance_id,
            "definition": self.class_definitions[obj.__class__]["id"],
            # The reply may be serialized after another publication. Freeze its
            # contents so the revision describes this snapshot, not a mutable cache.
            "state": deepcopy(obj.client_state),
            "revision": self.state_revisions.get(obj._id, 0),
        }

    @export_rpc("trame.dataclass.state.update")
    def update_state(self, msg):
        """Apply a client-originated partial state update to the matching server instances.

        *msg* maps instance IDs to partial state dicts.
        """
        for dc_id, state in msg.items():
            obj = get_instance(dc_id)
            if obj is not None:
                obj.update_from_client_state(state)

    def push_delta(self, msg):
        """Publish a state delta to all connected clients via the ``trame.dataclass.publish`` topic."""
        obj = get_instance(msg["id"])
        if obj is None:
            self.publish("trame.dataclass.publish", msg)
            return
        key = self._track_revisions(obj)
        revision = self.state_revisions[key] + 1
        self.state_revisions[key] = revision
        self.publish("trame.dataclass.publish", {**deepcopy(msg), "revision": revision})
