from trame_dataclass.widgets.dataclass import *  # noqa: F403


def initialize(server):
    from trame_dataclass import module

    server.enable_module(module)
