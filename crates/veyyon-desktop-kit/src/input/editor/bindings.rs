//! Idempotent default keybinding registration for Editor key context (§8.25).

use veyyon_gpui::{App, KeyBinding};

use super::actions::*;

struct EditorBindingsInstalled;
impl veyyon_gpui::Global for EditorBindingsInstalled {}
/// Registers default keybindings in the `Editor` context once per App runtime.
pub fn ensure_editor_bindings_registered(cx: &mut App) {
	if cx.has_global::<EditorBindingsInstalled>() {
		return;
	}
	cx.set_global(EditorBindingsInstalled);
	let context = Some("Editor");
	cx.bind_keys([
		KeyBinding::new("cmd-a", SelectAll, context),
		KeyBinding::new("ctrl-a", SelectAll, context),
		KeyBinding::new("cmd-z", Undo, context),
		KeyBinding::new("ctrl-z", Undo, context),
		KeyBinding::new("cmd-shift-z", Redo, context),
		KeyBinding::new("ctrl-shift-z", Redo, context),
		KeyBinding::new("ctrl-y", Redo, context),
		KeyBinding::new("cmd-c", Copy, context),
		KeyBinding::new("ctrl-c", Copy, context),
		KeyBinding::new("cmd-x", Cut, context),
		KeyBinding::new("ctrl-x", Cut, context),
		KeyBinding::new("cmd-v", Paste, context),
		KeyBinding::new("ctrl-v", Paste, context),
		KeyBinding::new("shift-enter", Newline, context),
		KeyBinding::new("enter", Enter, context),
		KeyBinding::new("escape", Escape, context),
		KeyBinding::new("left", MoveLeft, context),
		KeyBinding::new("right", MoveRight, context),
		KeyBinding::new("up", MoveUp, context),
		KeyBinding::new("down", MoveDown, context),
		KeyBinding::new("shift-left", SelectLeft, context),
		KeyBinding::new("shift-right", SelectRight, context),
		KeyBinding::new("shift-up", SelectUp, context),
		KeyBinding::new("shift-down", SelectDown, context),
		KeyBinding::new("alt-left", MoveWordLeft, context),
		KeyBinding::new("ctrl-left", MoveWordLeft, context),
		KeyBinding::new("alt-right", MoveWordRight, context),
		KeyBinding::new("ctrl-right", MoveWordRight, context),
		KeyBinding::new("alt-shift-left", SelectWordLeft, context),
		KeyBinding::new("ctrl-shift-left", SelectWordLeft, context),
		KeyBinding::new("shift-alt-left", SelectWordLeft, context),
		KeyBinding::new("alt-shift-right", SelectWordRight, context),
		KeyBinding::new("ctrl-shift-right", SelectWordRight, context),
		KeyBinding::new("shift-alt-right", SelectWordRight, context),
		KeyBinding::new("home", MoveLineStart, context),
		KeyBinding::new("cmd-left", MoveLineStart, context),
		KeyBinding::new("end", MoveLineEnd, context),
		KeyBinding::new("cmd-right", MoveLineEnd, context),
		KeyBinding::new("shift-home", SelectLineStart, context),
		KeyBinding::new("cmd-shift-left", SelectLineStart, context),
		KeyBinding::new("shift-end", SelectLineEnd, context),
		KeyBinding::new("cmd-shift-right", SelectLineEnd, context),
		KeyBinding::new("cmd-up", MoveDocStart, context),
		KeyBinding::new("ctrl-home", MoveDocStart, context),
		KeyBinding::new("cmd-down", MoveDocEnd, context),
		KeyBinding::new("ctrl-end", MoveDocEnd, context),
		KeyBinding::new("cmd-shift-up", SelectDocStart, context),
		KeyBinding::new("ctrl-shift-home", SelectDocStart, context),
		KeyBinding::new("cmd-shift-down", SelectDocEnd, context),
		KeyBinding::new("ctrl-shift-end", SelectDocEnd, context),
		KeyBinding::new("backspace", Backspace, context),
		KeyBinding::new("delete", Delete, context),
		KeyBinding::new("alt-backspace", DeleteWordBackward, context),
		KeyBinding::new("ctrl-backspace", DeleteWordBackward, context),
		KeyBinding::new("cmd-backspace", DeleteToLineStart, context),
		KeyBinding::new("alt-delete", DeleteWordForward, context),
		KeyBinding::new("ctrl-delete", DeleteWordForward, context),
		KeyBinding::new("cmd-delete", DeleteToLineEnd, context),
	]);
}
