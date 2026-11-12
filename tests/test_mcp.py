"""Models as agents (MCP) see them, through trame-server's object tools."""

import asyncio
import gc
import itertools
import json
import logging
from typing import Annotated

import pytest
from trame_common.decorators import mcp
from trame_common.obj.mcp import Constructor

from trame.app import TrameComponent, get_server
from trame_dataclass.v2 import (
    ClientOnly,
    ServerOnly,
    StateDataModel,
    Sync,
    watch,
)

_counter = itertools.count()


@pytest.fixture
def server():
    server = get_server(f"test_dataclass_mcp_{next(_counter)}")
    server.mcp.enabled = True
    return server


def rpc(rpc_id, name, arguments):
    return {
        "jsonrpc": "2.0",
        "id": rpc_id,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }


async def call(server, name, **arguments):
    """``(value, is_error)`` of a tools/call, as an agent reads it."""
    response = await server.mcp.protocol.handle(rpc(1, name, arguments))
    result = response["result"]
    text = result["content"][0]["text"] if result["content"] else None
    try:
        value = json.loads(text) if text is not None else None
    except json.JSONDecodeError:
        value = text
    return value, bool(result.get("isError"))


async def ok(server, name, **arguments):
    value, error = await call(server, name, **arguments)
    assert not error, value
    return value


def read(reply):
    """The object a reply's result refers to, as its entry plus its id."""
    obj_id = reply["result"]["id"]
    return {"id": obj_id, **reply["objects"][obj_id]}


async def fails(server, name, **arguments):
    value, error = await call(server, name, **arguments)
    assert error, value
    return value


# -----------------------------------------------------------------------------
# Models (agent-facing type names are process-wide: keep them unique)
# -----------------------------------------------------------------------------


class Label(StateDataModel, mcp={"all_fields": True, "constructor": "default"}):
    """A text label in the scene. It follows the camera."""

    text = Sync(str, "")
    position = Sync(
        tuple[float, float, float],
        (0.0, 0.0, 0.0),
        mcp="[x, y, z] in world coordinates",
    )
    hint = ClientOnly(str, "")
    cache = ServerOnly(dict, dict)


class Layer(StateDataModel):
    opacity = Sync(float, 1.0, mcp={"schema": {"minimum": 0, "maximum": 1}})
    path = ServerOnly(
        str, mcp={"read_only": True, "description": "File it was loaded from"}
    )
    cache = ServerOnly(dict)

    @mcp.property
    def point_count(self) -> int:
        return 42


class Scene(StateDataModel):
    """Everything the viewers show."""

    layers = Sync(list[Layer], list, has_dataclass=True, mcp={"read_only": True})
    labels = Sync(list[Label], list, has_dataclass=True, mcp=True)
    title = Sync(str, "")  # unmarked, and no keyword: hidden
    focus = Sync(Label, None, has_dataclass=True)  # unmarked reference: hidden

    @mcp.method(requires="files")
    def load_file(self, path: str) -> Layer:
        """Load a file as a new layer."""
        layer = Layer(self.server, path=path)
        self.layers = [*self.layers, layer]
        return layer

    @mcp.method
    def add_label(self, label: Label) -> None:
        """Show a label."""
        if label in self.labels:
            msg = f"{label.text} is already shown"
            raise ValueError(msg)
        self.labels = [*self.labels, label]

    @mcp.method(read_only=True)
    def count(self) -> int:
        return len(self.labels)

    def unmarked(self): ...


class Note(Label):
    """A label with a body."""

    body = Sync(str, "")


class Hidden(Label, mcp=False):
    pass


class Station(StateDataModel):
    name = Sync(str, "", mcp=True)

    @mcp.constructor
    @classmethod
    def create(cls, server, name: str) -> "Station":
        """A station named so."""
        return cls(server, name=f"station {name}")


class Substation(Station):
    """Inherits the constructor, called with its own class."""


class Closed(Station, mcp={"constructor": False}):
    pass


class Archive(Station):
    @mcp.constructor(requires="files")
    @classmethod
    def load(cls, server, path: str) -> "Archive":
        """An archive read from a file."""
        return cls(server, name=path)


