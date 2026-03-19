from trame.app import TrameApp
from trame.ui.vuetify3 import SinglePageWithDrawerLayout
from trame.widgets import vuetify3 as v3
from trame_dataclass.v2 import StateDataModel, Sync, get_instance, watch
from trame_dataclass.widgets import dataclass

# to enable v3.VTreeview()
v3.enable_lab()


# ---------------------------------------------------------
# Trame DataClasses
# ---------------------------------------------------------


class TreeNode(StateDataModel):
    name = Sync(str, "")
    children = Sync(list["TreeNode"] | None, list, has_dataclass=True)

    @watch("name", "children")
    def _on_change(self, name, children):
        print("node", name, children)


class RootNode(StateDataModel):
    children = Sync(list[TreeNode], list, has_dataclass=True)
    actives = Sync(list[str], list)

    @watch("actives", "children")
    def _on_change(self, actives, children):
        print("root node", actives, children)


# ---------------------------------------------------------


def remove_node(current_node, node_to_remove):
    if current_node.children:
        if node_to_remove in current_node.children:
            current_node.children = [
                n for n in current_node.children if n != node_to_remove
            ]
        else:
            for n in current_node.children:
                remove_node(n, node_to_remove)


# ---------------------------------------------------------
# Trame App
# ---------------------------------------------------------
class TreeApp(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        self.root_node = RootNode(self.server)
        self.next_node_id = 1
        self._build_ui()

    @property
    def active_node(self) -> RootNode | TreeNode:
        if len(self.root_node.actives):
            return get_instance(self.root_node.actives[0])
        return self.root_node

    def next_tree_node(self):
        name = f"Node {self.next_node_id}"
        self.next_node_id += 1
        return TreeNode(self.server, name=name)

    def add_node(self):
        node = self.next_tree_node()
        active_node = self.active_node

        if active_node.children is None:
            active_node.children = [node]
            print("first", active_node.children)
        else:
            print("before", active_node.children)
            active_node.children = [*active_node.children, node]
            print("after", active_node.children)

        # Make new node active
        self.root_node.actives = [node._id]

    def delete_node(self):
        if self.active_node is self.root_node:
            return

        node_to_remove = self.active_node
        self.root_node.actives = []
        remove_node(self.root_node, node_to_remove)

    def _build_ui(self):
        with SinglePageWithDrawerLayout(self.server, full_height=True) as self.ui:
            self.ui.title.set_text("Dynamic tree")
            with self.ui.toolbar:
                v3.VSpacer()
                with self.root_node.provide_as("tree"):
                    v3.VBtn(
                        icon="mdi-minus",
                        disabled=("!tree.actives?.length",),
                        click=self.delete_node,
                    )
                v3.VBtn(icon="mdi-plus", click=self.add_node)

            with self.ui.drawer:
                with self.root_node.provide_as("tree"):
                    v3.VTreeview(
                        items=("tree.children",),
                        item_value="_id",
                        item_title="name",
                        density="compact",
                        fluid=True,
                        open_all=True,
                        activatable=True,
                        v_model_activated="tree.actives",
                    )

            with self.ui.content:
                with self.root_node.provide_as("tree"):
                    with v3.VCard(classes="pa-4 ma-4"):
                        with dataclass.Provider(
                            name="active_node", instance=("tree.actives?.[0]",)
                        ):
                            v3.VLabel(
                                "Active node => {{ active_node.name }} ({{ active_node._id }})",
                                v_if="active_node_available",
                            )
                            v3.VLabel("No active node", v_else=True)


def main():
    app = TreeApp()
    app.server.start()


if __name__ == "__main__":
    main()
