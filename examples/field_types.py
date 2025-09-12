"""
This example is not working yet
"""

from trame_server.core import Server

from trame.app import TrameApp
from trame.ui.html import DivLayout
from trame.widgets import html
from trame_dataclass.core import (
    ClientOnlyFieldError,
    FieldMode,
    StateDataModel,
    field,
    watch,
)


class MixFields(StateDataModel):
    normal: tuple[float, float, float] = (1.0, 0.0, 0.0)
    mixed_type: tuple[bool, int, float, str] = (False, 10, 3.14159, "Hello")
    server_only: Server | None = field(mode=FieldMode.SERVER_ONLY)
    client_only: int = field(default=0, mode=FieldMode.CLIENT_ONLY)

    @watch("server_only")
    def _on_server_bound(self, server):
        print("Server has been bound", server)


class MixFieldsApp(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        self.data = MixFields(self.server)

        try:
            self.data.client_only  # noqa: B018
        except ClientOnlyFieldError:
            pass
        else:
            msg = "Client only field should not be accessible in Python"
            raise Exception(msg)

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
