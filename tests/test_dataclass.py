from contextlib import suppress
from pathlib import Path

import pytest

from trame_dataclass.core import (
    NonSerializableType,
    is_trame_dataclass,
    trame_dataclass,
)


def test_json_friendly_data():
    @trame_dataclass
    class Basic:
        id: str
        name: str | None
        age: int = 42
        account_balance: float
        alive: bool

    @trame_dataclass
    class Complex:
        basic: Basic

    @trame_dataclass
    class Composite:
        array: list
        numbers: list[int]
        objs: list[Basic]

    obj_1 = Basic()
    obj_2 = Complex()

    assert obj_1._id == "1"
    assert obj_2._id == "2"
    # obj_1.flush() # can only be done with a server
    print(obj_1)
    print(obj_2)
    assert is_trame_dataclass(Basic)
    assert is_trame_dataclass(obj_1)
    assert is_trame_dataclass(obj_2)


def test_complex_type():
    with suppress(NonSerializableType):

        @trame_dataclass
        class ErrorData:
            path: Path

        pytest.fail("Should trigger a NonSerializableType exception")


if __name__ == "__main__":
    test_json_friendly_data()
    test_complex_type()