class Picky(StateDataModel, mcp={"all_fields": True, "constructor": "default"}):
    value = Sync(int, 0)

    def __init__(self, server, value):
        super().__init__(server, value=value)


# A graph with cycles: plugs point back at their box, wires at their plug
class Wire(StateDataModel, mcp=True):
    source = Sync("Plug", None, has_dataclass=True)


class Plug(StateDataModel, mcp=True):
    owner = Sync("Box", None, has_dataclass=True)
    wires = Sync(list[Wire], list, has_dataclass=True)
    note = Sync(str, "")


class Box(StateDataModel, mcp=True):
    label = Sync(str, "")
    plugs = Sync(list[Plug], list, has_dataclass=True)


class Dial(StateDataModel):
    """Marked only by a field's mcp=True."""

    value = Sync(int, 0, mcp=True)
    hidden = Sync(int, 0)


class Thermostat(StateDataModel, mcp=True):
    target = Sync(int, 20)
    heating = ClientOnly(bool, False)

    @watch("target")
    def _on_target(self, target):
        self.heating = target > 20

    @mcp.method
    def warm_up(self) -> int:
        self.target += 2
        return self.target


class Hub(TrameComponent):
    """A component holding models."""

    def __init__(self, server, scene):
        super().__init__(server)
        self._scene = scene

    @mcp.property
    def scene(self) -> Scene:
        return self._scene


# -----------------------------------------------------------------------------
# Declarations
# -----------------------------------------------------------------------------


def test_fields_as_agents_see_them():
    fields = Label._mcp_fields()
    assert fields["text"].options == {"read_only": False}  # Sync
    assert fields["hint"].options == {"read_only": True}  # ClientOnly
    assert fields["cache"].options is None  # ServerOnly: only when marked
    assert fields["position"].options == {
        "description": "[x, y, z] in world coordinates",
        "read_only": False,
    }
    scene = Scene._mcp_fields()
    assert scene["labels"].holds_objects is True
    assert scene["focus"].nullable is True
    assert scene["focus"].options is None  # unmarked
    assert Label._mcp_constructor() == Constructor(attr=None)
    assert "missing a required argument: 'value'" in Picky._mcp_constructor().problem


def test_a_nullable_field_keeps_its_description(server):
    class Memo(StateDataModel, mcp=True):
        text = Sync(Annotated[str, "What the memo says"], None)

    text = server.mcp.describe(Memo)["properties"]["text"]
    assert text["description"] == "What the memo says"
    assert text["anyOf"] == [{"type": "string"}, {"type": "null"}]


def test_fields_come_in_definition_order():
    class Ordered(StateDataModel):
        zeta = Sync(int, 0)
        alpha = ServerOnly(int, 0)
        mid = ClientOnly(int, 0)

    class More(Ordered):
        beta = Sync(int, 0)
        zeta = Sync(int, 1)  # redeclared: keeps its place

    assert list(More._mcp_fields()) == ["zeta", "alpha", "mid", "beta"]


def test_redeclared_fields_keep_their_options():
    class Shape(StateDataModel, mcp=True):
        shape = ClientOnly(str, "", mcp="Object shape")
        items = Sync(list[str], list, mcp={"read_only": True})
        secret = Sync(str, "", mcp=False)

    class Cone(Shape):
        shape = ClientOnly(str, "cone")
        items = Sync(list[str], lambda: ["a"])
        secret = Sync(str, "s")

    fields = Cone._mcp_fields()
    assert fields["shape"].options == {"description": "Object shape", "read_only": True}
    assert fields["items"].options == {"read_only": True}
    assert fields["secret"].options is False


def test_field_options_are_checked():
    with pytest.raises(ValueError, match="must state read_only"):
        ServerOnly(str, mcp=True)
    with pytest.raises(ValueError, match="must state read_only"):
        ServerOnly(str, mcp="described")
    with pytest.raises(ValueError, match="unknown options"):
        Sync(str, mcp={"hidden": True})
    with pytest.raises(TypeError):
        Sync(str, mcp=3)
    assert Sync(str, mcp=False)._mcp is False
    assert ServerOnly(str, mcp={"read_only": False})._mcp == {"read_only": False}


