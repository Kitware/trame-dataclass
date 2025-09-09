from trame.app import TrameApp
from trame.ui.html import DivLayout
from trame.widgets import html
from trame_dataclass.core import TrameStateDataModel


class User(TrameStateDataModel):
    first_name: str = "John"
    last_name: str = "Doe"
    age: int = 1


class AddressBook(TrameStateDataModel):
    list_of_things: list
    list_of_int: list[int]
    contacts: list[User]
    map: dict[str, User]
    active: User | None


class GettingStarted(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        self._book = AddressBook(self.server)
        self._edit = User(self.server)
        self._build_ui()

        # show that server dataclass selection can be monitored
        self._book.watch(("active",), self.on_active)
        self._book.watch(("contacts",), self.on_contacts_change)

    def on_active(self, user: User | None):
        print("-" * 60)
        print("!!! active user !!!")
        print(user)
        print("-" * 60)

        with self.state:
            self.state.active_id = None if user is None else user._id

    def on_contacts_change(self, contacts: list[User] | None):
        print("contacts:", [v._id for v in contacts])

    def remove_active(self):
        self._book.active = None

    def add_user(self):
        self._book.contacts = [*self._book.contacts, self._edit.clone()]

    def _build_ui(self):
        with DivLayout(self.server) as self.ui:
            html.Div("Active User")
            with self._edit.Provider(name="user"):
                html.Span("First name:")
                html.Input(type="text", v_model="user.first_name")
                html.Span("Last name:")
                html.Input(type="text", v_model="user.last_name")
                html.Span("Age:")
                html.Input(
                    type="range", min=0, max=120, step=1, v_model_number="user.age"
                )
            html.Div(style="height: 1rem;")
            html.Button("Add user to book", click=self.add_user)
            html.Button("Remove Active", click=self.remove_active)
            html.Hr()
            html.Div("Active user")
            with self._book.Provider(name="book"):
                html.Pre("{{ JSON.stringify(book.active, null, 2) }}")
            html.Hr()
            html.Div("Contacts")
            with self._book.Provider(name="book"):
                with html.Ul():
                    with html.Li(
                        "({{ user._id }}) {{ user.first_name }} {{ user.last_name }} ({{ user.age }})",
                        v_for="user, i in book.contacts",
                        key="i",
                    ):
                        html.Button("activate", click="book.active = user")
                        html.Button(
                            "delete",
                            click="book.contacts = book.contacts.filter(v => v !== user)",
                        )
            html.Hr()
            html.Div("Edit active [{{ active_id }}]")
            with self._book.Provider(name="active", instance=("active_id", None)):
                with html.Template(v_if="active_available"):
                    html.Span("First name:")
                    html.Input(type="text", v_model="active.first_name")
                    html.Span("Last name:")
                    html.Input(type="text", v_model="active.last_name")
                    html.Span("Age:")
                    html.Input(
                        type="range",
                        min=0,
                        max=120,
                        step=1,
                        v_model_number="active.age",
                    )


def main():
    app = GettingStarted()
    app.server.start()


if __name__ == "__main__":
    main()
