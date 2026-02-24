import asyncio
import inspect
import string
import types
import weakref
from collections.abc import Awaitable, Sequence
from dataclasses import dataclass, field
from typing import Any, Callable, Union, get_args, get_origin

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
# Internal type definition
# -----------------------------------------------------------------------------

WatcherCallback = Callable[[Any], None | Awaitable[None]]

# -----------------------------------------------------------------------------
# Custom Exception
# -----------------------------------------------------------------------------


class WatcherExecution(Exception):
    pass


# -----------------------------------------------------------------------------
# Internal classes
# -----------------------------------------------------------------------------


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


def _save_field(name, src, dst, encoder=None):
    value = getattr(src, name)
    if encoder:
        dst[name] = encoder(value)
    else:
        dst[name] = value


# -----------------------------------------------------------------------------
# Dataclass builder
# -----------------------------------------------------------------------------
class FieldEncoder:
    def __init__(self, encoder, decoder):
        self.encoder = encoder
        self.decoder = decoder


class StateDataModel:
    def __init__(self, trame_server=None, **kwargs):
        self.__id = _next_id()
        self.__trame_server = trame_server

        # Register all instances
        INSTANCES[self.__id] = self

        self._server_state = {}
        self._client_state = {}
        self._dirty_set = set()
        self._watchers = []
        self._next_watcher_id = 1
        self._pending_task = None
        self._pending_sync_tasks = []
        self._flush_impl = None
        self._subscriptions = []

        # Apply defaults
        for name in self.FIELD_NAMES:
            getattr(self, name)

        # initialize fields from kwargs
        self.update(**kwargs)

        # register to server
        if self.server is not None:
            self.server.enable_module(dataclass_module, version="v2")
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
        for key in self.FIELD_NAMES & set(kwargs.keys()):
            setattr(self, key, kwargs[key])

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
        print(other)
        state = getattr(self, "_server_state", {})
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
                v.enable_module(dataclass_module, version="v2")
                self._register_server()

    @property
    def client_state(self):
        # Make sure the client_state is fully filled
        dirty = set(self._dirty_set)
        for name in self.CLIENT_NAMES:
            if name in dirty or name not in self._client_state:
                convert = self.ENCODERS.get(name)
                if convert:
                    _save_field(name, self, self._client_state, convert.encoder)
                else:
                    _save_field(name, self, self._client_state)

        return self._client_state

    @property
    def _id(self):
        return self.__id

    def flush(self, dirty_set: set[str] | None = None):
        """Flush the data to the client."""
        if self._flush_impl is None:
            return

        if dirty_set is None:
            dirty_set = set(self._dirty_set)
            self._dirty_set.clear()
        else:
            for name in dirty_set:
                self._dirty_set.discard(name)

        key_to_send = list(dirty_set & self.CLIENT_NAMES)
        for name in key_to_send:
            encoder = None
            if name in self.ENCODERS:
                encoder = self.ENCODERS[name].encoder

            _save_field(name, self, self._client_state, encoder)

        # Send data over the network
        msg = {
            "id": self._id,
            "state": {k: self._client_state[k] for k in key_to_send},
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
    print("encode list", items)
    return [item._id for item in items]


def decode_dataclass_list(items):
    # print("decode_dataclass_list", items)
    if items is None:
        return None
    print("decode list", items)
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
    "ClientOnly",
    "FieldEncoder",
    "ServerOnly",
    "StateDataModel",
    "Sync",
    "get_instance",
    "watch",
]


def get_instance(instance_id: str):
    # print(f"get_instance({instance_id})")
    # print(" => ", INSTANCES[instance_id])
    return INSTANCES[instance_id]


class ServerOnly:
    def __init__(
        self,
        _type,
        default=None,
        convert=None,
        has_dataclass=False,
        type_checking="warning",  # error, warning, ignore
    ):
        self._type_checking = type_checking
        self._type = get_origin(_type) or _type
        if self._type in (Union, types.UnionType):
            self._type = get_args(_type)[0]
        self._type = get_origin(self._type) or self._type
        self._default = default() if callable(default) else default
        logger.debug("type {} - default {}", self._type, self._default)
        self._convert = convert
        self._has_dataclass = has_dataclass

        if has_dataclass:
            encoder = None
            decoder = None

            if self._type is list:
                encoder = encode_dataclass_list
                decoder = decode_dataclass_list
            elif self._type is dict:
                encoder = encode_dataclass_dict
                decoder = decode_dataclass_dict
            else:
                encoder = encode_dataclass_item
                decoder = decode_dataclass_item

            self._convert = FieldEncoder(encoder, decoder)

    def __set_name__(self, owner, name):
        if not hasattr(owner, "FIELD_NAMES"):
            owner.FIELD_NAMES = set()

        if not hasattr(owner, "TYPE_CHECKING"):
            owner.TYPE_CHECKING = {}

        self._name = name
        owner.TYPE_CHECKING[name] = self._type_checking
        owner.FIELD_NAMES.add(name)

    def __get__(self, instance, owner):
        if self._name not in instance._server_state:
            instance._server_state[self._name] = self._default
        return instance._server_state.get(self._name)

    def __set__(self, instance, value):
        type_check = instance.TYPE_CHECKING[self._name]
        if (
            type_check in {"error", "warning"}
            and value is not None
            and not isinstance(value, self._type)
        ):
            msg = f"{self._name} must be {self._type} instead of {type(value)}"
            if type_check == "error":
                raise TypeError(msg)

            logger.warning(msg)

        instance._dirty_set.add(self._name)
        instance._server_state[self._name] = value
        instance._on_dirty()


class Sync(ServerOnly):
    def __set_name__(self, owner, name):
        if not hasattr(owner, "FIELD_NAMES"):
            owner.FIELD_NAMES = set()

        if not hasattr(owner, "TYPE_CHECKING"):
            owner.TYPE_CHECKING = {}

        if not hasattr(owner, "CLIENT_NAMES"):
            owner.CLIENT_NAMES = set()

        if not hasattr(owner, "ENCODERS"):
            owner.ENCODERS = {}

        if not hasattr(owner, "DATACLASS_NAMES"):
            owner.DATACLASS_NAMES = set()

        if self._has_dataclass:
            owner.DATACLASS_NAMES.add(name)

        if self._convert:
            owner.ENCODERS[name] = self._convert

        self._name = name
        owner.TYPE_CHECKING[name] = self._type_checking
        owner.FIELD_NAMES.add(name)
        owner.CLIENT_NAMES.add(name)


class ClientOnly(ServerOnly):
    def __set_name__(self, owner, name):
        if not hasattr(owner, "FIELD_NAMES"):
            owner.FIELD_NAMES = set()

        if not hasattr(owner, "TYPE_CHECKING"):
            owner.TYPE_CHECKING = {}

        if not hasattr(owner, "CLIENT_NAMES"):
            owner.CLIENT_NAMES = set()

        if not hasattr(owner, "CLIENT_ONLY_NAMES"):
            owner.CLIENT_ONLY_NAMES = set()

        self._name = name
        owner.TYPE_CHECKING[name] = self._type_checking
        owner.FIELD_NAMES.add(name)
        owner.CLIENT_NAMES.add(name)
        owner.CLIENT_ONLY_NAMES.add(name)


def watch(*args, **kwargs):
    """Method decorator to watch state change"""

    def decorate(f):
        f._watch = (tuple(args), kwargs)
        return f

    return decorate
