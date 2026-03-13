import time

from trame.app import TrameApp
from trame.ui.html import DivLayout
from trame.widgets import client, html
from trame_dataclass.v2 import StateDataModel, Sync, watch


class Node(StateDataModel):
    name = Sync(str)
    prev = Sync(StateDataModel, None, has_dataclass=True)
    next = Sync(StateDataModel, None, has_dataclass=True)


class Item(StateDataModel):
    value = Sync(int, 1)
    name = Sync(str, "hello")


class Container(StateDataModel):
    a = Sync(Item, has_dataclass=True)
    b = Sync(Item, has_dataclass=True)
    items = Sync(list[Item], list, has_dataclass=True)
    map = Sync(dict[Item], dict, has_dataclass=True, client_deep_reactive=True)
    loop = Sync(Node, has_dataclass=True)

    @watch("a")
    def _a_change(self, a):
        print("a changed", a)

    @watch("b")
    def _b_change(self, b):
        print("b changed", b)

    @watch("items")
    def _items_change(self, items):
        print("items changed", items)

    @watch("map")
    def _map_change(self, map):
        print("map changed", map)

    @watch("loop")
    def _loop_change(self, loop):
        print("loop changed", loop)


class Test(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        self.data = Container(self.server)
        self.data.a = Item(self.server, value=10)
        self.data.b = Item(self.server, value=20)
        self.data.items = [Item(self.server, value=i) for i in range(3)]
        self.data.map = {f"key_{i}": Item(self.server, value=i) for i in range(3)}

        a = Node(self.server, name="a")
        b = Node(self.server, name="b")
        c = Node(self.server, name="c")
        self.data.loop = a
        a.next = b
        b.next = c
        c.next = a
        a.prev = c
        b.prev = a
        c.prev = b

        self.hold_refs = [self.data.a, self.data.b, a, b, c]
        self._build_ui()

    def add(self):
        self.data.items = [*self.data.items, Item(self.server, value=time.time())]

    def _build_ui(self):
        with DivLayout(self.server) as self.ui:
            client.Script("""
                function swap(data) {
                    const b = data.b;
                    const a = data.a;
                    data.b = a;
                    data.a = b;
                }
            """)
            with self.data.provide_as("data"):
                html.Button("Swap", click="window.swap(data)")
                html.Button("Add", click=self.add)
                html.Button(
                    "Pop",
                    click="data.items = data.items.filter((v,i) => i + 1 < data.items.length)",
                )
                html.Button(
                    "Add keys", click="data.map[Date.now()] = data.map['key_0']"
                )
                html.Button("Next", click="data.loop = data.loop.next")

                html.Div("A: {{ data.a }}")
                html.Div("B: {{ data.b }}")

                with html.Ul():
                    html.Li("{{ item.value }}", v_for="item, i in data.items", key="i")

                with html.Ul():
                    html.Li("{{ k }}: {{ v }}", v_for="v, k in data.map", key="k")

                html.Div("{{ data.loop?.name }}")
                html.Div("{{ data.loop?.next?.name }}")
                html.Div("{{ data.loop?.next?.next?.name }}")
                html.Div("{{ data.loop?.next?.next?.next?.name }}")
                html.Div("{{ data.loop?.next?.next?.next?.next?.name }}")


def main():
    app = Test()
    app.server.start()


if __name__ == "__main__":
    main()