def test_class_options_are_checked():
    with pytest.raises(ValueError, match="has no property 'nope'"):

        class Typo(StateDataModel, mcp={"properties": ["nope"]}):
            a = Sync(int, 0)

    with pytest.raises(ValueError, match="ServerOnly field: listing it requires"):

        class Unstated(StateDataModel, mcp={"properties": ["secret"]}):
            secret = ServerOnly(int, 0)

    with pytest.raises(ValueError, match="not a classmethod"):

        class NoCtor(StateDataModel, mcp={"constructor": "build"}):
            a = Sync(int, 0)

            def build(self): ...


def test_mcp_describe_returns_the_options():
    options = Label.mcp_describe()
    assert options["declared"] is True
    assert options["all_fields"] is True
    assert options["constructor"] == {"name": "default"}
    assert options["description"] is None  # the docstring is the server's default
    assert Scene.mcp_describe()["declared"] is None  # visible through its markers
    assert Scene.mcp_describe()["constructor"] is None
    assert Hidden.mcp_describe()["declared"] is False
    marked = {"name": "create", "description": None, "requires": ()}
    assert Station.mcp_describe()["constructor"] == marked
    assert Substation.mcp_describe()["constructor"] == marked
    assert Closed.mcp_describe()["constructor"] is False


def test_a_dict_keyword_exposes_what_is_marked(server):
    class Marked(StateDataModel, mcp={"description": "Only what is marked."}):
        shown = Sync(int, 0, mcp=True)
        unmarked = Sync(int, 0)

    class Every(StateDataModel, mcp=True):
        a = Sync(int, 0)
        b = ClientOnly(int, 0)

    assert set(server.mcp.describe(Marked)["properties"]) == {"shown"}
    assert set(server.mcp.describe(Every)["properties"]) == {"a", "b"}


def test_constructor_marker():
    class Made(StateDataModel):
        a = Sync(int, 0, mcp=True)

        @mcp.constructor(description="A new one", requires="files")
        @classmethod
        def new(cls, server): ...

    class Other(StateDataModel):
        a = Sync(int, 0, mcp=True)

        @classmethod
        @mcp.constructor
        def other(cls, server): ...

    assert Made.new.__func__._trame_mcp_constructor == {
        "description": "A new one",
        "requires": ("files",),
    }
    assert Other.mcp_describe()["constructor"] == {
        "name": "other",
        "description": None,
        "requires": (),
    }
    assert Made._mcp_constructor() == Constructor(
        attr="new", description="A new one", requires=("files",)
    )


def test_model_options_are_the_models_own():
    class OnlyAConstructor(StateDataModel, mcp={"constructor": "default"}):
        a = Sync(int, 0)

    options = OnlyAConstructor.mcp_describe()
    assert options["declared"] is True  # options of its own still declare it
    assert options["constructor"] == {"name": "default"}
    assert options["all_fields"] is False

    with pytest.raises(ValueError, match=r"unknown options \['fields'\].*all_fields"):

        class Typo(StateDataModel, mcp={"fields": ["a"]}):
            a = Sync(int, 0)

    class Described(StateDataModel):
        a = Sync(int, 0)

    assert Described.mcp_describe(all_fields=True)["all_fields"] is True
    with pytest.raises(ValueError, match="already set"):
        Described.mcp_describe(constructor="default")


def test_constructor_markers_are_checked():
    with pytest.raises(ValueError, match="marks several constructors"):

        class Twice(StateDataModel):
            a = Sync(int, 0, mcp=True)

            @mcp.constructor
            @classmethod
            def one(cls, server): ...

            @mcp.constructor
            @classmethod
            def two(cls, server): ...

    with pytest.raises(TypeError, match="marks a classmethod"):

        class Plain(StateDataModel):
            a = Sync(int, 0, mcp=True)

            @mcp.constructor
            def build(self): ...

    with pytest.raises(TypeError, match="not a staticmethod"):
        mcp.constructor(staticmethod(lambda: None))


def test_first_class_markers_are_for_components():
    with pytest.raises(TypeError, match="for components built once"):

        class Misplaced(StateDataModel):
            value = Sync(int, 0)

            @mcp.tool
            def run(self): ...


