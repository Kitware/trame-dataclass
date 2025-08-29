from pathlib import Path

# Compute local path to serve
serve_path = str(Path(__file__).with_name("serve").resolve())

# Serve directory for JS/CSS files
serve = {"__trame_dataclass": serve_path}

# List of JS files to load (usually from the serve path above)
scripts = ["__trame_dataclass/trame_dataclass.umd.js"]

# List of CSS files to load (usually from the serve path above)
if (Path(serve_path) / "style.css").exists():
    styles = ["__trame_dataclass/style.css"]

# List of Vue plugins to install/load
vue_use = ["trame_dataclass"]


# Optional if you want to execute custom initialization at module load
def setup(server, **_):
    """Method called at initialization with possibly some custom keyword arguments"""
    server.add_protocol_to_configure(configure_protocol)


def configure_protocol(protocol):
    from trame_dataclass.module.protocol import TrameDataclassProtocol

    protocol.registerLinkProtocol(TrameDataclassProtocol())
