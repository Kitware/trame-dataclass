import asyncio
import inspect
import os
import string
import types
import warnings
import weakref
from collections.abc import Awaitable, Sequence
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Any, Callable, TypeVar

from loguru import logger

from trame_dataclass import module as dataclass_module
from trame_dataclass.widgets.dataclass import Provider

# -----------------------------------------------------------------------------
# Id generator
# -----------------------------------------------------------------------------
INSTANCES = weakref.WeakValueDictionary()
_INSTANCE_COUNT = 0
_INSTANCE_ID_CHARS = string.digits + string.ascii_letters


def _next_id():
    global _INSTANCE_COUNT  # noqa: PLW0603
    _INSTANCE_COUNT += 1

    result = []
    value = _INSTANCE_COUNT
    size = len(_INSTANCE_ID_CHARS)
    while value > 0:
        remainder = value % size
        result.append(_INSTANCE_ID_CHARS[remainder])
        value //= size

    return "".join(result[::-1])


# -----------------------------------------------------------------------------
# Compatibles Types
# -----------------------------------------------------------------------------

_JSON_TYPES = frozenset(
    {
        # Common JSON Serializable types
        types.NoneType,
        bool,
        int,
        float,
        str,
    }
)

_COMPOSITE_TYPES = frozenset(
    {
        set,
        list,
        dict,
        tuple,
    }
)

# -----------------------------------------------------------------------------
# Internal type definition
# -----------------------------------------------------------------------------

T = TypeVar("T")
SerializableCoreType = None | str | bool | int | float
SerializableType = (
    SerializableCoreType | list[SerializableCoreType] | dict[str, SerializableCoreType]
)
Encoder = Callable[[T], SerializableType]
Decoder = Callable[[SerializableType], T]
WatcherCallback = Callable[[Any], None | Awaitable[None]]

# -----------------------------------------------------------------------------
# Custom Exception
# -----------------------------------------------------------------------------


class NonSerializableType(ValueError):
    pass


class InvalidDefaultForType(ValueError):
    pass


class NoServerLinked(ValueError):
    pass


class WatcherExecution(Exception):
    pass


class ClientOnlyFieldError(Exception):
    pass


# -----------------------------------------------------------------------------
# Internal classes
# -----------------------------------------------------------------------------


class ContainerFactory:
    def __init__(self, cls):
        self._cls = cls

    def __call__(self, *args, **kwargs):
        return self._cls(*args, **kwargs)


@dataclass
class Watcher:
    id: int
    args: Sequence[str]
    dependency: set[str]
    callback: WatcherCallback
    sync: bool
    bg_tasks: set[asyncio.Task] = field(default_factory=set)

    def trigger(
        self,
        obj,
        dirty: set[str] | None = None,
        sync: bool = False,
        eager: bool = False,
    ):
        if self.sync != sync and not eager:
            return None

        if dirty is None or self.dependency & dirty:
            args = [getattr(obj, name) for name in self.args]
            coroutine = self.callback(*args)
            if inspect.isawaitable(coroutine):
                bg_task = asyncio.create_task(coroutine)
                self.bg_tasks.add(bg_task)
                bg_task.add_done_callback(handle_task_result)
                bg_task.add_done_callback(self.bg_tasks.discard)
                return bg_task

        return None


def handle_task_result(task: asyncio.Task) -> None:
    try:
        task.result()
    except asyncio.CancelledError:
        pass  # Task cancellation should not be logged as an error.
    except Exception as e:  # pylint: disable=broad-except
        logger.exception(e)
        raise WatcherExecution() from e


def check_loop_status():
    try:
        asyncio.get_running_loop()
        return True
    except RuntimeError:
        return False


def can_be_decorated(x):
    return inspect.ismethod(x) or inspect.isfunction(x)


def _save_field(field, src, dst):
    if field.encoder:
        dst[field.name] = field.encoder(getattr(src, field.name))
    else:
        value = getattr(src, field.name)
        if isinstance(value, StateDataModel):
            value.flush()
            value = value._id
        dst[field.name] = value


# -----------------------------------------------------------------------------
# Representation helper functions
# -----------------------------------------------------------------------------


