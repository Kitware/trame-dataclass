import pytest

from trame_dataclass.v2 import TypeChecker, TypeValidation


class FakeInstance: ...


instance = FakeInstance()


def test_core_types():
    checker_number = TypeChecker(float | int, TypeValidation.STRICT)
    checker_int = TypeChecker(int, TypeValidation.STRICT)
    checker_float = TypeChecker(float, TypeValidation.STRICT)
    checker_str = TypeChecker(str, TypeValidation.STRICT)
    checker_int.validate(instance, 5)
    checker_float.validate(instance, 5.5)
    checker_number.validate(instance, 5)
    checker_number.validate(instance, 5.5)
    checker_str.validate(instance, "hello")

    with pytest.raises(TypeError):
        checker_int.validate(instance, 1.23)

    with pytest.raises(TypeError):
        checker_float.validate(instance, 1)

    with pytest.raises(TypeError):
        checker_str.validate(instance, 1)


def test_class():
    class A:
        number = 1

    class_a = TypeChecker(A, TypeValidation.STRICT)
    class_b = TypeChecker("B", TypeValidation.STRICT)

    class B:
        name = "asdf"

    a = A()
    aa = A()
    class_a.validate(instance, a)
    class_a.validate(instance, aa)

    b = B()
    bb = B()
    class_b.validate(instance, b)
    class_b.validate(instance, bb)

    with pytest.raises(TypeError):
        class_b.validate(instance, a)

    with pytest.raises(TypeError):
        class_a.validate(instance, b)
