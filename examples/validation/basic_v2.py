from trame.app import TrameApp
from trame.ui.html import DivLayout
from trame.widgets import html
from trame_dataclass.v2 import StateDataModel, Sync


class SimpleStructure(StateDataModel):
    name = Sync(str, "John Doe")
    age = Sync(int, 1)
    derived_value = Sync(int)


class GettingStarted(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        self._data = SimpleStructure(self.server)
        self._data.watch(["age"], self._compute_derived)
        self._build_ui()

    def _compute_derived(self, age):
        self._data.derived_value = 80 - age

    def _modify_data(self):
        self._data.age += 1

    def _build_ui(self):
        with DivLayout(self.server) as self.ui:
            html.Button("Server change", click=self._modify_data)
            html.Div("Getting started with StateDataModel")
            with self._data.provide_as("user"):
                html.Pre("{{ JSON.stringify(user, null, 2) }}")
                html.Hr()
                html.Div(
                    "Hello {{ user.name }} - derived value = {{ user.derived_value }}"
                )
                html.Hr()
                html.Span("Your name:")
                html.Input(type="text", v_model="user.name")
                html.Hr()
                html.Span("Your age:")
                html.Input(
                    type="range", min=0, max=120, step=1, v_model_number="user.age"
                )


def main():
    app = GettingStarted()
    app.server.start()


if __name__ == "__main__":
    main()
