from trame_dataclass.v2 import (
    ServerOnly,
    StateDataModel,
)


class MixFields(StateDataModel):
    integer = ServerOnly(int, type_checking="ignore")
    number = ServerOnly(float)


fields = MixFields()
fields.integer = 1
fields.number = 1
fields.integer = 1.2
fields.number = 1.2