def _repr_type(annotation_type):
    if isinstance(annotation_type, types.UnionType):
        return f"({annotation_type})"

    if inspect.isclass(annotation_type) and issubclass(annotation_type, StateDataModel):
        return annotation_type.__name__

    if isinstance(annotation_type, type):
        return annotation_type.__name__

    return str(annotation_type)


def _repr_default(value):
    if isinstance(value, ContainerFactory):
        return "-"
    return _repr_value(value)


def _repr_value(value):
    if isinstance(value, StateDataModel):
        return "\n      ".join(str(value).split("\n"))
    if isinstance(value, str):
        return f'"{value}"'
    return str(value)


# -----------------------------------------------------------------------------
# Type annotation analysis helper functions
# -----------------------------------------------------------------------------


def _type_compatibility(annotation_type):
    if annotation_type in _JSON_TYPES:
        return True

    if isinstance(annotation_type, types.UnionType):
        return all(map(_type_compatibility, annotation_type.__args__))

    if _type_is_dataclass(annotation_type):
        return True

    if annotation_type in _COMPOSITE_TYPES:
        warnings.warn("Composite type is not templated.", stacklevel=2)
        return True

    if (
        hasattr(annotation_type, "__origin__")
        and annotation_type.__origin__ in _COMPOSITE_TYPES
    ):
        return all(map(_type_compatibility, annotation_type.__args__))

    return False


def _type_is_composite(annotation_type):
    if annotation_type in _COMPOSITE_TYPES:
        return True

    return (
        hasattr(annotation_type, "__origin__")
        and annotation_type.__origin__ in _COMPOSITE_TYPES
    )


def _type_can_be_none(annotation_type):
    if isinstance(annotation_type, types.UnionType):
        return types.NoneType in annotation_type.__args__

    return False


def _type_is_dataclass(annotation_type):
    # FIXME needed for now due to circular dependencies TreeNode(children: list['TreeNode'])
    if isinstance(annotation_type, str):
        return True

    if inspect.isclass(annotation_type) and issubclass(annotation_type, StateDataModel):
        return True

    if isinstance(annotation_type, types.UnionType):
        for t in annotation_type.__args__:
            if _type_is_dataclass(t):
                return True

    return False


def _type_default(annotation_type):
    if _type_can_be_none(annotation_type):
        return None

    if annotation_type is int:
        return 0

    if annotation_type is float:
        return 0.0

    if annotation_type is bool:
        return False

    if annotation_type is str:
        return ""

    if _type_is_composite(annotation_type):
        container_type = (
            annotation_type.__origin__
            if hasattr(annotation_type, "__origin__")
            else annotation_type
        )
        if container_type is list:
            return ContainerFactory(list)
        if container_type is set:
            return ContainerFactory(set)
        if container_type is dict:
            return ContainerFactory(dict)
        raise InvalidDefaultForType(annotation_type)

    if isinstance(annotation_type, types.GenericAlias):
        return _type_default(annotation_type.__origin__)

    if inspect.isclass(annotation_type) and issubclass(annotation_type, StateDataModel):
        return ContainerFactory(annotation_type)

    raise InvalidDefaultForType(annotation_type)


# -----------------------------------------------------------------------------
# Dataclass builder
# -----------------------------------------------------------------------------


