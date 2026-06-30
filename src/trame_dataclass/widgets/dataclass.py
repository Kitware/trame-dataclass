from trame_client.widgets.core import AbstractElement

from .. import module


class HtmlElement(AbstractElement):
    """Base trame widget that ensures the dataclass client module is loaded on the server."""

    def __init__(self, _elem_name, version="v2", children=None, **kwargs):
        """Register the dataclass module with the server when a widget is instantiated.

        Args:
            _elem_name: Vue component element name.
            version: protocol version to activate (``"v1"`` or ``"v2"``).
            children: optional child widgets.
            **kwargs: additional element attributes forwarded to ``AbstractElement``.
        """
        super().__init__(_elem_name, children, **kwargs)
        if self.server:
            self.server.enable_module(module, version=version)


__all__ = [
    "Gui",
    "Provider",
]


class Provider(HtmlElement):
    """Wraps a ``StateDataModel`` instance and exposes it to a scoped Vue slot.

    Within the slot, the bound model is available as the variable *name* and a boolean
    ``{name}_available`` indicates whether the instance has been received by the client.

    Two common patterns:

    1. **Fixed instance** — use the ``provide_as`` shorthand on the model itself::

        with model.provide_as("user"):
            vuetify.VTextField(v_model=("user.name",))

    2. **Reactive instance** — bind to a trame state variable that holds the instance ID,
       so the provided model can change at runtime::

        with dataclass.Provider(name="active_user", instance=("active_user_id", None)):
            html.Pre("{{ JSON.stringify(active_user, null, 2) }}")
    """

    def __init__(self, name, **kwargs):
        """Args:
        name: Vue slot variable name under which the dataclass instance is exposed.
        **kwargs: additional element attributes, notably ``instance`` when binding to
            a reactive state variable instead of a fixed model.
            ``always`` can be provided and set to True when you want to always display the template even when data is not available.
        """
        super().__init__(
            "trame-dataclass",
            **kwargs,
        )
        self._attr_names += ["instance", "always"]
        self._attributes["slot"] = (
            f'v-slot="{{ dataclass: {name}, dataclassAvailable: {name}_available }}"'
        )


class Gui(HtmlElement):
    """Renders the auto-generated GUI template for a ``StateDataModel`` instance.

    The component looks up the class definition registered for the bound instance and
    renders the Vue template returned by :meth:`~StateDataModel.generate_gui`.  Bind
    the target instance via the ``instance`` attribute::

        dataclass.Gui(instance=(f"'{model._id}'",))
    """

    def __init__(self, **kwargs):
        """Args:
        **kwargs: element attributes; use ``instance`` to bind the model instance ID.
        """
        super().__init__(
            "trame-dataclass-gui",
            **kwargs,
        )
        self._attr_names += ["instance"]
