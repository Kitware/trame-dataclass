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

from typing import Any

from trame.ui.html import DivLayout

from trame.app import TrameApp
from trame.app.dataclass import ClientOnly, ServerOnly, StateDataModel, Sync, watch
from trame.widgets import dataclass, html


class SimpleStructure(StateDataModel):
    name = Sync(str, "John Doe")  # server <=> client
    age = Sync(int, 1)  # server <=> client
    derived_value = Sync(int)  # server <=> client
    something = ServerOnly(Any)  # server
    local_edit = ClientOnly(int)  # server => client

    @watch("age")
    def _update_derived(self, age):
        self.derived_value = 80 - age

    @watch("local_edit")
    def _never_called(self, local_edit):
        print("local_edit changed to", local_edit)


class GettingStarted(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        self._data = SimpleStructure(self.server)
        self._data.watch(["age"], self.print_age)
        self._build_ui()

    def print_age(self, age):
        print(f"Age changed to {age=}")

    def toggle_active_user(self):
        if self.state.active_user:
            self.state.active_user = None
        else:
            self.state.active_user = self._data._id

    def _modify_data(self):
        self._data.age += 1

    def _build_ui(self):
        with DivLayout(self.server) as self.ui:
            # Edit user on server
            html.Button("Server change", click=self._modify_data)

            # Provide data class instance to the UI as a variable
            with self._data.provide_as("user"):
                html.Button("Edit local", click="user.local_edit = Date.now()")

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
            html.Hr()

            # Adjust dynamic user
            html.Button(
                "Toggle user ({{ active_user || 'None' }})",
                click=self.toggle_active_user,
            )

            # Dynamically provide a dataclass to UI
            with dataclass.Provider(
                name="dynamic_user",
                instance=("active_user", None),
            ):
                html.Pre("{{ JSON.stringify(dynamic_user, null, 2) }}")


def main():
    app = GettingStarted()
    app.server.start()


if __name__ == "__main__":
    main()
