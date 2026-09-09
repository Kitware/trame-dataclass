// trame-dataclass: react counterpart to vue-components/src/main.js.
//
// The trame react client evaluates the `react_use` module entry (see
// trame_dataclass/module/__init__.py) and calls `install()` once this
// script (loaded as a plain UMD <script> tag, no build-time import access
// to the react client's own modules) has executed.
import TrameDataclass from "./TrameDataclass.jsx";

export function install() {
  window.trame.registerTag("trame-dataclass", TrameDataclass);
}
