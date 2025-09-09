from wslink import register as export_rpc
from wslink.websocket import LinkProtocol

from trame_dataclass.core import StateDataModel, get_instance


def compute_definition(trame_dataclass_class):
    return {
        "name": trame_dataclass_class.__name__,
        "dataclass_containers": [
            f.name
            for f in trame_dataclass_class._FIELDS.values()
            if f.dataclass_container
        ],
    }


class TrameDataclassProtocol(LinkProtocol):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

        self.class_definitions = {}
        self.next_class_definition_id = 1

    @export_rpc("trame.dataclass.register")
    def register_instance(self, trame_dataclass):
        if isinstance(trame_dataclass, StateDataModel):
            self.register_definition(trame_dataclass.__class__)
            trame_dataclass.register_flush_implementation(self.push_delta)

    def register_definition(self, trame_dataclass_class):
        if not issubclass(trame_dataclass_class, StateDataModel):
            return None

        if trame_dataclass_class in self.class_definitions:
            return self.class_definitions[trame_dataclass_class]

        definition_id = self.next_class_definition_id
        self.next_class_definition_id += 1

        definition = {
            "id": definition_id,
            **compute_definition(trame_dataclass_class),
        }
        self.class_definitions[trame_dataclass_class] = definition

        return definition

    @export_rpc("trame.dataclass.definition.get")
    def get_definition(self, class_id):
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
            "state": obj.client_state,
        }

    @export_rpc("trame.dataclass.state.update")
    def update_state(self, msg):
        # print("update_state", msg)
        for dc_id, state in msg.items():
            obj = get_instance(dc_id)
            fields = obj._FIELDS
            if obj is not None:
                for k, v in state.items():
                    field = fields.get(k)
                    if field.decoder:
                        setattr(obj, k, field.decoder(v))
                    else:
                        setattr(obj, k, v)

    def push_delta(self, msg):
        # print("publish", msg)
        self.publish("trame.dataclass.publish", msg)
