# Validation app for the React client: a provider only shows its instance once
# that instance, and every instance it reaches, has arrived.
#
#   python nested_graph_react.py --server --port 8080
#
# Expected page:
#
#   status: loaded   - `tree_available`, read by a provider with always=True
#   deep: b0         - reads two levels down the tree; throws if the provider
#                      renders before the tree has arrived
#   cycle: ping      - reads through two nodes that point at each other; never
#                      appears if the client cannot load a cycle

from trame.ui.html import DivLayout

from trame.app import TrameApp
from trame.widgets import html, react
from trame_dataclass.v2 import StateDataModel, Sync
from trame_dataclass.widgets import dataclass


class Node(StateDataModel):
    name = Sync(str, "")
    peer = Sync(StateDataModel, None, has_dataclass=True)
    children = Sync(list["Node"], list, has_dataclass=True)


class NestedGraph(TrameApp):
    def __init__(self, server=None):
        super().__init__(server, client_type="react")

        def node(name, children=()):
            return Node(self.server, name=name, children=list(children))

        self.tree = node(
            "root",
            [node("a", [node("a0"), node("a1")]), node("b", [node("b0"), node("b1")])],
        )
        self.ping, self.pong = node("ping"), node("pong")
        self.ping.peer, self.pong.peer = self.pong, self.ping
        self._build_ui()

    def _build_ui(self):
        with DivLayout(self.server):
            with dataclass.Provider(
                name="status", instance=(f"'{self.tree._id}'",), always=True
            ):
                with react.If(value="status_available"):
                    html.Div("status: loaded")
                with react.If(value="!status_available"):
                    html.Div("status: loading")

            with self.tree.provide_as("tree"):
                html.Div(["deep: ", react.Bind("tree.children[1].children[0].name")])

            with self.ping.provide_as("loop"):
                html.Div(["cycle: ", react.Bind("loop.peer.peer.name")])


def main():
    app = NestedGraph()
    app.server.start()


if __name__ == "__main__":
    main()
