from trame_client.widgets.core import AbstractElement

from .. import module


class HtmlElement(AbstractElement):
    def __init__(self, _elem_name, children=None, **kwargs):
        super().__init__(_elem_name, children, **kwargs)
        if self.server:
            self.server.enable_module(module)


__all__ = [
    "Provider",
]


# Expose your vue component(s)
class Provider(HtmlElement):
    def __init__(self, name, **kwargs):
        super().__init__(
            "trame-dataclass",
            **kwargs,
        )
        self._attr_names += ["instance"]
        self._attributes["slot"] = (
            f'v-slot="{{ dataclass: {name}, dataclassAvailable: {name}_available }}"'
        )