def test_ids_are_shared_with_components(server):
    label = Label(server)
    hub = Hub(server, None)
    ids = {label._id, hub._id, Label(server)._id}
    assert len(ids) == 3
    assert not any(i[0].isalpha() for i in ids)


# -----------------------------------------------------------------------------
# What agents see
# -----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_field_marked_true_makes_its_class_visible(server):
    dial = Dial(server)
    dial.mcp_expose("dial")
    assert server.mcp.describe(Dial)["properties"] == {"value": {"type": "integer"}}
    assert await ok(server, "object_update", target="dial", values={"value": 3})
    assert dial.value == 3


@pytest.mark.asyncio
async def test_a_child_server_translates_the_name(server):
    child = server.create_child_server(prefix="left_")
    dial = Dial(child)
    dial.mcp_expose("dial")
    assert await ok(server, "object_update", target="left_dial", values={"value": 3})
    assert dial.value == 3


@pytest.mark.asyncio
async def test_fields_by_mode_and_marks(server):
    server.mcp.permissions.declare("files", "Read files")
    scene = Scene(server)
    scene.mcp_expose("scene")
    described = await ok(server, "object_types", type_names=["Label", "Layer", "Scene"])
    types = described["types"]

    assert types["Label"]["properties"] == {
        "hint": {"type": "string", "read_only": True},
        "position": {
            "type": "array",
            "minItems": 3,
            "maxItems": 3,
            "items": {"type": "number"},
            "description": "[x, y, z] in world coordinates",
        },
        "text": {"type": "string"},
    }
    assert types["Label"]["constructor"]["parameters"]["properties"].keys() == {
        "position",
        "text",
    }
    assert types["Layer"]["properties"]["opacity"] == {
        "type": "number",
        "minimum": 0,
        "maximum": 1,
    }
    assert types["Layer"]["properties"]["path"]["read_only"] is True
    assert types["Layer"]["properties"]["point_count"] == {
        "type": "integer",
        "read_only": True,
    }
    assert "constructor" not in types["Layer"]
    assert set(types["Scene"]["properties"]) == {"labels", "layers"}
    assert set(types["Scene"]["methods"]) == {"add_label", "count", "load_file"}
    assert types["Scene"]["methods"]["load_file"]["requires"] == ["files"]
    assert types["Scene"]["properties"]["labels"]["items"]["object"] == "Label"
    assert types["Scene"]["properties"]["layers"]["read_only"] is True


@pytest.mark.asyncio
async def test_index_and_subclasses(server):
    scene = Scene(server)
    scene.mcp_expose("scene")
    assert await ok(server, "object_list") == {"objects": {"scene": {"type": "Scene"}}}
    index = await ok(server, "object_types")
    # Note extends Label (a reference typed with Label may hold one); Hidden never shows
    assert index["types"]["Note"] == {
        "about": "A label with a body.",
        "properties": ["body"],
        "constructor": True,
        "extends": "Label",
    }
    assert index["types"]["Label"]["about"] == "A text label in the scene."
    assert "Hidden" not in index["types"]
    assert "Layer" in index["types"]


@pytest.mark.asyncio
async def test_library_models_with_mcp_describe(server):
    class Camera(StateDataModel):
        position = Sync(list[float], lambda: [0.0, 0.0, 1.0])
        cache_key = Sync(str, "")

        @property
        def distance(self) -> float:
            return 1.0

        def reset(self) -> None:
            """Back to the default position."""
            self.position = [0.0, 0.0, 1.0]

    Camera.mcp_describe(
        description="The camera of the 3D view.",
        properties={"position": "[x, y, z]", "cache_key": False, "distance": True},
        methods=["reset"],
    )
    with pytest.raises(ValueError, match="already set"):
        Camera.mcp_describe(False)

    camera = Camera(server, position=[1.0, 2.0, 3.0])
    camera.mcp_expose("camera")
    described = server.mcp.describe(Camera)
    assert described["description"] == "The camera of the 3D view."
    assert set(described["properties"]) == {"position", "distance"}
    assert set(described["methods"]) == {"reset"}
    await ok(server, "object_call", target="camera", method="reset")
    assert camera.position == [0.0, 0.0, 1.0]


