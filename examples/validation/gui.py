from trame.ui.html import DivLayout

from trame.app import TrameApp
from trame.widgets import dataclass as dcw
from trame.widgets import html
from trame_dataclass.v2 import StateDataModel, Sync, watch


class ObjectABC(StateDataModel):
    a = Sync(int, 1)
    b = Sync(int, 2)
    c = Sync(int, 3)
    TEMPLATE = """
        <div style="display:flex;flex-align-items: center;">
           <input type="range" v-model.number="self.a" min="0" step="1" max="100" /> +
           <input type="range" v-model.number="self.b" min="0" step="1" max="100" /> +
           <input type="range" v-model.number="self.c" min="0" step="1" max="100" /> =
           {{ self.a + self.b + self.c }}
        </div>
    """


class ObjectDE(StateDataModel):
    d = Sync(str, "Hello")
    e = Sync(str, "World")

    TEMPLATE = """
        <div>
          <input v-model="self.d" />
          <input v-model="self.e" />
          => {{ self.d }} {{ self.e }}
        </div>
    """


class ObjectF(StateDataModel):
    f = Sync(list[int], list, client_deep_reactive=True)

    TEMPLATE = """
        <div>
          <input v-model="self.f[i - 1]" v-for="i in self.f.length" key="i"/>
        </div>
    """

    @watch("f")
    def _on_change(self, f):
        print(f)


class TestGUI(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)

        self.data_1 = ObjectABC(self.server)
        self.data_2 = ObjectDE(self.server)
        self.data_3 = ObjectF(self.server, f=[1, 2, 3])
        self._build_ui()

    def _build_ui(self):
        with DivLayout(self.server) as self.ui:
            html.Button("Reset", click="active_id = null")
            html.Button("Math", click=f"active_id = '{self.data_1._id}'")
            html.Button("Hello", click=f"active_id = '{self.data_2._id}'")
            html.Button("List", click=f"active_id = '{self.data_3._id}'")
            html.Span("{{ active_id }}")

            dcw.Gui(instance=("active_id", self.data_2._id))


def main():
    app = TestGUI()
    app.server.start()


if __name__ == "__main__":
    main()
