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
# One provider over a graph of 1 library -> 10 shelves -> 20 books (211 instances).
#
# The provider only renders once the whole graph has reached the client, and the
# page reports how long that took. Click "Load", then reload the page to measure
# again: instances are cached for the lifetime of the page.
#
#   python graph_loading.py --server --port 8080
#
# The cost of loading a graph is dominated by round trips, so put some latency
# between the browser and the server to see it as a remote user would.

from trame.ui.html import DivLayout

from trame.app import TrameApp
from trame.widgets import dataclass, html
from trame_dataclass.v2 import StateDataModel, Sync

SHELVES = 10
BOOKS = 20


class Book(StateDataModel):
    title = Sync(str, "")


class Shelf(StateDataModel):
    name = Sync(str, "")
    books = Sync(list[Book], list, has_dataclass=True)


class Library(StateDataModel):
    shelves = Sync(list[Shelf], list, has_dataclass=True)


class GraphLoading(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        self.library = Library(
            self.server,
            shelves=[
                Shelf(
                    self.server,
                    name=f"shelf {s}",
                    books=[
                        Book(self.server, title=f"book {s}.{b}") for b in range(BOOKS)
                    ],
                )
                for s in range(SHELVES)
            ],
        )
        self.state.t0 = 0
        self._build_ui()

    def _build_ui(self):
        with DivLayout(self.server):
            html.Button(
                "Load",
                click=f"t0 = Date.now(); library_id = '{self.library._id}'",
            )
            with dataclass.Provider(name="library", instance=("library_id", None)):
                html.Div(
                    "Loaded {{ library.shelves.length }} shelves "
                    "in {{ Date.now() - t0 }} ms",
                    v_once=True,
                    id="loaded",
                )
                with html.Div(v_for="shelf in library.shelves"):
                    html.B("{{ shelf.name }}: ")
                    html.Span("{{ shelf.books.map((book) => book.title).join(', ') }}")


if __name__ == "__main__":
    app = GraphLoading()
    app.server.start()
