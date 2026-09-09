from trame.ui.html import DivLayout

from trame.app import TrameApp
from trame.widgets import html, react
from trame_dataclass.v2 import StateDataModel, Sync
from trame_dataclass.widgets import dataclass


class Person(StateDataModel):
    first_name = Sync(str, "John")
    last_name = Sync(str, "Doe")


class AddressBook(StateDataModel):
    contacts = Sync(list[Person], list, has_dataclass=True)


class AddressBookApp(TrameApp):
    def __init__(self, server=None):
        super().__init__(server, client_type="react")
        self.address_book = AddressBook(self.server)
        self.state.selected = None
        self._build_ui()

    def add_person(self):
        new_person = Person(self.server)
        self.address_book.contacts = [new_person, *self.address_book.contacts]
        self.state.selected = new_person._id

    def remove_selected(self):
        selected = self.state.selected
        self.address_book.contacts = [
            p for p in self.address_book.contacts if p._id != selected
        ]
        self.state.selected = None

    def _build_ui(self):
        with DivLayout(self.server) as self.ui:
            with html.Div(style={"display": "flex", "gap": "12px", "padding": "12px"}):
                html.Button("Add contact", on_click=react.Callback(self.add_person))
                html.Button(
                    "Remove selected",
                    on_click=react.Callback(self.remove_selected),
                )

            # `addressBook` is the custom scope name: same `provide_as`
            # helper as the Vue version, unchanged.
            with self.address_book.provide_as("addressBook"):
                with html.Ul():
                    # A dataclass-container field (`contacts`) already
                    # resolves to an array of live, linked Person records on
                    # the client, so `contact` below already has the right
                    # values. But under react, a value read off a Provider-
                    # exposed scope var (unlike a trame *state* key) only
                    # triggers a re-render of the subtree whose OWN Provider
                    # is watching that instance id - so each row needs its
                    # own nested Provider(instance=contact._id) to pick up
                    # edits made elsewhere (e.g. the detail panel below).
                    with react.For(
                        items=react.Bind("addressBook.contacts"), name="contact"
                    ):
                        with dataclass.Provider(
                            name="row", instance=react.Bind("contact._id")
                        ):
                            html.Li(
                                [
                                    react.Bind("row.first_name"),
                                    " ",
                                    react.Bind("row.last_name"),
                                ],
                                on_click=react.Callback("selected = row._id"),
                                style={"cursor": "pointer"},
                            )

            # `item`/`item_available` is the custom scope name for the
            # currently-selected contact, bound to a plain trame state key
            # (`selected`) that changes at runtime.
            with dataclass.Provider(
                name="item", instance=react.Bind("selected"), always=True
            ):
                with react.If(value="item_available"):
                    with html.Div(style={"padding": "12px"}):
                        html.Label("First name: ")
                        html.Input(
                            value=react.Bind("item.first_name"),
                            on_change=react.Callback(
                                "item.first_name = $event.target.value"
                            ),
                        )
                        html.Br()
                        html.Label("Last name: ")
                        html.Input(
                            value=react.Bind("item.last_name"),
                            on_change=react.Callback(
                                "item.last_name = $event.target.value"
                            ),
                        )
                with react.If(value="!item_available"):
                    html.Div(
                        "No contact selected",
                        style={"padding": "12px", "color": "gray"},
                    )


def main():
    app = AddressBookApp()
    app.server.start()


if __name__ == "__main__":
    main()
