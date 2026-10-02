import gc
from unittest.mock import Mock

from trame_dataclass.module.protocol_v2 import TrameDataclassProtocol
from trame_dataclass.v2 import StateDataModel, Sync


class Sample(StateDataModel):
    value = Sync(int, 0)
    items = Sync(list, list)


def protocol():
    result = TrameDataclassProtocol()
    result.class_definitions[Sample] = {"id": 1}
    result.publish = Mock()
    return result


def test_snapshot_and_delta_share_a_monotonic_instance_revision():
    p, a, b = protocol(), Sample(), Sample()
    assert p.get_state(a._id)["revision"] == 0
    p.push_delta({"id": a._id, "state": {"value": 1}})
    assert p.publish.call_args.args[1]["revision"] == 1
    assert p.get_state(a._id)["revision"] == 1
    p.push_delta({"id": a._id, "state": {"value": 2}})
    assert p.publish.call_args.args[1]["revision"] == 2
    p.push_delta({"id": b._id, "state": {"value": 3}})
    assert p.publish.call_args.args[1]["revision"] == 1


def test_a_snapshot_cannot_change_after_its_revision_is_returned():
    p, a = protocol(), Sample()
    a.items = [1, {"value": 2}]
    reply = p.get_state(a._id)
    a.items[1]["value"] = 3
    a.items.append(4)
    assert reply["state"]["items"] == [1, {"value": 2}]


def test_a_publication_cannot_change_after_its_revision_is_assigned():
    p, a = protocol(), Sample()
    payload = {"id": a._id, "state": {"items": [1]}}
    p.push_delta(payload)
    payload["state"]["items"].append(2)
    assert p.publish.call_args.args[1]["state"]["items"] == [1]
    assert "revision" not in payload


def test_revision_bookkeeping_does_not_retain_a_deleted_model():
    p, a = protocol(), Sample()
    p.push_delta({"id": a._id, "state": {"value": 1}})
    assert len(p.state_revisions) == 1
    del a
    gc.collect()
    assert len(p.state_revisions) == 0


def test_a_retired_id_keeps_the_existing_missing_state_protocol():
    p = protocol()
    assert p.get_state("gone") == {"id": "gone", "state": None}


class ValueEqual(StateDataModel):
    """A model that compares by value -- and is therefore UNHASHABLE.

    Declaring ``__eq__`` sets ``__hash__ = None`` unless the class says otherwise, which
    is ordinary Python. ``get_state`` must not require models to be hashable.
    """

    value = Sync(int, 0)

    __hash__ = None

    def __eq__(self, other):
        return isinstance(other, ValueEqual) and other.value == self.value


def test_a_model_that_compares_by_value_can_still_be_read_and_revised():
    """MUTATION (run): key ``state_revisions`` by ``obj``. Both calls raise TypeError."""
    p, a = protocol(), ValueEqual()
    p.class_definitions[ValueEqual] = {"id": 2}
    assert p.get_state(a._id)["revision"] == 0
    p.push_delta({"id": a._id, "state": {"value": 1}})
    assert p.publish.call_args.args[1]["revision"] == 1
    assert p.get_state(a._id)["revision"] == 1


def test_two_equal_but_distinct_models_keep_separate_revisions():
    """Equality is the user's business; identity is the protocol's.

    MUTATION (run): key by ``obj.value`` or any other user-visible field. The two share
    one counter and ``b``'s first delta is announced as revision 2.
    """
    p, a, b = protocol(), ValueEqual(), ValueEqual()
    p.class_definitions[ValueEqual] = {"id": 2}
    assert a == b
    assert a._id != b._id
    p.push_delta({"id": a._id, "state": {"value": 7}})
    p.push_delta({"id": a._id, "state": {"value": 8}})
    assert p.get_state(a._id)["revision"] == 2
    p.push_delta({"id": b._id, "state": {"value": 9}})
    assert p.publish.call_args.args[1]["revision"] == 1
    assert p.get_state(b._id)["revision"] == 1


def test_collecting_one_of_two_equal_models_leaves_the_other_alone():
    """The weak lifetime has to survive the key change, and has to be per INSTANCE.

    MUTATION (run): drop the ``weakref.finalize`` in ``_track_revisions``. ``a``'s row
    outlives it and the table grows for the life of the session.
    """
    p, a, b = protocol(), ValueEqual(), ValueEqual()
    p.class_definitions[ValueEqual] = {"id": 2}
    p.push_delta({"id": a._id, "state": {"value": 1}})
    p.push_delta({"id": b._id, "state": {"value": 1}})
    surviving = b._id
    assert len(p.state_revisions) == 2
    del a
    gc.collect()
    assert list(p.state_revisions) == [surviving]
    p.push_delta({"id": b._id, "state": {"value": 2}})
    assert p.publish.call_args.args[1]["revision"] == 2


class HashableValueEqual(ValueEqual):
    """Equal by value AND hashable: the shape where the defect is silent, not loud.

    Nothing raises here. Two distinct instances simply shared one row, so both read
    revision 2 after one delta each; collecting either one took the row with it and
    reset the SURVIVOR to 0, whose next publication announced revision 1 — which a
    client already holding 2 then discards as stale. A live update, dropped, with no
    error anywhere. The tests below pin per-instance revisions.
    """

    def __hash__(self):
        return 0


def test_state_snapshot_supports_unhashable_value_equal_models():
    p = protocol()
    p.class_definitions[ValueEqual] = {"id": 2}
    model = ValueEqual()
    assert p.get_state(model._id)["state"]["value"] == 0
    p.push_delta({"id": model._id, "state": {"value": 1}})
    assert p.get_state(model._id)["revision"] == 1


def test_distinct_equal_instances_keep_independent_revision_lifetimes():
    """MUTATION (run): key by ``obj``. ``b`` reads 2 before the delete and 0 after it."""
    p = protocol()
    p.class_definitions[HashableValueEqual] = {"id": 3}
    a, b = HashableValueEqual(), HashableValueEqual()
    assert a == b
    assert a._id != b._id
    p.push_delta({"id": a._id, "state": {"value": 0}})
    p.push_delta({"id": b._id, "state": {"value": 0}})
    before = p.get_state(b._id)["revision"]
    assert before == 1, "each instance counts its own deltas"
    del a
    gc.collect()
    assert p.get_state(b._id)["revision"] == before, "retiring a reset live b revision"
    p.push_delta({"id": b._id, "state": {"value": 0}})
    assert p.get_state(b._id)["revision"] == before + 1
