from trame.ui.html import DivLayout

from trame.app import TrameApp
from trame.widgets import html, vuetify3
from trame_dataclass.v2 import StateDataModel, Sync, get_instance

DEFAULT_AGE_VALUE = 25


class UserInfo(StateDataModel):
    age = Sync(int, DEFAULT_AGE_VALUE)
    eye_color = Sync(str, "brown")


class User(StateDataModel):
    first_name = Sync(str, "John")
    last_name = Sync(str, "Doe")
    info = Sync(UserInfo, has_dataclass=True)


class AddressBook(StateDataModel):
    contacts = Sync(list[User], list, has_dataclass=True)


class GettingStarted(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        self._book = AddressBook(self.server)
        user_1_info = UserInfo(self.server)
        user_1_info.watch(("age",), print)
        user_1 = User(self.server, info=user_1_info)
        self._book.contacts.append(user_1)

        self._build_ui()

    def _reset_age(self, user_info_id):
        user_info = get_instance(user_info_id)
        user_info.age = DEFAULT_AGE_VALUE

    def _build_ui(self):
        with DivLayout(self.server) as self.ui:
            with self._book.provide_as("book"):
                with html.Ul(
                    v_for="user, i in book.contacts",
                    key="i",
                ):
                    with html.Li(
                        "{{ user.first_name }} {{ user.last_name }} ({{ user.info.age }}, {{ user.info.eye_color }})",
                    ):
                        vuetify3.VTextField(v_model=("user.first_name",))
                        vuetify3.VSlider(
                            v_model=("user.info.age",), min=0, max=100, step=1
                        )
                        vuetify3.VBtn(
                            text="Reset JS",
                            click=f"user.info.age = {DEFAULT_AGE_VALUE}",
                        )
                        vuetify3.VBtn(
                            text="Reset python",
                            click=(self._reset_age, "[user.info._id]"),
                        )


def main():
    app = GettingStarted()
    app.server.start()


if __name__ == "__main__":
    main()
