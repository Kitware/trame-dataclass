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


def _to_react_bind(react, instance):
    """Normalize the Vue-flavored `instance=` shorthand into a `react.Bind`.

    Vue's binding idiom for ``instance=`` is a tuple: ``(js_expr,)`` for a bare
    expression, or ``(state_key, default)`` when ``state_key`` doubles as the
    key to default. React has no such tuple shorthand (`react.py`'s prop
    serialization only special-cases `Bind`/`Callback`/`Slot` instances), so
    this converts either form - or a plain string, or an already-built
    `Bind` - into the `react.Bind` the react tree actually needs.
    """
    if instance is None:
        return react.Bind("undefined")
    if isinstance(instance, react.Bind):
        return instance
    if isinstance(instance, str):
        return react.Bind(instance)
    if isinstance(instance, tuple):
        js_expr = instance[0]
        if len(instance) > 1 and js_expr.isidentifier():
            return react.Bind(js_expr, **{js_expr: instance[1]})
        return react.Bind(js_expr)
    msg = f"Unsupported `instance=` value for client_type='react': {instance!r}"
    raise TypeError(msg)


class Provider(HtmlElement):
    """Wraps a ``StateDataModel`` instance and exposes it under a custom scope name.

    Within the ``with`` block, the bound model is available as the variable *name* and a
    boolean ``{name}_available`` indicates whether the instance has been received by the
    client. This works the same way under ``client_type="vue2"``/``"vue3"`` (a scoped Vue
    slot) and ``"react"`` (a ``react.Slot`` render-prop, see ``react.py``'s scoped-slot
    design) - the ``with Provider(...):`` syntax is identical either way.

    Two common patterns:

    1. **Fixed instance** — use the ``provide_as`` shorthand on the model itself::

        with model.provide_as("user"):
            vuetify.VTextField(v_model=("user.name",))

    2. **Reactive instance** — bind to a trame state variable that holds the instance ID,
       so the provided model can change at runtime::

        with dataclass.Provider(name="active_user", instance=("active_user_id", None)):
            html.Pre("{{ JSON.stringify(active_user, null, 2) }}")

    Under ``client_type="react"`` specifically: a value read off a Provider-exposed
    scope var only triggers a re-render of the subtree whose *own* Provider is
    watching that instance id (unlike a trame *state* key, which is watched
    globally). A record nested inside another instance - e.g. an item read out of a
    ``list[Person]`` container field - already carries the right values, but won't
    pick up edits made to that same record through a *different* Provider elsewhere
    on the page unless it's *also* wrapped in its own ``Provider(instance=<that
    record>._id)``. Wrap each row of a list with its own ``Provider`` when other
    parts of the UI might edit the same instances.
    """

    def __init__(self, name, **kwargs):
        """Args:
        name: variable name under which the dataclass instance is exposed within
            the ``with`` block (and ``{name}_available`` for its availability flag).
        **kwargs: additional element attributes, notably ``instance`` when binding to
            a reactive state variable instead of a fixed model.
            ``always`` can be provided and set to True when you want to always display the template even when data is not available.
        """
        instance = kwargs.pop("instance", None)
        always = kwargs.pop("always", False)

        super().__init__(
            "trame-dataclass",
            **kwargs,
        )

        self._scope_names = [name, f"{name}_available"]
        self._is_react = self.server.client_type == "react"

        if self._is_react:
            from trame_client.widgets import react  # noqa: PLC0415

            self._react = react
            self.props += ["instance", "always", "render"]
            self["instance"] = _to_react_bind(react, instance)
            self["always"] = always
        else:
            self._attr_names += ["instance", "always"]
            if instance is not None:
                self["instance"] = instance
            self["always"] = always
            self._attributes["slot"] = (
                f'v-slot="{{ dataclass: {name}, dataclassAvailable: {name}_available }}"'
            )

    def __exit__(self, exc_type, exc_value, exc_traceback):
        if self._is_react:
            # No runtime template compiler => the children captured within
            # this `with` block can't stay as ordinary DOM children of the
            # "trame-dataclass" tag (unlike Vue's scoped slot, which the
            # client compiles from a template string at runtime): they're
            # handed to the client as a `render` prop instead - a
            # react.Slot capturing exactly this block's content, invoked
            # client-side as `render(data, available)` (see
            # react-components/src/TrameDataclass.jsx).
            slot = self._react.Slot(
                params=self._scope_names,
                connect_parent=False,
                trame_server=self.server,
            )
            slot.add_children(self._children)
            self["render"] = slot.to_json(self.server)
            self._children = []
        super().__exit__(exc_type, exc_value, exc_traceback)


class Gui(HtmlElement):
    """Renders the auto-generated GUI template for a ``StateDataModel`` instance.

    The component looks up the class definition registered for the bound instance and
    renders the Vue template returned by :meth:`~StateDataModel.generate_gui`.  Bind
    the target instance via the ``instance`` attribute::

        dataclass.Gui(instance=(f"'{model._id}'",))

    Not available under ``client_type="react"``: :meth:`~StateDataModel.generate_gui`
    returns a Vue template string, and React has no runtime template compiler to turn
    it into a widget tree. Build the UI by hand with :class:`Provider` plus
    ``trame.widgets.html``/``react`` widgets instead.
    """

    def __init__(self, **kwargs):
        """Args:
        **kwargs: element attributes; use ``instance`` to bind the model instance ID.
        """
        super().__init__(
            "trame-dataclass-gui",
            **kwargs,
        )
        if self.server.client_type == "react":
            msg = (
                "dataclass.Gui is not supported under client_type='react': "
                "StateDataModel.generate_gui()/TEMPLATE produce a Vue template "
                "string, and React has no runtime template compiler to render it. "
                "Build the UI by hand with dataclass.Provider plus "
                "trame.widgets.html/react widgets instead."
            )
            raise NotImplementedError(msg)
        self._attr_names += ["instance"]