class StateDataModel:
    def __init_subclass__(cls, **kwargs):
        cls_annotations = cls.__dict__.get("__annotations__", {})
        cls_fields = []
        for name, a_type in cls_annotations.items():
            initial_value = cls.__dict__.get(name, None)
            if initial_value is not None and isinstance(initial_value, Field):
                initial_value.setup_annotation(name, a_type)
                cls_fields.append(initial_value)
            else:
                if not _type_compatibility(a_type):
                    msg = f"{a_type} is not supported"
                    raise NonSerializableType(msg)

                field = Field(default=initial_value)
                field.setup_annotation(name, a_type)
                cls_fields.append(field)

        # add class metadata
        cls._FIELDS = {f.name: f for f in cls_fields}
        for f in cls_fields:
            f.setup_class(cls)

        # Extract field meta summary
        cls.__HAS_SERVER = any(f.mode.has_server_state for f in cls_fields)
        cls.__HAS_CLIENT = any(f.mode.has_client_state for f in cls_fields)
        cls.__NEED_SYNC = any(f.mode.need_sync for f in cls_fields)
        cls.__VALID_KEYS = {f.name for f in cls_fields if f.mode.has_set}

    def __init__(self, trame_server=None, **kwargs):
        self.__id = _next_id()
        self.__trame_server = trame_server

        # Register all instances
        INSTANCES[self.__id] = self

        self._dirty_set = set()
        self._watchers = []
        self._next_watcher_id = 1
        self._pending_task = None
        self._pending_sync_tasks = []
        self._flush_impl = None
        self._subscriptions = []

        if self.__HAS_SERVER:
            self._server_state = {}

        if self.__HAS_CLIENT:
            self._client_state = {}

        # set default values
        for f in self._FIELDS.values():
            f.setup_instance(self)

        # initialize fields from kwargs
        self.update(**kwargs)

        # register to server
        if self.server is not None:
            self.server.enable_module(dataclass_module)
            if self.server.running:
                # register protocol directly
                self._register_server()
            else:
                # wait for server to be ready
                self.server.controller.on_server_ready.add(
                    weakref.WeakMethod(self._register_server)
                )

        # check decorated methods
        for k in inspect.getmembers(self.__class__, can_be_decorated):
            fn = getattr(self, k[0])

            # Handle @watch
            if "_watch" in fn.__dict__:
                field_names, kwargs = fn.__dict__["_watch"]
                self._subscriptions.append(self.watch(field_names, fn, **kwargs))

    def _register_server(self, **_):
        self.server.protocol_call("trame.dataclass.register", self)

    def register_flush_implementation(self, push_function):
        self._flush_impl = push_function

    def update(self, **kwargs):
        for key in self.__VALID_KEYS & set(kwargs.keys()):
            setattr(self, key, kwargs[key])

    def __repr__(self):
        max_size = max(len(name) for name in self._FIELDS)
        fields_info = [
            f"{f.name:<{max_size}} [{f.mode} | enc({'custom' if f.encoder and f.decoder else 'json'}) | {_repr_type(f.type_annotation)}: {_repr_default(f.default)} ]: {_repr_value(getattr(self, f.name))}"
            for f in self._FIELDS.values()
        ]
        return f"{self.__class__.__name__} ({self._id}) - {self._dirty_set if len(self._dirty_set) else 'Synched'}{os.linesep} - {f'{os.linesep} - '.join(fields_info)}"

    def _on_dirty(self):
        dirty_copy = set(self._dirty_set)

        self._notify_watcher(dirty_copy, sync=True)
        if self._pending_task is None and check_loop_status():
            self._pending_task = asyncio.create_task(self._async_update(dirty_copy))
            self._pending_task.add_done_callback(handle_task_result)

            # only clear if you know that the dirty copy will be processed
            # otherwise wait for completion to pickup the dirty left over.
            self._dirty_set.clear()

        if not check_loop_status():
            # need to clear dirty if async is out of the picture
            self._dirty_set.clear()

    def _notify_watcher(self, dirty_set: set[str] | None = None, sync=False):
        if dirty_set is None:
            dirty_set = set(self._dirty_set)

        for w in self._watchers:
            bg_task = w.trigger(self, dirty_set, sync=sync)
            if bg_task:
                self._pending_sync_tasks.append(bg_task)

    async def _async_update(self, dirty_set: set[str]):
        self._notify_watcher(dirty_set, sync=False)
        if self.__NEED_SYNC:
            self.flush(dirty_set)

        # wait for any pending completion
        while len(self._pending_sync_tasks):
            pending_tasks = [t for t in self._pending_sync_tasks if not t.done()]
            self._pending_sync_tasks.clear()
            await asyncio.wait(pending_tasks, return_when=asyncio.ALL_COMPLETED)

        self._pending_task = None

        # reschedule ourself if remaining dirty
        if self._dirty_set and check_loop_status():
            dirty_set = set(self._dirty_set)
            self._dirty_set.clear()

            self._pending_task = asyncio.create_task(self._async_update(dirty_set))
            self._pending_task.add_done_callback(handle_task_result)

    def clear_watchers(self):
        self._watchers.clear()

    def clone(self):
        other = self.__class__(trame_server=self.server)
        state = getattr(self, "_server_state", getattr(self, "_client_state", {}))
        other.update(**state)
        return other

    async def completion(self):
        while self._pending_task is not None:
            await self._pending_task

    def watch(
        self,
        field_names: Sequence[str],
        callback_func: WatcherCallback,
        sync: bool = False,
        eager: bool = False,
    ) -> Callable:
        """Register a callback to be called when one or more fields change.

        Args:
            field_names (list[str]): Name(s) of the field(s) to watch.
            callback_func (callable): Callback function to be called when the field(s) change.
            sync (bool): Whether to execute the callback synchronously. By default this get triggered asynchronously.
            eager (bool): Whether to execute the callback immediately after registration.

        Returns:
            callable: Unwatch function to unregister the callback.
        """
        watcher = Watcher(
            self._next_watcher_id, field_names, set(field_names), callback_func, sync
        )
        self._next_watcher_id += 1
        self._watchers.append(watcher)

        def unwatch():
            self._watchers.remove(watcher)

        if eager:
            watcher.trigger(self, eager=eager)

        return unwatch

    def provide_as(self, name) -> Provider:
        """Register a data provider to be used by the client.

        Args:
            name (str): Name of the data variable that will be available within the nested scope.
        Returns:
            widget: instance of the widget to put within your UI definition."""
        instance = (f"'{self._id}'",)
        return Provider(name=name, instance=instance)

    @property
    def server(self):
        return self.__trame_server

    @server.setter
    def server(self, v):
        if self.__trame_server != v:
            self.__trame_server = v
            if v:
                v.enable_module(dataclass_module)
                self._register_server()

    @property
    def client_state(self):
        if not self.__NEED_SYNC:
            msg = f'"{self.__class__}" has no client state'
            raise RuntimeError(msg)

        # Make sure the client_state is fully filled
        fields = self._FIELDS.values()
        dirty = set(self._dirty_set)
        for field in fields:
            if field.name in dirty or field.name not in self._client_state:
                _save_field(field, self, self._client_state)

        return self._client_state

    @property
    def _id(self):
        return self.__id

    def flush(self, dirty_set: set[str] | None = None):
        """Flush the data to the client."""
        if not self.__NEED_SYNC:
            msg = f'"{self.__class__}" does not have any fields to sync'
            raise RuntimeError(msg)

        if self._flush_impl is None:
            return

        if dirty_set is None:
            dirty_set = set(self._dirty_set)
            self._dirty_set.clear()
        else:
            for name in dirty_set:
                self._dirty_set.discard(name)

        fields = self._FIELDS
        for name in dirty_set:
            _save_field(fields.get(name), self, self._client_state)

        # Send data over the network
        msg = {
            "id": self._id,
            "state": {k: self._client_state[k] for k in dirty_set},
        }
        self._flush_impl(msg)


