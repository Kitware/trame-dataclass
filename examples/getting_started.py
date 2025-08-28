from trame.app import TrameApp, trame_dataclass
from trame.ui.html import DivLayout
from trame.widgets import html


@trame_dataclass
class SimpleStructure:
    name: str = "John Doe"
    age: int = 1
    derived_value: int


class GettingStarted(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        self._data = SimpleStructure()
        self._data.watch(["age"], self._compute_derived)
        self._build_ui()

    def _compute_derived(self, age):
        self._data.derived_value = 80 - age

    def _build_ui(self):
        with DivLayout(self.server) as self.ui:
            html.Div("Getting started with trame_dataclass")
            with self._data.Provider(name="user"):
                html.Div(
                    "Hello {{ user.name }} - derived value = {{ user.derived_value }}"
                )
                html.Hr()
                html.Span("Your name:")
                html.Input(type="text", v_model="user.name")
                html.Hr()
                html.Span("Your age:")
                html.Input(type="range", min=0, max=120, step=1, v_model="user.age")


def main():
    app = GettingStarted()
    app.server.start()


if __name__ == "__main__":
    main()
