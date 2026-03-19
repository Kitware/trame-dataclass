# /// script
# requires-python = ">=3.13"
# dependencies = [
#     "numpy",
#     "plotly",
#     "pandas<3",
#     "trame",
#     "trame-dataclass",
#     "trame-plotly",
# ]
# ///
import asyncio
import time

import numpy as np
import pandas as pd
import plotly.express as px

from trame.app import TrameApp
from trame.decorators import change
from trame.ui.html import DivLayout
from trame.widgets import client, html, plotly
from trame_dataclass.v2 import StateDataModel, Sync, watch

TITLE = "dt (ms)"


def now():
    return int(1000 * time.perf_counter())


class Timestamp(StateDataModel):
    origin = Sync(int, now())
    client = Sync(int, 0)
    buffer_size = Sync(int, 100)
    delta = Sync(int, 0)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.buffer_index = 0
        self.buffer_values = np.zeros((100,), dtype=np.uint16)

    # @watch("client")
    # def _on_client(self, client):
    #     self.delta = now() - client

    @watch("delta", sync=True)
    def _on_delta(self, delta):
        self.buffer_index += 1
        if self.buffer_index >= self.buffer_size:
            self.buffer_index = 0
        self.buffer_values[self.buffer_index] = delta


class LagAnalyser(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        self.pending_tasks = set()
        self.state.client_ts = 0
        self.ts = Timestamp(self.server)
        self.ts.watch(["client"], self.client_update)
        self._build_ui()

    def update_plot(self):
        data = pd.DataFrame(
            self.ts.buffer_values[: self.ts.buffer_size],
            columns=[TITLE],
        )
        fig = px.violin(data, y=TITLE)
        fig.update_layout(yaxis_range=[0, 20])
        with self.state:
            self.ctx.figure.update(fig)

    def client_update(self, ts):
        self.ts.delta = now() - ts
        self.update_plot()

    @change("client_ts")
    def _on_ts_change(self, client_ts, **_):
        if client_ts:
            self.ts.delta = now() - client_ts
            self.update_plot()

    @change("animate")
    def on_animate(self, animate, **_):
        if animate:
            task = asyncio.create_task(self._animate())
            self.pending_tasks.add(task)
            task.add_done_callback(self.pending_tasks.discard)

    async def _animate(self):
        while self.state.animate:
            await asyncio.sleep(int(self.state.wait_ms) / 1000)
            self.ts.origin = now()

    def _build_ui(self):
        with DivLayout(self.server) as self.ui:
            with self.ts.provide_as("ts"):
                html.Button(
                    "Stop",
                    v_if=("animate", False),
                    click="animate = !animate",
                )
                html.Button(
                    "Start",
                    v_else=True,
                    click="animate = !animate",
                )
                html.Input(
                    type="checkbox",
                    v_model=("use_dataclass", True),
                )
                html.Input(
                    v_model=("wait_ms", 100),
                    min=5,
                    max=100,
                    step=1,
                    type="range",
                )
                html.Input(
                    v_model_number="ts.buffer_size",
                    min=5,
                    max=100,
                    step=1,
                    type="range",
                )
                html.Span(
                    "{{ ts.buffer_size }} buffer | {{ wait_ms }} ms / {{ (1000 / wait_ms).toFixed(2) }} fps"
                )

                client.ClientStateChange(
                    v_if="use_dataclass",
                    value="ts.origin",
                    change="ts.client = $event",
                )
                client.ClientStateChange(
                    v_else=True,
                    value="ts.origin",
                    change="client_ts = $event",
                )
                html.Div("Delta: {{ ts.delta }}")
                plotly.Figure(ctx_name="figure")


def main():
    app = LagAnalyser()
    app.server.start()


if __name__ == "__main__":
    main()