# -----------------------------------------------------------------------------
# Reachability
# -----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reachability(server):
    scene = Scene(server)
    label, loose = Label(server, text="a"), Label(server, text="loose")
    scene.labels = [label]
    scene.focus = loose  # a hidden reference is no path
    scene.mcp_expose("scene")

    value = await ok(server, "object_get", target="scene")
    assert value == {
        "result": {"id": scene._id},
        "objects": {
            scene._id: {
                "type": "Scene",
                "names": ["scene"],
                "values": {
                    "labels": [{"id": label._id, "type": "Label"}],
                    "layers": [],
                },
            }
        },
    }
    value = await ok(server, "object_get", target=label._id)
    assert read(value)["values"]["text"] == "a"
    assert "Unknown object" in await fails(server, "object_get", target=loose._id)

    value = await ok(server, "object_get", target="scene", depth=2)
    assert read(value)["values"]["labels"] == [{"id": label._id}]
    assert value["objects"][label._id]["values"]["text"] == "a"

    scene.mcp_unexpose()
    assert "Unknown object" in await fails(server, "object_get", target=label._id)


@pytest.mark.asyncio
async def test_component_properties_reach_models(server):
    scene = Scene(server)
    label = Label(server, text="through a component")
    scene.labels = [label]
    hub = Hub(server, scene)
    hub.mcp_expose("hub")
    value = read(await ok(server, "object_get", target=hub._id))
    assert value["values"]["scene"] == {"id": scene._id, "type": "Scene"}
    value = read(await ok(server, "object_get", target=label._id))
    assert value["values"]["text"] == "through a component"


@pytest.mark.asyncio
async def test_read_only_names(server):
    scene = Scene(server)
    label = Label(server, text="a")
    scene.labels = [label]
    scene.mcp_expose("scene", read_only=True)

    value = read(await ok(server, "object_get", target=label._id))
    assert value["read_only"] is True
    message = await fails(
        server, "object_update", target=label._id, values={"text": "b"}
    )
    assert message == f"Nothing was applied: Label {label._id} is exposed read-only."
    assert await ok(server, "object_call", target="scene", method="count") == 1
    assert "read-only" in await fails(
        server,
        "object_call",
        target="scene",
        method="add_label",
        args={"label": label._id},
    )

    # A writable name wins
    label.mcp_expose("label")
    await ok(server, "object_update", target=label._id, values={"text": "b"})
    assert label.text == "b"


@pytest.mark.asyncio
async def test_a_model_name_has_a_description(server):
    Label(server).mcp_expose("title", description="The plot's title.")
    listed = (await ok(server, "object_list"))["objects"]
    assert listed["title"] == {"type": "Label", "description": "The plot's title."}


def test_models_need_a_server():
    with pytest.raises(RuntimeError, match="has no trame server"):
        Label().mcp_expose("label")


def test_hidden_models_cannot_be_exposed(server):
    with pytest.raises(TypeError, match="declares nothing"):
        Hidden(server).mcp_expose("hidden")


# -----------------------------------------------------------------------------
# Writes and calls
# -----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_update(server):
    label = Label(server)
    label.mcp_expose("label")
    assert await ok(
        server, "object_update", target="label", values={"position": [0, 2, 5]}
    ) == {"id": label._id, "updated": ["position"]}
    assert label.position == (0.0, 2.0, 5.0)  # the declared tuple

    message = await fails(
        server, "object_update", target="label", values={"text": "ok", "position": [1]}
    )
    assert message == "Nothing was applied: position: expected at least 3 items, got 1"
    assert label.text == ""
    message = await fails(server, "object_update", target="label", values={"hint": "x"})
    assert "hint (read-only)" in message


@pytest.mark.asyncio
async def test_reference_fields_are_written_by_id(server):
    scene = Scene(server)
    scene.mcp_expose("scene")
    first, second = Label(server, text="1"), Label(server, text="2")
    first.mcp_expose("first")
    second.mcp_expose("second")
    layer = Layer(server)
    scene.layers = [layer]

    await ok(server, "object_update", target="scene", values={"labels": [second._id]})
    assert scene.labels == [second]
    message = await fails(
        server, "object_update", target="scene", values={"labels": ["first", "x"]}
    )
    assert 'labels[1]: "x" is not the id or name of an object' in message
    assert scene.labels == [second]  # all or nothing

    message = await fails(
        server, "object_update", target="scene", values={"labels": [layer._id]}
    )
    assert f'labels[0]: "{layer._id}" has type Layer, not Label' in message
    message = await fails(
        server, "object_update", target="scene", values={"layers": []}
    )
    assert "layers (read-only)" in message


