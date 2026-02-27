import pytest

from trame_dataclass.v2 import (
    ServerOnly,
    StateDataModel,
    Sync,
    TypeValidation,
    get_instance,
)


def test_input_validation():
    class BasicTypeValidation(StateDataModel):
        a = ServerOnly(int, 0, type_checking=TypeValidation.STRICT)
        b = ServerOnly(float, 0.0, type_checking=TypeValidation.STRICT)
        c = ServerOnly(str, "", type_checking=TypeValidation.STRICT)
        d = ServerOnly(dict, dict, type_checking=TypeValidation.STRICT)
        e = ServerOnly(list[int], list, type_checking=TypeValidation.STRICT)
        f = ServerOnly(set, set, type_checking=TypeValidation.STRICT)
        g = ServerOnly(str, "", type_checking=TypeValidation.SKIP)
        h = ServerOnly(str, "", type_checking=TypeValidation.WARNING)

    data = BasicTypeValidation()
    data.a = 1
    data.b = 1.1
    data.c = "hello"
    data.d = {"a": 1}
    data.e = [1, 2, 3]
    data.f = {"a", "b", "c"}
    data.g = 5
    data.h = 5

    with pytest.raises(TypeError):
        data.a = 1.2

    with pytest.raises(TypeError):
        data.b = 5

    with pytest.raises(TypeError):
        data.c = 0

    with pytest.raises(TypeError):
        data.d = []

    with pytest.raises(TypeError):
        data.e = {}

    with pytest.raises(TypeError):
        data.f = []


def test_serialization():
    class Dummy(StateDataModel):
        a = Sync(int, 0)

    class BasicSerial(StateDataModel):
        a = Sync(int, 123)
        b = Sync(Dummy, has_dataclass=True)
        c = Sync(list[Dummy], list, has_dataclass=True)
        d = Sync(dict[str, Dummy], dict, has_dataclass=True)
        e = Sync(set, set)
        f = Sync(set, set, has_dataclass=True)

    data = BasicSerial()
    data.b = Dummy()
    data.c = [Dummy(), Dummy()]
    data.d = {"a": Dummy(), "b": Dummy()}
    data.e = {"a", "b", "c"}
    data.f = {Dummy(), Dummy(), Dummy()}

    state = data.client_state

    assert state.get("a") == 123
    assert state.get("b") == data.b._id
    assert state.get("c") == [i._id for i in data.c]
    assert state.get("d") == {k: v._id for k, v in data.d.items()}

    set_as_list = state.get("e")
    assert isinstance(set_as_list, list)
    assert set(set_as_list) == {"a", "b", "c"}

    set_as_list = state.get("f")
    assert isinstance(set_as_list, list)
    for obj in data.f:
        assert obj._id in set_as_list


def test_get_instance():
    class Dummy(StateDataModel):
        a = Sync(int, 0)

    inst = Dummy()
    assert get_instance(inst._id) is inst
    assert get_instance("not an id") is None
