# Trame Dataclass: Structured Reactive State for Dynamic Applications

Trame dataclass is a library that complements the reactive state system built
into trame. This post covers what the library provides, how every feature works,
and when to reach for it rather than — or alongside — the standard global trame
state.

---

## Background: The Problem With Flat Global State

Trame ships with a server-side state dictionary that is automatically
synchronized with the browser. Any key you set on `self.state` becomes a
reactive variable in your Vue.js template:

```python
with self.state:
    self.state.name = "Alice"
    self.state.age = 30
```

This is ideal for simple apps: a handful of settings, a currently selected item,
a display toggle. The model is flat, the names are global, and synchronization
is handled automatically.

The friction appears when your data model becomes dynamic:

- You need **multiple instances** of the same entity (a list of contacts, a tree
  of nodes, a pool of analysis jobs).
- Each instance has **many structured fields** — and perhaps nested sub-objects.
- Instances are **created and destroyed at runtime** based on user actions.
- You want **per-instance reactivity** — know when _this_ contact's name
  changed, not that _some_ state key changed.

Encoding ten contacts into the flat global state requires inventing ten prefixed
keys per contact, keeping them in sync manually, and tearing them down when a
contact is deleted. This is error-prone, verbose, and does not scale.

**Trame dataclass** solves this by letting you define typed entity classes —
`StateDataModel` subclasses — that each maintain their own synchronized state,
carry a unique identity, and participate in the same reactive plumbing trame
apps are built on.

---

## Core Concept: `StateDataModel`

A `StateDataModel` is a Python class whose fields are automatically synchronized
between the Python server and the browser client. You define the structure once
as a class, then create as many instances as you need at runtime.

### Importing the API

```python
# Recommended: import from trame.app.dataclass (same as trame_dataclass.v2)
from trame.app.dataclass import StateDataModel, Sync, ServerOnly, ClientOnly, FieldEncoder, get_instance, watch
```

### Defining a Model

```python
from trame.app.dataclass import StateDataModel, Sync, ServerOnly, ClientOnly

class Person(StateDataModel):
    first_name = Sync(str, "John")
    last_name  = Sync(str, "Doe")
    age        = Sync(int, 0)
```

Fields are declared as class attributes using one of three field descriptors:
`Sync`, `ServerOnly`, or `ClientOnly`. Each descriptor takes at minimum a Python
type and an optional default value.

### Creating Instances

```python
class MyApp(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        self.person = Person(self.server, first_name="Alice", age=28)
```

Pass the trame server as the first argument. The instance registers itself with
the server's WebSocket protocol so the browser can interact with it. Any field
values you pass as keyword arguments override the defaults.

You can also create instances without a server — useful for pure server-side
computation or testing:

```python
person = Person()  # no server, no client sync
person.first_name = "Bob"
```

---

## Instance Identity: `_id` and `get_instance`

Every `StateDataModel` instance receives a compact, unique string identifier at
creation time, accessible via `instance._id`. This identifier:

- Uniquely distinguishes every instance in the current process.
- Is the key used by the client to address that specific object.
- Can be passed as an argument from client-side JavaScript to a Python method
  call.

On the server, you can retrieve any live instance by its id:

```python
from trame.app.dataclass import get_instance

def handle_click(self, person_id: str):
    person = get_instance(person_id)
    if person is not None:
        print(person.first_name)
```

Instances are stored in a `WeakValueDictionary`, meaning they are
garbage-collected when no Python reference holds them. `get_instance` returns
`None` if the instance is gone, so always check the return value.

---

## Field Descriptors

There are three field descriptors, each controlling how a field is synchronized:

### `Sync` — bidirectional synchronization

```python
class Document(StateDataModel):
    title   = Sync(str, "Untitled")
    content = Sync(str, "")
    version = Sync(int, 0)
```

A `Sync` field lives on both the server and the client. Changes on the server
are pushed to the browser; changes made in the browser (via `v-model` or direct
JavaScript assignment) are pushed back to the server and trigger Python
watchers.

### `ServerOnly` — server-side state, invisible to the client

```python
class Job(StateDataModel):
    status   = Sync(str, "pending")
    _worker  = ServerOnly(object)  # never sent to browser
```

A `ServerOnly` field stores data on the server that the browser never sees. It
is fully reactive — Python watchers fire when it changes — but nothing is ever
serialized or transmitted. Use this for references to Python objects, file
handles, large datasets, or any value that has no meaningful browser
representation.

### `ClientOnly` — a one-way, network-free reactive field

