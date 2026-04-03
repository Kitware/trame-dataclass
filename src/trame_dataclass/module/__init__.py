from pathlib import Path

from loguru import logger

from trame_dataclass import __version__

serve_path = str(Path(__file__).with_name("serve").resolve())
serve = {f"__trame_dataclass_{__version__}": serve_path}
scripts = [f"__trame_dataclass_{__version__}/trame_dataclass.umd.js"]
vue_use = ["trame_dataclass"]


# Optional if you want to execute custom initialization at module load
def setup(server, version="v2", **_):
    """Method called at initialization with possibly some custom keyword arguments"""
    logger.info("dataclass protocol setup to {}", version)

    if version == "v1":
        server.add_protocol_to_configure(configure_protocol)
    elif version == "v2":
        server.add_protocol_to_configure(configure_protocol_v2)


def configure_protocol(protocol):
    from trame_dataclass.module.protocol import TrameDataclassProtocol  # noqa: PLC0415

    protocol.registerLinkProtocol(TrameDataclassProtocol())


def configure_protocol_v2(protocol):
    from trame_dataclass.module.protocol_v2 import (  # noqa: PLC0415
        TrameDataclassProtocol,
    )

    protocol.registerLinkProtocol(TrameDataclassProtocol())