@pytest.mark.asyncio
async def test_writes_return_once_watchers_ran(server):
    thermostat = Thermostat(server)
    thermostat.mcp_expose("thermostat")
    await ok(server, "object_update", target="thermostat", values={"target": 22})
    assert thermostat.heating is True
    thermostat.target = 18
    await thermostat.completion()
    assert await ok(server, "object_call", target="thermostat", method="warm_up") == 20
    assert await ok(server, "object_call", target="thermostat", method="warm_up") == 22
    assert thermostat.heating is True


@pytest.mark.asyncio
async def test_a_failing_watcher_does_not_fail_the_update(server, caplog):
    class Fragile(StateDataModel, mcp=True):
        level = Sync(int, 0)

        @watch("level")
        def _on_level(self, level):
            if level > 5:
                msg = "too high"
                raise RuntimeError(msg)

    fragile = Fragile(server)
    fragile.mcp_expose("fragile")
    with caplog.at_level(logging.ERROR, logger="trame_server.mcp"):
        result = await ok(
            server, "object_update", target="fragile", values={"level": 9}
        )
    assert result["updated"] == ["level"]
    assert fragile.level == 9
    assert "A watcher of Fragile" in caplog.text


@pytest.mark.asyncio
async def test_calls_and_permissions(server):
    server.mcp.permissions.declare("files", "Read files on this computer")
    scene = Scene(server)
    scene.mcp_expose("scene")
    value = await ok(
        server,
        "object_call",
        target="scene",
        method="load_file",
        args={"path": "/a.vti"},
    )
    layer = scene.layers[0]
    assert value == {
        "result": {"id": layer._id},
        "objects": {
            layer._id: {
                "type": "Layer",
                "values": {"opacity": 1.0, "path": "/a.vti", "point_count": 42},
            }
        },
    }

    server.mcp.permissions["files"] = False
    described = await ok(server, "object_types", type_names=["Scene"])
    assert "load_file" not in described["types"]["Scene"]["methods"]
    message = await fails(
        server, "object_call", target="scene", method="load_file", args={"path": "/b"}
    )
    assert 'permission "files"' in message
    assert len(scene.layers) == 1


# -----------------------------------------------------------------------------
# Constructors and batches
# -----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_constructors(server, caplog):
    things = [Station(server), Substation(server), Closed(server), Picky(server, 1)]
    for i, thing in enumerate(things):
        thing.mcp_expose(f"thing_{i}")
    described = await ok(server, "object_types", type_names=["Station"])
    assert described["types"]["Station"]["constructor"] == {
        "parameters": {
            "type": "object",
            "properties": {"name": {"type": "string"}},
            "required": ["name"],
            "additionalProperties": False,
        },
        "description": "A station named so.",
    }
    with caplog.at_level(logging.WARNING, logger="trame_server.mcp"):
        described = await ok(server, "object_types", type_names=["Picky"])
    assert "constructor" not in described["types"]["Picky"]
    assert "Picky has no constructor for agents" in caplog.text

    value = await ok(
        server,
        "object_batch",
        steps=[
            {"new": "Station", "args": {"name": "x"}},
            {"new": "Substation", "args": {"name": "y"}, "as": "sub"},
        ],
        results="full",
    )
    station, substation = (value["objects"][r["id"]] for r in value["results"])
    assert station["values"] == {"name": "station x"}
    assert substation["type"] == "Substation"
    assert len(value["unattached"]) == 2
    assert "Closed" in await fails(server, "object_batch", steps=[{"new": "Closed"}])


