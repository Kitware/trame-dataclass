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

from trame.app import TrameApp  # , get_server
from trame.app.dataclass import StateDataModel, Sync, get_instance, watch
from trame.widgets import vuetify3 as v3
from trame_dataclass.widgets import dataclass


class Person(StateDataModel):
    title = Sync(str)
    first_name = Sync(str, "John")
    last_name = Sync(str, "Doe")

    @watch("first_name", "last_name", eager=True)
    def _on_change(self, first_name, last_name):
        self.title = f"{first_name} {last_name}"

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


class Password(StateDataModel):
    title = Sync(str, "New password")
    password = Sync(str, "")

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
                            v_model="self.title",
                            label="Name",
                        )
                    with v3.VCol():
                        v3.VTextField(
                            v_model="self.password",
                            label="Password",
                        )
        return root.html


class Group(StateDataModel):
    title = Sync(str, "New group")
    friends = Sync(list[Person], list, has_dataclass=True)

    @classmethod
    def generate_gui(cls, trame_server=None) -> str:
        with v3.VCard(
            trame_server=trame_server,
            v_if="self_available && self._id",
            classes="ma-4",
        ) as root:
            with v3.VContainer():
                with v3.VRow():
                    v3.VTextField(
                        v_model="self.title",
                        label="Group Name",
                    )
                    v3.VBtn(icon="mdi-plus", click=(cls.add_friend, "[self._id]"))
                with v3.Template(v_for="friend in self.friends", key="friend._id"):
                    dataclass.Gui(instance=("friend._id",))
        return root.html

    @classmethod
    def add_friend(cls, instance_id):
        me = get_instance(instance_id)
        new_friend = Person(me.server)
        me.friends = [new_friend, *me.friends]


class MultiTypes(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        self.instances = []
        self._build_ui()

    def add(self, obj):
        self.instances.append(obj)
        self.state.items.append(obj._id)
        self.state.dirty("items")
        self.state.selected = [obj._id]

    def add_person(self):
        self.add(Person(self.server))

    def add_group(self):
        self.add(Group(self.server))

    def add_password(self):
        self.add(Password(self.server))

    def _build_ui(self):
        with SinglePageWithDrawerLayout(self.server, full_height=True) as self.ui:
            self.ui.title.set_text("Multi Data Types")
            with self.ui.toolbar:
                v3.VSpacer()
                v3.VBtn(icon="mdi-account-plus", click=self.add_person)
                v3.VBtn(icon="mdi-account-multiple-plus", click=self.add_group)
                v3.VBtn(icon="mdi-form-textbox-password", click=self.add_password)

            with self.ui.drawer:
                with v3.VList(
                    density="compact",
                    items=("items", []),
                    v_model_selected=("selected", None),
                ):
                    with v3.Template(v_slot_item="{ props }"):
                        with dataclass.Provider(
                            name="item",
                            instance=("props.title",),
                        ):
                            v3.VListItem(
                                title=("`${item.title}`",),
                                value=("item._id",),
                            )

            with self.ui.content:
                dataclass.Gui(instance=("selected?.[0]",))


def main():
    # main_server = get_server()
    # server = main_server.create_child_server(prefix="child_")
    app = MultiTypes()  # try with server as arg
    app.server.start()


if __name__ == "__main__":
    main()
