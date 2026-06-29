
.. |pypi_version| image:: https://img.shields.io/pypi/v/trame-dataclass
   :target: https://pypi.org/project/trame-dataclass/
.. |pypi_download| image:: https://img.shields.io/pypi/dm/trame-dataclass
.. |python_version| image:: https://img.shields.io/pypi/pyversions/trame-dataclass
.. |license| image:: https://img.shields.io/pypi/l/trame-dataclass

trame-dataclass
----------------------------------------

|pypi_version| |pypi_download| |python_version| |license|

``trame-dataclass`` lets you define typed Python classes whose fields sync
automatically between the server and the browser.  Each field is declared
with a descriptor (``Sync``, ``ServerOnly``, or ``ClientOnly``) that controls
the sync direction.  The resulting objects plug into trame's reactivity system
and Vue.js templates without any manual state-key bookkeeping.

License
----------------------------------------

This library is OpenSource and follows the Apache Software License.

Installation
----------------------------------------

.. code-block:: console

    pip install trame-dataclass

Requires Python 3.10+.

Field descriptors
----------------------------------------

The three descriptors control how a field is shared between server and client:

.. list-table::
   :header-rows: 1
   :widths: 20 20 20 20 20

   * - Descriptor
     - Server → Client
     - Client → Server
     - ``@watch`` fires
     - Typical use
   * - ``Sync``
     - Yes
     - Yes
     - Yes
     - Shared mutable state
   * - ``ServerOnly``
     - No
     - No
     - Yes
     - Private server data (e.g. heavy objects, file handles)
   * - ``ClientOnly``
     - Yes (on init)
     - No
     - No
     - Local UI state the server seeds but never reads back

All three accept ``(type, default=None)`` as their first two arguments.
The default can be a callable (called fresh for each instance).

Reactivity
----------------------------------------

Two complementary ways to react to field changes:

**Decorator @watch annotation** — defined inside the class; fires on the server
whenever any of the named fields change:

.. code-block:: python

    @watch("age")
    def _update_derived(self, age):
        self.derived_value = 80 - age

**Method .watch() call** — registers a callback externally at runtime and
returns an *unwatch* callable:

.. code-block:: python

    unwatch = self._data.watch(["age"], self.print_age)

Watchers receive one argument per field name listed and run asynchronously
by default.  Pass ``sync=True`` for synchronous execution or ``eager=True``
to fire immediately on registration.

.. note::

    ``@watch`` never fires for ``ClientOnly`` fields because client-side
    edits do not round-trip to the server.

Exposing instances to the UI
----------------------------------------

``provide_as(name)`` makes a dataclass instance available as a named
reactive variable inside a UI scope:

.. code-block:: python

    with self._data.provide_as("user"):
        html.Input(type="text", v_model="user.name")

For dynamic binding — where the active instance is determined at runtime by
a state variable — use ``dataclass.Provider`` directly:

.. code-block:: python

    with dataclass.Provider(name="dynamic_user", instance=("active_user", None)):
        html.Pre("{{ JSON.stringify(dynamic_user, null, 2) }}")

``instance`` accepts a trame expression tuple; the second element is the
default when the state variable is unset.

Composed dataclasses
----------------------------------------

Fields can hold other ``StateDataModel`` instances (or lists/dicts of them)
using the ``has_dataclass=True`` flag.  Encoding and decoding between Python
objects and client-side IDs is handled automatically:

.. code-block:: python

    class Person(StateDataModel):
        first_name = Sync(str, "John")
        last_name  = Sync(str, "Doe")

    class AddressBook(StateDataModel):
        contacts = Sync(list[Person], list, has_dataclass=True)

Deep reactivity
----------------------------------------

By default, replacing a list or dict field triggers an update.  For mutable
in-place edits from the client (e.g. ``data.values.push(1)`` in JavaScript),
enable deep reactivity so Vue tracks nested changes:

.. code-block:: python

    values = Sync(list[int], list, client_deep_reactive=True)

Embedded GUI
----------------------------------------

A ``StateDataModel`` subclass can carry its own UI definition by overriding
``generate_gui``.  The returned widget HTML is then rendered on demand in the
application via ``dataclass.Gui``:

.. code-block:: python

    class Person(StateDataModel):
        first_name = Sync(str, "John")
        last_name  = Sync(str, "Doe")

        @classmethod
        def generate_gui(cls, trame_server=None) -> str:
            with v3.VCard(
                trame_server=trame_server,
                v_if="self_available && self._id",
            ) as root:
                v3.VTextField(v_model="self.first_name", label="First Name")
                v3.VTextField(v_model="self.last_name",  label="Last Name")
            return root.html

    # In your application UI:
    dataclass.Gui(instance=("selected_id",))