@pytest.mark.asyncio
async def test_a_subclass_without_its_base_constructor(server):
    server.mcp.permissions.declare("files", "Read files", allowed=False)
    for i, thing in enumerate([Station(server), Archive(server), Closed(server)]):
        thing.mcp_expose(f"thing_{i}")
    described = await ok(server, "object_types", type_names=["Archive", "Closed"])
    # Still described as what they change: their constructor is gone
    assert described["types"] == {
        "Archive": {
            "extends": "Station",
            "properties": {},
            "methods": {},
            "constructor": False,
        },
        "Closed": {
            "extends": "Station",
            "properties": {},
            "methods": {},
            "constructor": False,
        },
    }
    index = (await ok(server, "object_types"))["types"]
    assert index["Archive"] == {"constructor": False, "extends": "Station"}

    server.mcp.permissions["files"] = True
    described = await ok(server, "object_types", type_names=["Archive"])
    assert described["types"]["Archive"]["constructor"]["requires"] == ["files"]


@pytest.mark.asyncio
async def test_batch_builds_attaches_and_links(server):
    scene = Scene(server)
    scene.mcp_expose("scene")
    value = await ok(
        server,
        "object_batch",
        steps=[
            {
                "new": "Label",
                "args": {"text": "Skull", "position": [0, 0, 120]},
                "as": "skull",
            },
            {"call": "scene", "method": "add_label", "args": {"label": "@skull"}},
            {"update": "@skull", "values": {"text": "Skull!"}},
            {"new": "Note", "args": {"body": "never attached"}},
        ],
    )
    skull = scene.labels[0]
    assert skull.text == "Skull!"
    assert skull.position == (0.0, 0.0, 120.0)
    note = value["results"][3]
    assert value == {
        "results": [
            {"id": skull._id},
            None,
            {"id": skull._id, "updated": ["text"]},
            {"id": note["id"]},
        ],
        "unattached": [{"id": note["id"]}],
        "objects": {
            skull._id: {"type": "Label"},  # links only, and none
            note["id"]: {"type": "Note"},
        },
    }

    full = await ok(
        server,
        "object_batch",
        steps=[{"call": "scene", "method": "count", "as": "n"}],
        results="full",
    )
    assert full["results"] == [1]

    # References follow properties
    value = await ok(
        server,
        "object_batch",
        steps=[
            {"new": "Label", "args": {"text": "source"}, "as": "a"},
            {"new": "Label", "args": {"text": "@a.text"}, "as": "b"},
            {"update": "scene", "values": {"labels": ["@a", "@b"]}},
        ],
    )
    assert [label.text for label in scene.labels] == ["source", "source"]
    assert "unattached" not in value
    assert "labels[0]" in await fails(
        server,
        "object_batch",
        steps=[
            {"call": "scene", "method": "count", "as": "n"},
            {"update": "scene", "values": {"labels": ["@n"]}},
        ],
    )


@pytest.mark.asyncio
async def test_batch_results_are_cut_last(server):
    server.mcp.max_response_tokens = 500  # 2000 characters
    Scene(server).mcp_expose("scene")  # Labels can be built for it
    steps = [{"new": "Label", "args": {"text": f"label {i}"}} for i in range(80)]
    value = await ok(server, "object_batch", steps=steps)
    assert len(json.dumps(value, separators=(",", ":"))) <= 2000
    # The objects go first: object_get reads them again, the batch can't rerun
    assert "objects" not in value
    assert value["more"]["objects"].startswith("0 of 80 objects read")
    for key in ("results", "unattached"):
        assert value["more"][key] == (
            f"{len(value[key])} of 80 items shown to fit the response budget; "
            f"run fewer steps per batch"
        )


@pytest.mark.asyncio
async def test_batch_failures(server):
    scene = Scene(server)
    scene.mcp_expose("scene")
    message = await fails(
        server,
        "object_batch",
        steps=[
            {"new": "Label", "args": {"text": "a"}, "as": "a"},
            {"call": "scene", "method": "add_label", "args": {"label": "@a"}},
            {"call": "scene", "method": "add_label", "args": {"label": "@a"}},
        ],
    )
    assert message.startswith(
        "steps[2] (call add_label on scene) failed: ValueError: a is already shown"
    )
    assert "Steps 0-1 stay applied" in message
    assert len(scene.labels) == 1

    server.mcp.permissions.declare("files", "Read files", allowed=False)
    message = await fails(
        server,
        "object_batch",
        steps=[
            {"new": "Label", "as": "b"},
            {"call": "scene", "method": "add_label", "args": {"label": "@b"}},
            {"call": "scene", "method": "load_file", "args": {"path": "/x"}},
        ],
    )
    assert message.startswith("Nothing was applied:")
    assert len(scene.labels) == 1
    message = await fails(server, "object_batch", steps=[{"new": "Layer"}])
    assert 'no type "Layer" can be built' in message


