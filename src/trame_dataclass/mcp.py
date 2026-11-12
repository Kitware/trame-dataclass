"""What agents (MCP) see of a model class's fields.

``StateDataModel``'s ``_mcp_fields`` hook (trame-common's ``MCPExposable``)
calls this module, importing it the first time it is used. It applies the
rules only models have: the field descriptors (``Sync``, ``ClientOnly``,
``ServerOnly``) and ``all_fields``. The trame server handles the rest, such
as schemas, reads and writes, from what the classes declare.
"""

from trame_common.obj import mcp as mcp_options
from trame_common.obj.mcp import Field

from trame_dataclass.v2 import mcp_model_options

__all__ = [
    "fields",
]

_MISSING = object()


def _descriptor(cls, name):
    for klass in cls.__mro__:
        if name in vars(klass):
            return vars(klass)[name]
    return None


def _option(cls, name):
    """The nearest ``mcp=`` value given for field ``name`` along the MRO: a
    subclass redeclaring a field (to change its default) keeps its options."""
    for klass in cls.__mro__:
        option = getattr(vars(klass).get(name), "_mcp", None)
        if option is not None:
            return option
    return None


def _exposed(cls, name, own, listed, all_fields, descriptor_type):
    """What agents see of field ``name``: its options, None when it is not
    exposed, or False when it is hidden on purpose. The class's
    ``properties=`` entry goes over the field's own ``mcp=`` value."""
    if listed is False or (listed is None and own is False):
        return False
    if listed is not None or own is not None:
        options = {**(own or {}), **(listed or {})}
    elif all_fields and descriptor_type != "server_only":
        options = {}
    else:
        return None
    if "read_only" not in options:
        if descriptor_type == "server_only":
            msg = (
                f"{cls.__name__}.{name} is a ServerOnly field: exposing it requires "
                f"read_only=True or False"
            )
            raise ValueError(msg)
        options["read_only"] = descriptor_type == "client_only"
    return options


def fields(cls):
    """``{name: Field}`` for every field of ``cls``, in definition order (a
    base's first). A field is exposed when the class lists it in
    ``properties=`` or the field has an ``mcp=`` value, and otherwise, with
    ``all_fields``, when it is ``Sync`` or ``ClientOnly``. ``ClientOnly``
    fields are read-only unless their options say otherwise, and an exposed
    ``ServerOnly`` field must say."""
    names = getattr(cls, "FIELD_NAMES", ())
    if not names:
        return {}  # StateDataModel itself
    listed = mcp_options.class_options(cls)["properties"]
    all_fields = mcp_model_options(cls)["all_fields"]
    ordered = {}
    for klass in reversed(cls.__mro__):
        ordered.update((name, None) for name in vars(klass) if name in names)
    result = {}
    for name in [*ordered, *sorted(set(names) - ordered.keys())]:
        descriptor = _descriptor(cls, name)
        if name in cls.CLIENT_ONLY_NAMES:
            descriptor_type = "client_only"
        elif name in cls.CLIENT_NAMES:
            descriptor_type = "sync"
        else:
            descriptor_type = "server_only"
        checker = cls.TYPE_CHECKING.get(name)
        result[name] = Field(
            name=name,
            type_def=checker.type_def if checker else None,
            options=_exposed(
                cls,
                name,
                _option(cls, name),
                listed.get(name),
                all_fields,
                descriptor_type,
            ),
            nullable=getattr(descriptor, "_default", _MISSING) is None,
            holds_objects=name in cls.DATACLASS_NAMES
            or bool(getattr(descriptor, "_has_dataclass", False)),
        )
    return result
