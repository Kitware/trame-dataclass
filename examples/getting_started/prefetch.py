#!/usr/bin/env -S uv run --script
#
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "trame",
#     "trame-dataclass>=2",
# ]
# ///
#
# Nested providers hydrate one after another: each one only shows its slot once its
# own instance has arrived, so the one inside it is not even created until then.
#
#   python prefetch.py --server              # wrapped in a Prefetch (default)
#   python prefetch.py --server --serial     # the same page without it
#
# Both pages end up identical. Only the shape of the loading differs: one wave of
# requests, or a chain of replies as long as the nesting.

import sys
from contextlib import ExitStack

from trame.ui.html import DivLayout

from trame.app import TrameApp
from trame.app.dataclass import StateDataModel, Sync
from trame.widgets import dataclass, html

DEPTH = 20


class Section(StateDataModel):
    title = Sync(str, "")


class Nested(TrameApp):
    def __init__(self, server=None, prefetch=True):
        super().__init__(server)
        self.sections = [
            Section(self.server, title=f"section {i}") for i in range(DEPTH)
        ]
        self._build_ui(prefetch)

    def _build_ui(self, prefetch):
        with DivLayout(self.server), ExitStack() as stack:
            if prefetch:
                stack.enter_context(
                    dataclass.Prefetch(
                        instances=[section._id for section in self.sections]
                    )
                )
            for i, section in enumerate(self.sections):
                stack.enter_context(section.provide_as(f"s{i}"))
                html.Div(f"{{{{ s{i}.title }}}}", id=f"s{i}")


if __name__ == "__main__":
    app = Nested(prefetch="--serial" not in sys.argv)
    app.server.start()