# -----------------------------------------------------------------------------
# Generic encoder/decoder
# -----------------------------------------------------------------------------


def encode_dataclass_item(item):
    if item is None:
        return None
    return item._id


def decode_dataclass_item(item):
    # print("decode_dataclass_item", item)
    if item is None:
        return None
    return get_instance(item)


def encode_dataclass_list(items):
    if items is None:
        return None
    return [item._id for item in items]


def decode_dataclass_list(items):
    # print("decode_dataclass_list", items)
    if items is None:
        return None
    return list(map(get_instance, items))


def encode_dataclass_dict(data):
    if data is None:
        return None
    return {k: v._id for k, v in data.items()}


def decode_dataclass_dict(data):
    # print("decode_dataclass_dict", data)
    if data is None:
        return None
    return {k: get_instance(v) for k, v in data.items()}


# -----------------------------------------------------------------------------
# Public API
# -----------------------------------------------------------------------------
__all__ = [
    "FieldMode",
    "StateDataModel",
    "field",
    "get_instance",
    "watch",
]


def get_instance(instance_id: str):
    # print(f"get_instance({instance_id})")
    # print(" => ", INSTANCES[instance_id])
    return INSTANCES[instance_id]


class FieldMode(Enum):
    CLIENT_ONLY = (False, False, True)
    READ_ONLY = (True, False, True)
    PUSH_ONLY = (False, True, True)
    SERVER_ONLY = (True, True, False)
    DEFAULT = (True, True, True)

    def __init__(self, server_get, server_set, client):
        self._value_ = auto()
        self._get = server_get
        self._set = server_set
        self._client = client

    @property
    def has_get(self):
        return self._get or self._set

    @property
    def has_set(self):
        return self._set

    @property
    def has_server_state(self):
        return self._get or self._set

    @property
    def has_client_state(self):
        return self._client

    @property
    def is_client_only(self):
        return self.has_client_state and not self.has_server_state

    @property
    def need_sync(self):
        return self.has_server_state and self.has_client_state


