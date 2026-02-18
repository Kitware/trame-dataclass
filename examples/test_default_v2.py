from trame_dataclass.v2 import StateDataModel, Sync


class User(StateDataModel):
    first_name = Sync(str, "John")
    last_name = Sync(str, "Doe")
    age = Sync(int, 1)


users = [User() for _ in range(3)]

for user in users:
    print(user.client_state)