``dataclass.Gui`` resolves the instance ID at runtime and renders the
matching ``generate_gui`` output, making it easy to build detail panels
for dynamically selected objects.

Usage example
----------------------------------------

.. code-block:: python

    from typing import Any

    from trame.app import TrameApp
    from trame.app.dataclass import ClientOnly, ServerOnly, StateDataModel, Sync, watch
    from trame.ui.html import DivLayout
    from trame.widgets import dataclass, html


    class SimpleStructure(StateDataModel):
        name = Sync(str, "John Doe")        # server <=> client
        age = Sync(int, 1)                  # server <=> client
        derived_value = Sync(int)           # server <=> client
        something = ServerOnly(Any)         # server only
        local_edit = ClientOnly(int)        # server seeds, client owns

        @watch("age")
        def _update_derived(self, age):
            self.derived_value = 80 - age

        @watch("local_edit")
        def _never_called(self, local_edit):
            # ClientOnly — client edits never reach the server
            print("local_edit changed to", local_edit)


    class GettingStarted(TrameApp):
        def __init__(self, server=None):
            super().__init__(server)
            self._data = SimpleStructure(self.server)
            self._data.watch(["age"], self.print_age)
            self._build_ui()

        def print_age(self, age):
            print(f"Age changed to {age=}")

        def toggle_active_user(self):
            if self.state.active_user:
                self.state.active_user = None
            else:
                self.state.active_user = self._data._id

        def _modify_data(self):
            self._data.age += 1

        def _build_ui(self):
            with DivLayout(self.server) as self.ui:
                # Edit user on server
                html.Button("Server change", click=self._modify_data)

                # Provide data class instance to the UI as a variable
                with self._data.provide_as("user"):
                    html.Button("Edit local", click="user.local_edit = Date.now()")

                    html.Pre("{{ JSON.stringify(user, null, 2) }}")
                    html.Hr()
                    html.Div(
                        "Hello {{ user.name }} - derived value = {{ user.derived_value }}"
                    )
                    html.Hr()
                    html.Span("Your name:")
                    html.Input(type="text", v_model="user.name")
                    html.Hr()
                    html.Span("Your age:")
                    html.Input(
                        type="range", min=0, max=120, step=1, v_model_number="user.age"
                    )
                html.Hr()

                # Adjust dynamic user
                html.Button(
                    "Toggle user ({{ active_user || 'None' }})",
                    click=self.toggle_active_user,
                )

                # Dynamically provide a dataclass to the UI
                with dataclass.Provider(
                    name="dynamic_user",
                    instance=("active_user", None),
                ):
                    html.Pre("{{ JSON.stringify(dynamic_user, null, 2) }}")


    def main():
        app = GettingStarted()
        app.server.start()


    if __name__ == "__main__":
        main()

More examples
----------------------------------------

The ``examples/`` directory contains runnable scripts covering:

- ``getting_started/`` — basic usage, deep reactivity, tree structures, custom encoders
- ``gui/`` — embedded GUI with ``generate_gui`` and ``dataclass.Gui``
- ``validation/`` — type checking, composite dataclasses, performance tests

Scripts with a ``/// script`` header can be run directly with ``uv run``:

.. code-block:: console

    uv run examples/getting_started/readme.py

Development setup
----------------------------------------

We recommend using uv for setting up and managing a virtual environment for your development.

.. code-block:: console

    # Create venv and install all dependencies
    uv sync --all-extras --dev

    # Activate environment
    source .venv/bin/activate

    # Install commit analysis
    pre-commit install
    pre-commit install --hook-type commit-msg


Build and install the Vue components

.. code-block:: console

    cd vue-components
    npm i
    npm run build
    cd -

For running tests and checks, you can run ``nox``.

.. code-block:: console

    # run all
    nox

    # lint
    nox -s lint

    # tests
    nox -s tests

Professional Support
----------------------------------------

* `Training <https://www.kitware.com/courses/trame/>`_: Learn how to confidently use trame from the expert developers at Kitware.
* `Support <https://www.kitware.com/trame/support/>`_: Our experts can assist your team as you build your web application and establish in-house expertise.
* `Custom Development <https://www.kitware.com/trame/support/>`_: Leverage Kitware's 25+ years of experience to quickly build your web application.

Commit message convention
----------------------------------------

Semantic release rely on `conventional commits <https://www.conventionalcommits.org/en/v1.0.0/>`_ to generate new releases and changelog.
