from trame.ui.html import DivLayout

from trame.app import TrameApp
from trame.widgets import dataclass as dcw
from trame.widgets import html
from trame_dataclass.v2 import StateDataModel, Sync


class Node(StateDataModel):
    name = Sync(str)
    children = Sync(list["Node"], list, has_dataclass=True)


class TestNestedLoading(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)

        self.data_1 = Node(
            self.server,
            name="a",
            children=[
                Node(
                    self.server,
                    name="aa",
                    children=[
                        Node(self.server, name="aaa", children=[]),
                        Node(self.server, name="aab", children=[]),
                    ],
                ),
                Node(
                    self.server,
                    name="ab",
                    children=[
                        Node(self.server, name="aba", children=[]),
                        Node(self.server, name="abb", children=[]),
                    ],
                ),
            ],
        )
        self.data_2 = Node(
            self.server,
            name="b",
            children=[
                Node(
                    self.server,
                    name="ba",
                    children=[
                        Node(self.server, name="baa", children=[]),
                        Node(self.server, name="bab", children=[]),
                    ],
                ),
                Node(
                    self.server,
                    name="bb",
                    children=[
                        Node(self.server, name="bba", children=[]),
                        Node(self.server, name="bbb", children=[]),
                    ],
                ),
            ],
        )

        self._build_ui()

    def _build_ui(self):
        with DivLayout(self.server) as self.ui:
            html.Button("Reset", click="active_id = null")
            html.Button("A", click=f"active_id = '{self.data_1._id}'")
            html.Button("B", click=f"active_id = '{self.data_2._id}'")
            html.Span("{{ active_id }}")

            with dcw.Provider(
                name="tree",
                instance=("active_id", None),
            ):
                html.Div("{{ tree.children[0].children[0].name }}")
                html.Div("{{ tree.children[0].children[1].name }}")
                html.Div("{{ tree.children[1].children[0].name }}")
                html.Div("{{ tree.children[1].children[1].name }}")
                html.Pre("{{ JSON.stringify(tree, null, 2) }}")

            with dcw.Provider(
                name="tree",
                instance=("active_id", None),
                always=True,
            ):
                with html.Template(v_if="tree_available"):
                    html.Div("{{ tree.children[0].children[0].name }}")
                    html.Div("{{ tree.children[0].children[1].name }}")
                    html.Div("{{ tree.children[1].children[0].name }}")
                    html.Div("{{ tree.children[1].children[1].name }}")
                    html.Pre("{{ JSON.stringify(tree, null, 2) }}")


def main():
    app = TestNestedLoading()
    app.server.start()


if __name__ == "__main__":
    main()
