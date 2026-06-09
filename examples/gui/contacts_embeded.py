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

from trame.ui.vuetify3 import SinglePageWithDrawerLayout

from trame.app import TrameApp
from trame.widgets import vuetify3 as v3

# from trame.app.dataclass import StateDataModel, Sync
from trame_dataclass.v2 import StateDataModel, Sync
from trame_dataclass.widgets import dataclass


class Person(StateDataModel):
    first_name = Sync(str, "John")
    last_name = Sync(str, "Doe")

    @classmethod
    def generate_gui(cls, trame_server=None) -> str:
        with v3.VCard(
            trame_server=trame_server,
            v_if="self_available && self._id",
            classes="ma-4",
        ) as root:
            with v3.VContainer():
                with v3.VRow():
                    with v3.VCol():
                        v3.VTextField(
                            v_model="self.first_name",
                            label="First Name",
                        )
                    with v3.VCol():
                        v3.VTextField(
                            v_model="self.last_name",
                            label="Last Name",
                        )
        return root.html


class AddressBook(StateDataModel):
    contacts = Sync(list[Person], list, has_dataclass=True)


class AddressBookApp(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        self.address_book = AddressBook(self.server)
        self._build_ui()

    def add_person(self):
        new_person = Person(self.server)
        self.address_book.contacts = [new_person, *self.address_book.contacts]
        self.state.selected = [new_person._id]

    def remove_person(self):
        id_to_discard = set(self.state.selected)
        self.address_book.contacts = [
            p for p in self.address_book.contacts if p._id not in id_to_discard
        ]
        self.state.selected = []

    def _build_ui(self):
        with SinglePageWithDrawerLayout(self.server, full_height=True) as self.ui:
            self.ui.title.set_text("Address Book")
            with self.ui.toolbar:
                v3.VSpacer()
                v3.VBtn(
                    icon="mdi-minus",
                    disabled=("!selected?.length",),
                    click=self.remove_person,
                )
                v3.VBtn(icon="mdi-plus", click=self.add_person)

            with self.ui.drawer:
                with self.address_book.provide_as("addressBook"):
                    with v3.VList(
                        density="compact",
                        items=("addressBook.contacts",),
                        item_value="_id",
                        v_model_selected=("selected", None),
                    ):
                        with v3.Template(v_slot_item="{ props }"):
                            with dataclass.Provider(
                                name="item",
                                instance=("props.value",),
                            ):
                                v3.VListItem(
                                    title=("`${item.first_name} ${item.last_name}`",),
                                    value=("item._id",),
                                )

            with self.ui.content:
                dataclass.Gui(instance=("selected?.[0]",))


def main():
    app = AddressBookApp()
    app.server.start()


if __name__ == "__main__":
    main()
