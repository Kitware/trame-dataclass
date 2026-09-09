from pathlib import Path

from loguru import logger

from trame_dataclass import __version__

serve_path = str(Path(__file__).with_name("serve").resolve())
serve_react_path = str(Path(__file__).with_name("serve-react").resolve())
serve = {
    f"__trame_dataclass_{__version__}": serve_path,
    f"__trame_dataclass_react_{__version__}": serve_react_path,
}


# Optional if you want to execute custom initialization at module load
def setup(server, version="v2", **_):
    """Method called at initialization with possibly some custom keyword arguments"""
    logger.info("dataclass protocol setup to {}", version)

    # Only load the client bundle matching the active client_type: the two
    # UMD bundles assume different globals (Vue vs React) and would error
    # if loaded under the other client.
    if server.client_type == "react":
        server.enable_module(
            {
                "scripts": [
                    f"__trame_dataclass_react_{__version__}/trame_dataclass_react.umd.js"
                ],
                "react_use": ["TrameDataclass"],
            }
        )
    else:
        server.enable_module(
            {
                "scripts": [f"__trame_dataclass_{__version__}/trame_dataclass.umd.js"],
                "vue_use": ["trame_dataclass"],
            }
        )

    if version == "v1":
        server.add_protocol_to_configure(configure_protocol)
    elif version == "v2":
        server.add_protocol_to_configure(configure_protocol_v2)


def configure_protocol(protocol):
    """Register the v1 dataclass WebSocket protocol with the given wslink protocol."""
    from trame_dataclass.module.protocol import TrameDataclassProtocol  # noqa: PLC0415

    protocol.registerLinkProtocol(TrameDataclassProtocol())


def configure_protocol_v2(protocol):
    """Register the v2 dataclass WebSocket protocol with the given wslink protocol."""
    from trame_dataclass.module.protocol_v2 import (  # noqa: PLC0415
        TrameDataclassProtocol,
    )

    protocol.registerLinkProtocol(TrameDataclassProtocol())
