import asyncio
from contextlib import suppress
from pathlib import Path

import pytest
from trame_server.core import Server

from trame_dataclass.core import (
    NonSerializableType,
    StateDataModel,
)


def test_json_friendly_data():
    class Basic(StateDataModel):
        id: str
        name: str | None
        age: int = 42
        account_balance: float
        alive: bool

    class Complex(StateDataModel):
        basic: Basic

    class Composite(StateDataModel):
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
    assert issubclass(Basic, StateDataModel)
    assert isinstance(obj_1, StateDataModel)
    assert isinstance(obj_2, StateDataModel)


def test_complex_type():
    with suppress(NonSerializableType):

        class ErrorData(StateDataModel):
            path: Path

        pytest.fail("Should trigger a NonSerializableType exception")


def test_watch():
    server = Server()
    watch_exec_count = 0
    watch_count_expect = None

    class TestWatch(StateDataModel):
        count: int = 1
        a: str | None
        b: str | None = "b"

    data = TestWatch(server)

    # initial value
    assert data.count == 1
    assert data.a is None
    assert data.b == "b"

    # watch callback
    def watch_callback(count):
        nonlocal watch_exec_count
        watch_exec_count += 1
        print("watch_callback", watch_exec_count)
        assert watch_count_expect == count, (
            "callback execution (expect, actual exec count)"
        )

    # test eager
    print("test eager")
    watch_count_expect = 1
    unwatch = data.watch(("count",), watch_callback, sync=True, eager=True)
    assert watch_exec_count == 1

    # test sync
    print("test sync")
    watch_count_expect = 2
    data.count += 1
    assert watch_exec_count == 2

    # test other field modification
    print("test other field", watch_exec_count)
    data.a = "a"
    print(f"{watch_exec_count=}")
    assert watch_exec_count == 2
    print("test watch again")
    watch_count_expect = 3
    data.count += 1
    assert watch_exec_count == 3
    watch_count_expect = 4
    data.count += 1
    assert watch_exec_count == 4

    # test unwatch
    print("test unwatch")
    unwatch()
    data.count += 1
    assert watch_exec_count == 4


def test_gc():
    server = Server()
    instance_count = 0

    class TestDel(StateDataModel):
        count: int = 1

        def __del__(self):
            nonlocal instance_count
            instance_count -= 1

    instance_count += 1
    data = TestDel(server)
    assert data
    assert instance_count == 1
    data = None
    assert instance_count == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "wait_time",
    [
        pytest.param(
            0,
            marks=pytest.mark.xfail(
                strict=True, reason="Need to allow time for watch task execution"
            ),
            id="known_issue_for_async_exec",
        ),
        0.0001,
    ],
)
async def test_async_watch(wait_time):
    print("+" * 120)
    print(f"test_async_watch({wait_time})")
    server = Server()
    watch_exec_count = 0
    watch_count_expect = None

    class TestWatch(StateDataModel):
        count: int = 1
        a: str | None
        b: str | None = "b"

    data = TestWatch(server)

    # initial value
    assert data.count == 1
    assert data.a is None
    assert data.b == "b"

    # ensure completed initialization
    await data.completion()

    # watch callback (make it async to ensure support)
    async def watch_callback(count):
        nonlocal watch_exec_count
        nonlocal watch_count_expect
        await asyncio.sleep(0.1)
        watch_exec_count += 1
        print(f"callback: {watch_exec_count=}")
        print(f"callback::assert {watch_count_expect=} == {count=}")
        assert watch_count_expect == count, "callback execution"

    # test eager
    print("=" * 60)
    print("test eager")
    print("=" * 60)
    watch_count_expect = 0
    unwatch = data.watch(("count",), watch_callback)
    assert watch_exec_count == 0, "Eager watch execution"
    if wait_time > 0:
        await data.completion()
    assert watch_exec_count == 0, "async First state on watch"

    # test edit
    print("=" * 60)
    print("test edit")
    print("=" * 60)
    watch_count_expect = 2
    assert data.count == 1, "data.count (1)"
    data.count += 1
    assert data.count == 2, "data.count (2)"
    if wait_time > 0:
        await data.completion()
    assert watch_exec_count == 1, "watch execution"

    # test other field modification
    print("=" * 60)
    print("test other field")
    print("=" * 60)
    data.a = "a"
    assert watch_exec_count == 1, "no watch execution"
    assert data.count == 2, "data.count (2)"
    print("=" * 60)
    print("test watch again")
    print("=" * 60)
    watch_count_expect = 3
    assert data.count == 2, "data.count (2)"
    data.count += 1
    assert data.count == 3, "data.count (3)"
    if wait_time > 0:
        await data.completion()
    assert watch_exec_count == 2, "change watch execution"
    watch_count_expect = 4
    assert data.count == 3, "data.count (3)"
    data.count += 1
    assert data.count == 4, "data.count (4)"
    if wait_time > 0:
        await data.completion()
    assert watch_exec_count == 3, "another change watch execution"

    # test unwatch
    print("=" * 60)
    print("test unwatch")
    print("=" * 60)
    unwatch()
    assert data.count == 4, "data.count (4)"
    data.count += 1
    assert data.count == 5, "data.count (5)"
    if wait_time > 0:
        await data.completion()
    assert watch_exec_count == 3, "No more watch"
    print("=" * 60)
