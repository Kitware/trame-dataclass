trame-dataclass
----------------------------------------

Dataclass for trame UI binding

License
----------------------------------------

This library is OpenSource and follow the Apache Software License

Installation
----------------------------------------

Install the application/library

.. code-block:: console

    pip install trame-dataclass


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

    # Allow live code edit
    uv pip install -e .


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
* `Custom Development <https://www.kitware.com/trame/support/>`_: Leverage Kitware’s 25+ years of experience to quickly build your web application.
