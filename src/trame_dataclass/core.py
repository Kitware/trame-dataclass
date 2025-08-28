import string
import types
import warnings
from enum import Enum, auto
from typing import Any, Callable, TypeVar

# -----------------------------------------------------------------------------
# internal field names
# -----------------------------------------------------------------------------
_FIELDS = "__trame_dataclass_fields__"

# -----------------------------------------------------------------------------
# Id generator
# -----------------------------------------------------------------------------
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


# -----------------------------------------------------------------------------
# Custom Exception
# -----------------------------------------------------------------------------


class NonSerializableType(ValueError):
    pass


class InvalidDefaultForType(ValueError):
    pass


class NoServerLinked(ValueError):
    pass


# -----------------------------------------------------------------------------
# Method to add to trame_dataclass
# -----------------------------------------------------------------------------


def _create_methods(fields):
    server = (any(f.mode.has_server_state for f in fields),)
    client = (any(f.mode.has_client_state for f in fields),)
    sync = (any(f.mode.need_sync for f in fields),)
    valid_keys = {f.name for f in fields}
    methods_to_register = {}

    def __init__(self, trame_server=None, **kwargs):
        self.__id = _next_id()
        self.__trame_server = trame_server

        self._dirty_set = set()
        self._mtime = 1
        self._sync = sync

        if server:
            self._server_state = {}

        if client:
            self._client_state = {}

        # set default values
        for f in fields:
            f.setup_instance(self)

        # initialize fields from kwargs
        self.update(**kwargs)

    def update(self, **kwargs):
        for key in valid_keys & set(kwargs.keys()):
            setattr(self, key, kwargs[key])

    def __repr__(self):
        max_size = max(len(f.name) for f in fields)
        fields_info = [
            f"{f.name:<{max_size}} [{f.mode} | enc({'custom' if f.encoder and f.decoder else 'json'}) | {_repr_type(f.type_annotation)}: {_repr_default(f.default)} ]: {_repr_value(getattr(self, f.name))}"
            for f in fields
        ]
        return f"{self.__class__.__name__} ({self._id}) - {self._dirty_set if len(self._dirty_set) else 'Synched'}\n - {'\n - '.join(fields_info)}"

    methods_to_register["__init__"] = __init__
    methods_to_register["update"] = update
    methods_to_register["__repr__"] = __repr__

    # Optionally add flush method
    if sync:

        def flush(self):
            if not self.__trame_server:
                raise NoServerLinked()

            fields = getattr(self.__class__, _FIELDS)
            for name in self._dirty_set:
                f = fields.get(name)
                if f.encoder:
                    self._client_state[name] = f.encode(getattr(self, name))
                else:
                    value = getattr(self, name)
                    if is_trame_dataclass(value):
                        value.flush()
                        value = f"_dataclass: {value._id}"
                    self._client_state[name] = value
            self._dirty_set.clear()

            # Send data over the network
            # TODO

        methods_to_register["flush"] = flush

    return methods_to_register


def _m_get_id(self):
    return self.__id


def _m_watch(self, field_names, callback_func):
    ...
    # return unwatch


def _m_Provider(self, name="data", instance=None): ...


# -----------------------------------------------------------------------------


def _repr_type(annotation_type):
    if isinstance(annotation_type, types.UnionType):
        return f"({annotation_type})"

    if is_trame_dataclass(annotation_type):
        return annotation_type.__name__

    if isinstance(annotation_type, type):
        return annotation_type.__name__

    return str(annotation_type)


def _repr_default(value):
    if isinstance(value, ContainerFactory):
        return "-"
    return _repr_value(value)


def _repr_value(value):
    if is_trame_dataclass(value):
        return "\n      ".join(str(value).split("\n"))
    if isinstance(value, str):
        return f'"{value}"'
    return str(value)


def _type_compatibility(annotation_type):
    if annotation_type in _JSON_TYPES:
        return True

    if isinstance(annotation_type, types.UnionType):
        return all(map(_type_compatibility, annotation_type.__args__))

    if is_trame_dataclass(annotation_type):
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


class ContainerFactory:
    def __init__(self, cls):
        self._cls = cls

    def __call__(self, *args, **kwargs):
        return self._cls(*args, **kwargs)


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

    if is_trame_dataclass(annotation_type):
        return ContainerFactory(annotation_type)

    raise InvalidDefaultForType(annotation_type)


def _process_class(cls):
    cls_annotations = cls.__dict__.get("__annotations__", {})
    cls_fields = []
    for name, type in cls_annotations.items():
        if not _type_compatibility(type):
            msg = f"{type} is not supported"
            raise NonSerializableType(msg)

        initial_value = cls.__dict__.get(name, None)
        if initial_value is not None and isinstance(initial_value, Field):
            initial_value.setup_annotation(name, type)
            cls_fields.append(initial_value)
        else:
            field = Field(default=initial_value)
            field.setup_annotation(name, type)
            cls_fields.append(field)

    # add class metadata
    setattr(cls, _FIELDS, {f.name: f for f in cls_fields})
    for f in cls_fields:
        f.setup_class(cls)

    # add default getter properties
    cls._id = property(_m_get_id)

    # Add default methods
    for name, fn in _create_methods(cls_fields).items():
        setattr(cls, name, fn)
    cls.watch = _m_watch
    cls.Provider = _m_Provider

    # return decorated class
    return cls


def trame_dataclass(cls=None, **_):
    """Annotation for state based dataclass"""

    def wrap(cls):
        return _process_class(cls)

    if cls is None:
        return wrap

    return wrap(cls)


def is_trame_dataclass(obj):
    """Returns True if obj is a trame_dataclass or an instance of a
    trame_dataclass."""
    cls = (
        obj
        if isinstance(obj, type) and not isinstance(obj, types.GenericAlias)
        else type(obj)
    )
    return hasattr(cls, _FIELDS)


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
    def need_sync(self):
        return self.has_server_state and self.has_client_state


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

    def setup_annotation(self, name, type_annotation):
        self.name = name
        self.type_annotation = type_annotation
        if self.default is None:
            self.default = _type_default(type_annotation)

    def setup_class(self, cls):
        """Patch class with methods to add"""
        name = self.name

        def _set(self, value):
            before = len(self._dirty_set)
            self._dirty_set.add(name)
            if len(self._dirty_set) > before:
                self._mtime += 1

            self._server_state[name] = value

        def _get(self):
            return self._server_state[name]

        if self.mode.has_get and self.mode.has_set:
            setattr(cls, name, property(_get, _set))
        elif self.mode.has_get:
            setattr(cls, name, property(_get))

    def setup_instance(self, obj):
        # Assign value
        value = self.default() if callable(self.default) else self.default
        if self.mode.has_set:
            setattr(obj, self.name, value)
        elif self.mode.has_client_state:
            obj._client_state[self.name] = value
