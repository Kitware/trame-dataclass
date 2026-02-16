"""
This example is not working yet
"""

from trame_server.core import Server

from trame.app import TrameApp
from trame.ui.html import DivLayout
from trame.widgets import html
from trame_dataclass.v2 import (
    ClientOnly,
    ServerOnly,
    StateDataModel,
    Sync,
    watch,
)


class MixFields(StateDataModel):
    normal = Sync(tuple[float, float, float], (1.0, 0.0, 0.0))
    mixed_type = Sync(tuple[bool, int, float, str], (False, 10, 3.14159, "Hello"))
    server_only = ServerOnly(Server | None)
    client_only = ClientOnly(int, 0)

    @watch("server_only")
    def _on_server_bound(self, server):
        print("Server has been bound", server)

    @watch("client_only")
    def _on_client_only(self, client_only):
        print("client_only", client_only)


class MixFieldsApp(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        self.data = MixFields(self.server)
        self.data.server_only = self.server  # server is not serializable
        self._build_ui()

    def _build_ui(self):
        with DivLayout(self.server) as self.ui:
            with self.data.provide_as("data"):
                html.Pre("{{ JSON.stringify(data, null,2) }}")
                html.Input(
                    type="range",
                    min=0,
                    max=120,
                    step=1,
                    v_model_number="data.client_only",
                )


def main():
    app = MixFieldsApp()
    app.server.start()


if __name__ == "__main__":
    main()