# -----------------------------------------------------------------------------


class Field:
    def __init__(
        self,
        mode: FieldMode = FieldMode.DEFAULT,
        default: Any = None,
        encoder: Encoder | None = None,
        decoder: Decoder | None = None,
    ):
        self.name = None
        self.type_annotation = None
        self.mode = mode
        self.default = default
        self.encoder = encoder
        self.decoder = decoder
        self.dataclass_container = False

    def update_encoder(self, type_annotation):
        if _type_is_composite(type_annotation):
            if hasattr(type_annotation, "__origin__"):
                # properly typed
                if type_annotation.__origin__ is list and _type_is_dataclass(
                    type_annotation.__args__[0]
                ):
                    # print("Use custom list[dataclass] encoder/decoder")
                    assert self.encoder is None, (
                        "DataClass encoder get managed automatically. Should not override an existing one!"
                    )
                    self.encoder = encode_dataclass_list
                    self.decoder = decode_dataclass_list
                    self.dataclass_container = True
                elif type_annotation.__origin__ is dict and _type_is_dataclass(
                    type_annotation.__args__[1]
                ):
                    assert type_annotation.__args__[0] is str, (
                        "Dict with dataclass must use str as key"
                    )
                    assert self.encoder is None, (
                        "DataClass encoder get managed automatically. Should not override an existing one!"
                    )
                    # print("Use custom dict[str, dataclass] encoder/decoder")
                    self.encoder = encode_dataclass_dict
                    self.decoder = decode_dataclass_dict
                    self.dataclass_container = True
        elif _type_is_dataclass(type_annotation):
            assert self.encoder is None, (
                "DataClass encoder get managed automatically. Should not override an existing one!"
            )
            self.encoder = encode_dataclass_item
            self.decoder = decode_dataclass_item
            self.dataclass_container = True

    def setup_annotation(self, name, type_annotation):
        self.name = name
        self.type_annotation = type_annotation
        if self.default is None:
            self.default = _type_default(type_annotation)

        if isinstance(type_annotation, types.UnionType):
            for t in type_annotation.__args__:
                self.update_encoder(t)
        else:
            self.update_encoder(type_annotation)

    def setup_class(self, cls):
        """Patch class with methods to add"""
        name = self.name

        def _set(self, value):
            if name in self._server_state and self._server_state[name] == value:
                return

            self._dirty_set.add(name)
            self._server_state[name] = value
            self._on_dirty()

        def _get(self):
            return self._server_state[name]

        def _get_client_only(self):  # noqa: ARG001
            msg = f'"{name}" is client-side only and cannot be accessed on the server'
            raise ClientOnlyFieldError(msg)

        if self.mode.has_get and self.mode.has_set:
            setattr(cls, name, property(_get, _set))
        elif self.mode.has_get:
            setattr(cls, name, property(_get))
        elif self.mode.is_client_only:
            setattr(cls, name, property(_get_client_only))

    def setup_instance(self, obj):
        # Assign value
        value = self.default() if callable(self.default) else self.default
        if self.mode.has_set:
            setattr(obj, self.name, value)
        elif self.mode.has_client_state:
            obj._client_state[self.name] = value


# -----------------------------------------------------------------------------


# This function is used instead of exposing Field creation directly,
# so that a type checker can be told (via overloads) that this is a
# function whose type depends on its parameters.
def field(
    mode: FieldMode = FieldMode.DEFAULT,
    default: Any = None,
    encoder: Encoder | None = None,
    decoder: Decoder | None = None,
) -> Any:
    return Field(mode, default, encoder, decoder)


# -----------------------------------------------------------------------------


def watch(*args, **kwargs):
    """Method decorator to watch state change"""

    def decorate(f):
        f._watch = (tuple(args), kwargs)
        return f

    return decorate
