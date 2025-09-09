from pathlib import Path

from trame.app import TrameApp
from trame.ui.html import DivLayout
from trame.widgets import html
from trame_dataclass.core import Field, StateDataModel


def path_encode(p: Path) -> str:
    return str(p)


def path_decode(p: str) -> Path:
    return Path(p)


def list_encode(value: list[Path] | None) -> list[str] | None:
    if value is None:
        return None

    return list(map(path_encode, value))


def list_decode(value: list[str] | None) -> list[Path] | None:
    if value is None:
        return None

    return list(map(path_decode, value))


class CustomStructure(StateDataModel):
    path: Path = Field(default=Path.cwd(), encoder=path_encode, decoder=path_decode)
    children: list[Path] | None = Field(encoder=list_encode, decoder=list_decode)


class CustomEncoder(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        self._data = CustomStructure(self.server)
        self._data.watch(["path"], self._list_children, eager=True)
        self._build_ui()

    def _list_children(self, file_path: Path):
        if file_path.exists():
            self._data.children = file_path.glob("*")
        else:
            self._data.children = None

    def _build_ui(self):
        with DivLayout(self.server) as self.ui:
            html.Div("Getting started with StateDataModel")
            with self._data.Provider(name="data"):
                html.Input(v_model="data.path", style="width: 95%;")
                html.Hr()
                html.Pre("{{ JSON.stringify(data.children, null, 2) }}")


if __name__ == "__main__":
    app = CustomEncoder()
    app.server.start()
