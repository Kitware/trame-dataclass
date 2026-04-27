from trame_dataclass.v2 import (
    StateDataModel,
    Sync,
)


def test_inheritance_field_names():
    class Simple(StateDataModel):
        a = Sync(int, 1)
        b = Sync(int, 2)

    class Complex(Simple):
        c = Sync(int, 3)

    assert "a" in Complex.FIELD_NAMES
    assert "b" in Complex.FIELD_NAMES
    assert "c" in Complex.FIELD_NAMES

    assert "c" not in Simple.FIELD_NAMES


def test_inheritance_runtime_behavior():
    class Simple(StateDataModel):
        a = Sync(int, 10)

    class Complex(Simple):
        b = Sync(int, 20)

    simple_obj = Simple()
    assert isinstance(simple_obj, Simple)
    assert not isinstance(simple_obj, Complex)

    complex_obj = Complex()
    assert isinstance(complex_obj, Simple)
    assert isinstance(complex_obj, Complex)

    assert simple_obj.a == 10
    assert complex_obj.a == 10
    assert complex_obj.b == 20

    simple_obj.a = 15
    complex_obj.a = 5
    complex_obj.b = 25

    assert simple_obj.a == 15
    assert complex_obj.a == 5
    assert complex_obj.b == 25


def test_inheritance_field_isolation():
    class A(StateDataModel):
        x = Sync(int, 1)

    class B(A):
        y = Sync(int, 2)

    class C(A):
        z = Sync(int, 3)

    # B and C should not share mutations
    assert "y" in B.FIELD_NAMES
    assert "y" not in A.FIELD_NAMES
    assert "y" not in C.FIELD_NAMES

    assert "z" in C.FIELD_NAMES
    assert "z" not in A.FIELD_NAMES
    assert "z" not in B.FIELD_NAMES