@pytest.mark.asyncio
async def test_a_cancel_stops_a_batch_between_steps(server):
    from trame_server.mcp.protocol import REQUEST_CANCELLED

    release = asyncio.Event()

    class Waiter(StateDataModel, mcp=True):
        done = Sync(int, 0)

        @mcp.method
        async def wait(self) -> None:
            await release.wait()

        @mcp.method
        def finish(self) -> None:
            self.done += 1

    waiter = Waiter(server)
    waiter.mcp_expose("waiter")
    running = asyncio.ensure_future(
        server.mcp.protocol.handle(
            rpc(
                7,
                "object_batch",
                {
                    "steps": [
                        {"call": "waiter", "method": "wait"},
                        {"call": "waiter", "method": "finish"},
                    ]
                },
            )
        )
    )
    await asyncio.sleep(0.01)
    assert server.mcp.protocol.cancel(7, reason="changed my mind")
    response = await running
    assert response["error"]["code"] == REQUEST_CANCELLED
    assert waiter.done == 0


@pytest.mark.asyncio
async def test_depth_reads_each_object_once(server):
    box = Box(server, label="b")
    plug = Plug(server, owner=box)
    wire = Wire(server, source=plug)
    box.plugs = [plug]
    plug.wires = [wire]
    box.mcp_expose("box")

    value = await ok(server, "object_get", target="box", depth=3)
    assert value == {
        "result": {"id": box._id},
        "objects": {
            box._id: {
                "type": "Box",
                "names": ["box"],
                "values": {"label": "b", "plugs": [{"id": plug._id}]},
            },
            plug._id: {
                "type": "Plug",
                "values": {
                    "owner": {"id": box._id},
                    "wires": [{"id": wire._id}],
                    "note": "",
                },
            },
            wire._id: {"type": "Wire", "values": {"source": {"id": plug._id}}},
        },
    }
    value = await ok(server, "object_get", target="box", depth=2)
    assert value["objects"][plug._id]["values"]["wires"] == [
        {"id": wire._id, "type": "Wire"}  # not read: with its type
    ]
    assert list(value["objects"]) == [box._id, plug._id]

    # The objects a capped list leaves out are not read; the farthest objects
    # are left out to fit the budget
    box.plugs = [Plug(server, owner=box, note="n" * 100) for _ in range(60)]
    value = await ok(server, "object_get", target="box", depth=2)
    assert len(value["objects"]) == 21
    server.mcp.max_response_tokens = 500
    value = await ok(server, "object_get", target="box", depth=2)
    assert len(json.dumps(value, separators=(",", ":"))) <= 2000  # as sent
    kept = len(value["objects"])
    assert 1 < kept < 21
    assert value["more"]["objects"] == (
        f"{kept} of 21 objects read to fit the response budget; "
        "object_get(id) reads one"
    )


@pytest.mark.asyncio
async def test_models_disappear_when_collected(server):
    scene = Scene(server)
    scene.labels = [Label(server, text="x")]
    _id = scene.labels[0]._id
    holder = [scene]
    server.mcp.expose_object(lambda: holder[0], "scene")
    await ok(server, "object_get", target=_id)
    holder[0] = None
    del scene
    gc.collect()
    assert "currently empty" in await fails(server, "object_get", target="scene")
    assert "Unknown object" in await fails(server, "object_get", target=_id)


def test_audit_reports_hidden_references(server, caplog):
    scene = Scene(server)
    scene.mcp_expose("scene")
    with caplog.at_level(logging.WARNING, logger="trame_server.mcp"):
        server.mcp._objects.audit()
    assert "Scene.focus holds objects agents see (Label, Note)" in caplog.text
