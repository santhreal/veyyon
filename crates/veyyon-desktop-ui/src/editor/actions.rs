//! Editor actions and their default key bindings.
//!
//! Every binding is scoped to the [`KEY_CONTEXT`] key context, so a key the
//! editor does not handle reaches its ancestors. Both the `cmd` and the `ctrl`
//! spellings of the editing shortcuts are bound.

#![allow(
	clippy::derive_partial_eq_without_eq,
	reason = "the `actions!` macro derives `PartialEq` on unit structs"
)]

use veyyon_gpui::{App, Global, KeyBinding, actions};

/// The key context an editor element declares.
pub const KEY_CONTEXT: &str = "Editor";

actions!(text_editor, [
	MoveLeft,
	MoveRight,
	MoveUp,
	MoveDown,
	SelectLeft,
	SelectRight,
	SelectUp,
	SelectDown,
	MoveWordLeft,
	MoveWordRight,
	SelectWordLeft,
	SelectWordRight,
	MoveLineStart,
	MoveLineEnd,
	SelectLineStart,
	SelectLineEnd,
	MoveDocStart,
	MoveDocEnd,
	SelectDocStart,
	SelectDocEnd,
	SelectAll,
	Backspace,
	Delete,
	DeleteWordBackward,
	DeleteWordForward,
	DeleteToLineStart,
	DeleteToLineEnd,
	Undo,
	Redo,
	Copy,
	Cut,
	Paste,
	Enter,
	Newline,
	Escape,
]);

/// Marks an app whose keymap already holds the editor bindings.
struct Bound;

impl Global for Bound {}

/// Adds the default editor bindings to the app keymap, once per app.
pub fn bind_keys(cx: &mut App) {
	if cx.has_global::<Bound>() {
		return;
	}
	cx.set_global(Bound);
	let context = Some(KEY_CONTEXT);
	cx.bind_keys([
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
		KeyBinding::new("alt-shift-right", SelectWordRight, context),
		KeyBinding::new("ctrl-shift-right", SelectWordRight, context),
		KeyBinding::new("home", MoveLineStart, context),
		KeyBinding::new("cmd-left", MoveLineStart, context),
		KeyBinding::new("end", MoveLineEnd, context),
		KeyBinding::new("cmd-right", MoveLineEnd, context),
		KeyBinding::new("shift-home", SelectLineStart, context),
		KeyBinding::new("cmd-shift-left", SelectLineStart, context),
		KeyBinding::new("shift-end", SelectLineEnd, context),
		KeyBinding::new("cmd-shift-right", SelectLineEnd, context),
		KeyBinding::new("ctrl-home", MoveDocStart, context),
		KeyBinding::new("cmd-up", MoveDocStart, context),
		KeyBinding::new("ctrl-end", MoveDocEnd, context),
		KeyBinding::new("cmd-down", MoveDocEnd, context),
		KeyBinding::new("ctrl-shift-home", SelectDocStart, context),
		KeyBinding::new("cmd-shift-up", SelectDocStart, context),
		KeyBinding::new("ctrl-shift-end", SelectDocEnd, context),
		KeyBinding::new("cmd-shift-down", SelectDocEnd, context),
		KeyBinding::new("ctrl-a", SelectAll, context),
		KeyBinding::new("cmd-a", SelectAll, context),
		KeyBinding::new("backspace", Backspace, context),
		KeyBinding::new("shift-backspace", Backspace, context),
		KeyBinding::new("delete", Delete, context),
		KeyBinding::new("alt-backspace", DeleteWordBackward, context),
		KeyBinding::new("ctrl-backspace", DeleteWordBackward, context),
		KeyBinding::new("alt-delete", DeleteWordForward, context),
		KeyBinding::new("ctrl-delete", DeleteWordForward, context),
		KeyBinding::new("cmd-backspace", DeleteToLineStart, context),
		KeyBinding::new("cmd-delete", DeleteToLineEnd, context),
		KeyBinding::new("ctrl-z", Undo, context),
		KeyBinding::new("cmd-z", Undo, context),
		KeyBinding::new("ctrl-shift-z", Redo, context),
		KeyBinding::new("cmd-shift-z", Redo, context),
		KeyBinding::new("ctrl-y", Redo, context),
		KeyBinding::new("ctrl-c", Copy, context),
		KeyBinding::new("cmd-c", Copy, context),
		KeyBinding::new("ctrl-insert", Copy, context),
		KeyBinding::new("ctrl-x", Cut, context),
		KeyBinding::new("cmd-x", Cut, context),
		KeyBinding::new("ctrl-v", Paste, context),
		KeyBinding::new("cmd-v", Paste, context),
		KeyBinding::new("shift-insert", Paste, context),
		KeyBinding::new("enter", Enter, context),
		KeyBinding::new("shift-enter", Newline, context),
		KeyBinding::new("escape", Escape, context),
	]);
}
