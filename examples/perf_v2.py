import time

from trame.app import TrameApp
from trame.ui.html import DivLayout
from trame.widgets import html
from trame_dataclass.v2 import StateDataModel, Sync, watch


class Data(StateDataModel):
    value = Sync(int, 1)

    @watch("value")
    def _fake_busy(self, _):
        time.sleep(0.1)


class Test(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        self.data_1 = Data(self.server, enable_collaboration=True)
        self.data_2 = Data(self.server, enable_collaboration=False)
        self._build_ui()

    def _build_ui(self):
        with DivLayout(self.server) as self.ui:
            with self.data_1.provide_as("data_slow"):
                with self.data_2.provide_as("data_fast"):
                    html.Div("Collaboration ON: {{ data_slow.value }}")
                    html.Input(
                        type="range",
                        v_model_number="data_slow.value",
                        min=0,
                        max=500,
                        step=1,
                        style="width: 100%",
                    )
                    html.Div("Collaboration OFF (default): {{ data_fast.value }}")
                    html.Input(
                        type="range",
                        v_model_number="data_fast.value",
                        min=0,
                        max=200,
                        step=1,
                        style="width: 100%",
                    )


def main():
    app = Test()
    app.server.start()


if __name__ == "__main__":
    main()
