import itertools

import pytest
from trame.ui.html import DivLayout

from trame.app import get_server
from trame_dataclass.widgets import dataclass

COUNTER = itertools.count()


def render(client_type, **kwargs):
    server = get_server(f"prefetch-{next(COUNTER)}", client_type=client_type)
    with DivLayout(server) as layout, dataclass.Prefetch(**kwargs):
        pass
    return layout.html


def test_list_of_ids_becomes_a_bound_array_literal():
    # Not `instances="['ab', 'cd']"`: an unbound attribute is a string, and the
    # component expects an array. Single quotes, because the double ones a JSON dump
    # would use close the HTML attribute at the first inner quote.
    assert ":instances=\"['ab', 'cd']\"" in render("vue3", instances=["ab", "cd"])


def test_an_expression_stays_a_binding():
    # A tuple is trame's "bind this expression" shorthand, for a list that changes.
    assert ':instances="ids"' in render("vue3", instances=("ids",))


def test_no_instances_renders_the_component_without_the_prop():
    html = render("vue3")
    assert "trame-dataclass-prefetch" in html
    assert "instances" not in html


def test_an_id_a_quote_could_escape_is_refused():
    # The alternative to refusing is emitting a template that does not compile.
    with pytest.raises(ValueError, match="not safe to inline"):
        render("vue3", instances=["ab', x='"])


def test_react_client_is_refused():
    with pytest.raises(NotImplementedError, match="client_type='react'"):
        render("react", instances=["ab"])
