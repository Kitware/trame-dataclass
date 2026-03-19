#!/usr/bin/env -S uv run --script
#
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "trame",
#     "trame-vuetify>=3.2",
#     "trame-dataclass>=2",
# ]
# ///
from trame.ui.html import DivLayout

from trame.app import TrameApp
from trame.app.dataclass import StateDataModel, Sync, watch
from trame.widgets import html


class Data(StateDataModel):
    values_reactive = Sync(list[int], list, client_deep_reactive=True)
    values = Sync(list[int], list)

    @watch("values_reactive")
    def _on_values_reactive(self, v):
        print("values_reactive", v)

    @watch("values")
    def _on_values(self, _):
        print("values")


class DeepReactive(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        self.data = Data(self.server)
        self.data.values = [1, 2, 3, 4, 5]
        self.data.values_reactive = [1, 2, 3, 4, 5]
        self._build_ui()

    def _build_ui(self):
        with DivLayout(self.server) as self.ui:
            with self.data.provide_as("data"):
                html.Hr()
                html.Div("Regular Array")
                html.Button("Add", click="data.values.push(1)")
                html.Hr()
                with html.Div(v_for="v, i in data.values", key="i"):
                    html.Input(
                        type="range",
                        v_model_number="data.values[i]",
                        min=0,
                        max=10,
                        step=1,
                    )
                    html.Button("+ (js)", click="data.values[i]++")
                    html.Button("- (js)", click="data.values[i]--")
                html.Hr()
                html.Div("Deep reactive Array")
                html.Button("Add", click="data.values_reactive.push(1)")
                html.Hr()
                with html.Div(v_for="v, i in data.values_reactive", key="i"):
                    html.Input(
                        type="range",
                        v_model_number="data.values_reactive[i]",
                        min=0,
                        max=10,
                        step=1,
                    )
                    html.Button("+ (js)", click="data.values_reactive[i]++")
                    html.Button("- (js)", click="data.values_reactive[i]--")
                html.Hr()


def main():
    app = DeepReactive()
    app.server.start()


if __name__ == "__main__":
    main()