```python
class Canvas(StateDataModel):
    cursor_x = ClientOnly(int, 0)
    cursor_y = ClientOnly(int, 0)
```

A `ClientOnly` field is initialized on the server with its default (or whatever
you assign from Python) and pushed to the client like any `Sync` field — that
part of the wire is **server → client only**. Once the value lands in the
browser, the client never reports edits back: the data manager simply does not
set up a watcher to forward `ClientOnly` changes to the server, so
`v-model`-driven edits stay entirely local to the Vue reactive object. No
message is ever sent over the WebSocket for them.

In practice this means:

- A Python-side `@watch(...)` on a `ClientOnly` field will **never fire** as a
  result of the user interacting with it in the browser — only a server-side
  assignment would trigger it.
- There is no round trip, so this is the cheapest possible reactive field for
  fast-changing, purely presentational data (mouse position, a local toggle, an
  animation frame counter) that the server has no need to know about.

```python
class Demo(StateDataModel):
    local_edit = ClientOnly(int)  # server => client, never client => server

    @watch("local_edit")
    def _never_called(self, local_edit):
        # This will not run when the browser changes local_edit.
        print("local_edit changed to", local_edit)
```

Use `ClientOnly` to **save network traffic** for state that only needs to live
and react on the client — not as a way to receive client edits on the server
(that's what `Sync` is for).

### Field Descriptor Signature

All three descriptors share the same signature:

```python
Sync(
    type,                                   # Python type annotation (required)
    default=None,                           # default value or factory callable
    convert: FieldEncoder = None,           # custom encoder/decoder pair
    has_dataclass: bool = False,            # field holds StateDataModel instances
    client_deep_reactive: bool = False,     # Vue deep reactivity for lists/dicts
    type_checking: TypeValidation = TypeValidation.WARNING,
)
```

---

## Supported Field Types

### Primitive Types

All JSON-serializable primitives are supported directly:

```python
class Config(StateDataModel):
    label     = Sync(str, "")
    count     = Sync(int, 0)
    ratio     = Sync(float, 1.0)
    enabled   = Sync(bool, True)
    nullable  = Sync(str | None)     # union type; defaults to None
```

### Composite Types

Lists, dicts, sets, and tuples work out of the box. Type-parameterized forms are
preferred because they enable automatic validation:

```python
class Stats(StateDataModel):
    tags      = Sync(list[str], list)
    scores    = Sync(dict[str, float], dict)
    ids       = Sync(set, set)             # untyped set, serialized as list
    rgb       = Sync(tuple[float, float, float], (1.0, 0.0, 0.0))
```

When the default is a mutable container type like `list`, `dict`, or `set`, pass
the class itself (not a literal `[]` or `{}`). The library creates a new
instance per object automatically, preventing the classic mutable-default
gotcha.

### Nested `StateDataModel` Fields

Fields can hold references to other `StateDataModel` instances. Set
`has_dataclass=True` to tell the descriptor how to serialize and deserialize
them — instances are serialized as their `._id` string over the wire, and
reconstructed into the original Python objects on receipt:

```python
class UserInfo(StateDataModel):
    age        = Sync(int, 25)
    eye_color  = Sync(str, "brown")

class User(StateDataModel):
    first_name = Sync(str, "John")
    last_name  = Sync(str, "Doe")
    info       = Sync(UserInfo, has_dataclass=True)   # single nested instance

class AddressBook(StateDataModel):
    contacts   = Sync(list[User],        list, has_dataclass=True)  # list of instances
    index      = Sync(dict[str, User],   dict, has_dataclass=True)  # dict of instances
    active     = Sync(User | None,             has_dataclass=True)  # optional instance
```

On the client, `user.info` is a full reactive proxy of the nested `UserInfo`
instance, not just an id string. You can use `v-model="user.info.age"` directly
in your template.

### Self-Referential (Recursive) Types

Forward references using quoted type names allow recursive structures:

```python
class TreeNode(StateDataModel):
    name     = Sync(str, "")
    children = Sync(list["TreeNode"] | None, list, has_dataclass=True)
```

This makes it possible to build arbitrary-depth trees where the full hierarchy
is reactive on both sides.

---

## Type Validation

By default, fields warn (via loguru) when an assigned value does not match the
declared type. You can tighten or loosen this:

```python
from trame.app.dataclass import ServerOnly, TypeValidation

class Strict(StateDataModel):
    count = ServerOnly(int, 0, type_checking=TypeValidation.STRICT)   # raises TypeError
    label = ServerOnly(str, "", type_checking=TypeValidation.WARNING)  # logs warning (default)
    any   = ServerOnly(str, "", type_checking=TypeValidation.SKIP)     # no check
```

With `STRICT`, assigning the wrong type raises `TypeError` immediately, making
it easier to catch data model bugs early during development.

---

## Custom Encoders for Non-JSON Types

When you need to store a Python type that cannot be serialized to JSON natively,
provide a `FieldEncoder` with an encoder/decoder pair:

```python
from pathlib import Path
from trame.app.dataclass import FieldEncoder, StateDataModel, Sync

def encode_path(p: Path) -> str:
    return str(p)

def decode_path(s: str) -> Path:
    return Path(s)

path_encoder = FieldEncoder(encode_path, decode_path)

class FileBrowser(StateDataModel):
    current_dir = Sync(Path, Path.cwd(), path_encoder)
    entries     = Sync(list[Path] | None, None, FieldEncoder(
        lambda paths: [str(p) for p in paths] if paths else None,
        lambda strs:  [Path(s) for s in strs]  if strs  else None,
    ))
```

The encoder converts the Python value to a JSON-serializable form before it is
sent to the client; the decoder reconstructs the Python object when a client
edit arrives.

---

## Deep Reactivity for Collections

By default, a `Sync(list[int], list)` field creates a standard reactive
reference: assigning a new list to the field (e.g.,
`data.values = [*data.values, 5]`) triggers synchronization, but mutating the
list in place on the client (e.g., `data.values.push(5)` in JavaScript) does not
propagate back automatically.

Setting `client_deep_reactive=True` wraps the field in Vue's deep reactive
proxy, allowing in-place JavaScript mutations to propagate:

```python
class Data(StateDataModel):
    values          = Sync(list[int], list)                                    # standard
    values_reactive = Sync(list[int], list, client_deep_reactive=True)         # deep

    @watch("values_reactive")
    def _on_change(self, values):
        print("Changed:", values)
```

With `values_reactive`, client-side code like `data.values_reactive.push(1)` or
`data.values_reactive[i]++` triggers the server watcher. Without it, those
mutations are local to the client until a full reassignment happens.

Use deep reactivity when:

- You want fine-grained, in-place array editing from the UI.
- List items are primitives (not nested dataclasses — those are already
  individually reactive).

---

## Reactivity: Watching Field Changes

### Class-Level Watchers with `@watch`

The `@watch` decorator registers a method as a watcher for one or more fields.
It fires whenever any of the named fields changes on _any instance_ of that
class:

```python
class Item(StateDataModel):
    name  = Sync(str, "")
    value = Sync(int, 0)

    @watch("value")
    def _on_value_change(self, value):
        print(f"[{self._id}] value changed to {value}")
```

The method receives the current value(s) of the watched fields as positional
arguments, in the order they are listed in the decorator.

You can watch multiple fields at once by listing them:

```python
    @watch("first_name", "last_name", eager=True)
    def _update_title(self, first_name, last_name):
        self.title = f"{first_name} {last_name}"
```

The decorator accepts the same `sync` and `eager` keyword arguments as the
`.watch()` method (see below).

### Instance-Level Watchers with `.watch()`

To observe changes on a specific instance — for example from app-level code —
use the `.watch()` method:

```python
class MyApp(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        self.person = Person(self.server)
        unwatch = self.person.watch(["age"], self._on_age_change)

    def _on_age_change(self, age):
        print(f"Age is now {age}")
```

`.watch()` returns an `unwatch` callable. Call it to deregister the callback
when you no longer need it.

### Watcher Options: `sync` and `eager`

Both the decorator and the `.watch()` method accept two options:

**`sync=True`** — run the callback synchronously, immediately when the field is
set, before the async event loop processes the dirty queue. Use this sparingly;
it runs inside the setter and can block if the callback is slow.

**`eager=True`** — fire the callback once immediately at registration time with
the current field values, before any actual change occurs. Useful to initialize
derived state:

```python
self.data.watch(["path"], self._list_children, eager=True)
```

### Async Watchers

Watcher callbacks can be async. The library schedules them as background asyncio
tasks:

```python
class Processor(StateDataModel):
    input_file = Sync(str, "")

    @watch("input_file")
    async def _process(self, path):
        result = await run_heavy_computation(path)
        self.output = result
```

### Manually Marking Fields Dirty

If you mutate an object in a way the descriptor cannot detect (e.g., mutating a
list in-place on the server), call `.dirty()` to force watchers and sync to run:

```python
data.values.append(5)
data.dirty("values")
```

---

## The Collaboration Mode

By default, `enable_collaboration=False`. When a client edit arrives on the
server, the server records the client's value in its "last-known client state"
cache. That way, the next flush compares the server's computed value against the
client's most-recent value, and only sends a delta if something actually changed
on the server side. The client's drag position is therefore never echoed back
unnecessarily, keeping fast interactions like sliders smooth.

Setting `enable_collaboration=True` disables that cache update: the server no
longer acknowledges the client's edit in its cache. On the next flush, the cache
still holds the server's previous push, so the flush detects a delta and
re-sends the server's authoritative value to every connected client. This is the
correct behavior when **multiple clients share the same instance** — you want
each client's edits to propagate through the server and be redistributed to all
other clients. For a single-user, fast-changing widget it causes the slider to
jump back:

```python
self.data_collab = Data(self.server, enable_collaboration=True)   # re-broadcasts server value → may jump
self.data_local  = Data(self.server, enable_collaboration=False)  # default → smooth single-client interaction
```

Use `enable_collaboration=True` only when multi-client state consistency matters
more than smooth local interaction.

---

## Exposing Instances to the UI

### `provide_as` Context Manager

The simplest way to make a dataclass instance available inside a portion of your
UI is to use it as a context manager:

```python
with self.person.provide_as("user"):
    html.Input(type="text", v_model="user.first_name")
    html.Div("Hello {{ user.name }}")
```

Inside the context, the string `"user"` is a reactive proxy of the `Person`
instance in Vue.js. Edits flow bidirectionally: typing in the input updates
`person.first_name` on the server; setting `person.first_name = "Bob"` in Python
updates the input in the browser.

`provide_as` returns a `Provider` widget — the same widget you can use directly
when you need more control.

### `Provider` Widget — Dynamic Instance Binding

When you need to display a different instance depending on runtime state (e.g.,
whatever item the user has selected), use the `Provider` widget directly and
bind the instance to a reactive expression:

```python
from trame.widgets import dataclass as dcw

with dcw.Provider(name="active_person", instance=("selected_id", None)):
    html.Div("{{ active_person.first_name }}", v_if="active_person_available")
    html.Div("Nothing selected", v_else=True)
```

The `instance` attribute takes the id of the instance to display. It can be a
trame state key (with an optional default), a literal id string, or any reactive
expression.

The `Provider` widget exposes two variables inside its slot:

- **`{name}`** — the dataclass proxy (here: `active_person`).
- **`{name}_available`** — a boolean that is `true` when the instance exists and
  is ready (here: `active_person_available`). Use `v_if="{name}_available"` to
  guard rendering.

The Provider also works with expressions that compute ids from other dataclass
fields:

```python
# id derived from another dataclass field
with dcw.Provider(name="active_node", instance=("tree.actives?.[0]",)):
    ...
```

---

## Nested Structures and the Object Graph

When a dataclass field holds other dataclass instances, the full object graph is
made available to the client. On the client side, `user.info` is itself a
reactive proxy pointing to the `UserInfo` instance — you can bind deeply:

```python
class UserInfo(StateDataModel):
    age = Sync(int, 25)

class User(StateDataModel):
    first_name = Sync(str, "")
    info       = Sync(UserInfo, has_dataclass=True)
```

In the template:

```html
<v-slider v-model="user.info.age" />
<v-btn @click="user.info.age = 25">Reset JS</v-btn>
```

And from Python, using `_id` to cross the boundary:

```python
def reset_age(self, user_info_id: str):
    info = get_instance(user_info_id)
    info.age = 25
```

```python
# In the UI, call the Python handler and pass the nested instance's id:
v3.VBtn(text="Reset Python", click=(self.reset_age, "[user.info._id]"))
```

---

## Custom GUI per Data Type

When you have multiple distinct data types that should each display differently,
you can attach a GUI definition to the class itself. The `Gui` widget then
renders the correct GUI for whatever instance is currently selected — without
the calling code needing to know the type.

### Option 1: Static `TEMPLATE` string

Attach a `TEMPLATE` class attribute containing a raw Vue.js template string.
Inside the template, the instance is available as `self` and a guard variable
`self_available` is provided:

```python
class Person(StateDataModel):
    first_name = Sync(str, "John")
    last_name  = Sync(str, "Doe")
    TEMPLATE = """
      <VCard class="ma-4" v-if="self_available && self._id">
        <VContainer>
          <VRow>
            <VCol><VTextField v-model="self.first_name" label="First Name" /></VCol>
            <VCol><VTextField v-model="self.last_name"  label="Last Name"  /></VCol>
          </VRow>
        </VContainer>
      </VCard>
    """
```

This approach requires no Python build step and is easy to read. The downside is
that you cannot bind Python callbacks directly inside the template string.

### Option 2: `generate_gui` classmethod

Override the `generate_gui` classmethod and use the normal trame widget API to
build the GUI programmatically. The method receives a `trame_server` and must
return the `.html` property of the root widget:

```python
class Person(StateDataModel):
    first_name = Sync(str, "John")
    last_name  = Sync(str, "Doe")

    @classmethod
    def generate_gui(cls, trame_server=None) -> str:
        with v3.VCard(
            trame_server=trame_server,
            v_if="self_available && self._id",
            classes="ma-4",
        ) as root:
            with v3.VContainer():
                with v3.VRow():
                    with v3.VCol():
                        v3.VTextField(v_model="self.first_name", label="First Name")
                    with v3.VCol():
                        v3.VTextField(v_model="self.last_name",  label="Last Name")
        return root.html
```

This approach executes once per type when first needed. Because it uses the full
trame widget API, you can bind Python method calls:

```python
v3.VBtn(icon="mdi-plus", click=(cls.add_friend, "[self._id]"))
```

Note that `cls.add_friend` here is a classmethod that receives the instance id
as a string and uses `get_instance` to retrieve the live object.

### `Gui` Widget

Place a single `Gui` widget in your layout, bound to a reactive expression that
yields an instance id. The widget automatically picks the right template or
`generate_gui` output for whatever type is behind that id:

```python
from trame_dataclass.widgets import dataclass

dataclass.Gui(instance=("selected?.[0]",))
```

This lets you build UIs that handle heterogeneous lists — persons, groups,
passwords — without a manual type switch:

```python
class MultiTypes(TrameApp):
    def add_person(self):
        self.add(Person(self.server))

    def add_group(self):
        self.add(Group(self.server))

    def _build_ui(self):
        # sidebar: list of all instances (regardless of type)
        ...
        # content: the GUI for the selected instance (type-dispatched automatically)
        dataclass.Gui(instance=("selected?.[0]",))
```

---

## Inheritance

`StateDataModel` supports class inheritance. A subclass inherits all fields of
its parent and can add its own:

```python
class Base(StateDataModel):
    a = Sync(int, 10)

class Extended(Base):
    b = Sync(int, 20)

obj = Extended()
print(obj.a, obj.b)   # 10, 20
```

Field sets are tracked per class and do not bleed between siblings. If `B`
extends `A` and `C` also extends `A`, adding a field to `B` does not affect `C`.
Each class owns its own `FIELD_NAMES`, `CLIENT_NAMES`, `ENCODERS`, and other
metadata sets.

---

## Instance Utilities

### Creating a Sibling Instance

Create a fresh instance of the same class, bound to the same server:

```python
new_one = original.new_instance()
```

This gives you a brand-new instance (with its own `._id` and default field
values) tied to the same `trame_server` — it does **not** copy `original`'s
field values. To carry values over, combine it with `update()` or `copy()`:

```python
new_one = original.new_instance()
new_one.update(first_name=original.first_name, last_name=original.last_name)
```

### Bulk Update

Update multiple fields at once without triggering watchers for each individual
assignment:

```python
person.update(first_name="Carol", last_name="Chen", age=35)
```

Only fields declared on the model are accepted; unknown keys are silently
ignored.

### Copying Fields Between Instances

The `copy` helper copies a specific set of field values from one instance to
another (including across different but compatible classes):

```python
from trame.app.dataclass import copy

copy(template_person, new_person, "first_name", "last_name")
```

### Waiting for Pending Changes

If you need to await all queued async watchers and synchronization after a
series of changes:

```python
await person.completion()
```

### Removing Watchers

```python
# Clear all instance watchers
person.clear_watchers()

# Or remove a specific one using the returned callable
unwatch = person.watch(["age"], callback)
# ...later:
unwatch()
```

---

## Centralizing Cross-Instance Events

A common pattern is to forward events from _any_ instance of a class to an
application-level controller entry, allowing centralized handling:

```python
from trame.app import TrameApp
from trame.app.dataclass import StateDataModel, Sync, watch, get_instance
from trame.decorators import controller

class Entry(StateDataModel):
    name  = Sync(str, "")
    value = Sync(int, 0)

    @watch("value")
    def _on_value_change(self, value):
        self.server.controller.on_value_change(self._id, value)


class Tracker(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        self.entries = [Entry(self.server, name=f"Slot {i}", value=i) for i in range(5)]

    @controller.set("on_value_change")
    def _on_value_change(self, entry_id: str, value: int):
        entry = get_instance(entry_id)
        print(f"{entry.name} updated to {value}")
```

The instance-level watcher delegates to the controller; the controller uses
`get_instance` to retrieve the object if needed.

---

## A Complete Example: Address Book

Putting it all together, here is a minimal address book that demonstrates nested
structures, a dynamic list, and type-dispatched GUI:

```python
from trame.app import TrameApp
from trame.ui.vuetify3 import SinglePageWithDrawerLayout
from trame.app.dataclass import StateDataModel, Sync
from trame.widgets import vuetify3 as v3
from trame_dataclass.widgets import dataclass

class Person(StateDataModel):
    first_name = Sync(str, "John")
    last_name  = Sync(str, "Doe")
    TEMPLATE = """
      <VCard class="ma-4" v-if="self_available && self._id">
        <VRow>
          <VCol><VTextField v-model="self.first_name" label="First Name" /></VCol>
          <VCol><VTextField v-model="self.last_name"  label="Last Name"  /></VCol>
        </VRow>
      </VCard>
    """

class AddressBook(StateDataModel):
    contacts = Sync(list[Person], list, has_dataclass=True)


class AddressBookApp(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        self.book = AddressBook(self.server)
        self._build_ui()

    def add_contact(self):
        new = Person(self.server)
        self.book.contacts = [new, *self.book.contacts]
        self.state.selected = [new._id]

    def remove_contact(self):
        ids = set(self.state.selected)
        self.book.contacts = [p for p in self.book.contacts if p._id not in ids]
        self.state.selected = []

    def _build_ui(self):
        with SinglePageWithDrawerLayout(self.server) as self.ui:
            with self.ui.toolbar:
                v3.VSpacer()
                v3.VBtn(icon="mdi-minus", disabled=("!selected?.length",), click=self.remove_contact)
                v3.VBtn(icon="mdi-plus",  click=self.add_contact)

            with self.ui.drawer:
                with self.book.provide_as("book"):
                    with v3.VList(items=("book.contacts",), item_value="_id",
                                  v_model_selected=("selected", None)):
                        with v3.Template(v_slot_item="{ props }"):
                            with dataclass.Provider(name="item", instance=("props.value",)):
                                v3.VListItem(
                                    title=("`${item.first_name} ${item.last_name}`",),
                                    value=("item._id",),
                                )

            with self.ui.content:
                dataclass.Gui(instance=("selected?.[0]",))
```

---

## Benefits and Caveats

### Where Trame Dataclass Shines

- **Many homogeneous or heterogeneous instances**: contacts, nodes, jobs,
  pipeline stages.
- **Structured nested data**: an instance whose fields hold other instances,
  forming a graph or tree.
- **Per-instance reactivity**: watching changes on one specific object rather
  than the entire application state.
- **Type-dispatched GUI**: multiple data types shown through a single `Gui`
  widget with automatic type resolution.
- **Custom encoders**: storing non-JSON types like `Path`, NumPy arrays (via a
  custom encoder), or enums.

### Where Standard Trame State is Still the Right Tool

- Simple, flat settings shared across the entire application.
- A handful of transient display flags (active tab, dialog open, etc.).
- State that needs debouncing: trame's built-in state naturally defers
  synchronization when the server is busy, preventing unnecessary round-trips.
  Trame dataclass **always synchronizes** on change; under high-frequency
  updates (a rapidly moving slider without collaboration mode) this can produce
  more network traffic than the debounced global state.

### Hybrid Approach

The two systems compose naturally. Use standard `self.state` for
application-level concerns and `StateDataModel` for your domain entities:

```python
class MyApp(TrameApp):
    def __init__(self, server=None):
        super().__init__(server)
        # global state for layout / UI configuration
        self.state.show_sidebar = True
        self.state.theme = "light"

        # structured domain objects
        self.project = Project(self.server)
        self.nodes = [Node(self.server) for _ in range(10)]
```

### Instance Lifetime

Because instances are held in a `WeakValueDictionary`, they are
garbage-collected as soon as no Python variable holds a strong reference. If you
store instances only inside other dataclass fields (e.g., a list of contacts),
those references keep them alive as long as the parent object is alive. Always
ensure at least one Python-side reference chain exists for any instance you
expect to interact with from the browser.
