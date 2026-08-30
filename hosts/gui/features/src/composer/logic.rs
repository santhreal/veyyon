//! What the composer shows, decided without a window.

use veyyon_gui_core::{command::Command, keys, store::model::Store};

/// What the empty field says.
///
/// Set once, when the window builds the field: the field owns its placeholder
/// for its lifetime, and a placeholder that changed under the caret would move
/// while somebody read it.
pub const PLACEHOLDER: &str = "Write a message";

/// Whether there is something to send.
///
/// Blank is not something: a field holding three spaces sends nothing, so the
/// control that would send it is not lit.
pub fn armed(store: &Store) -> bool {
	store
		.selected_session()
		.is_some_and(|session| !session.draft.trim().is_empty())
}

/// What the store has to say, if anything.
///
/// A line rather than a toast: a box in the corner of the window has to be
/// dismissed, and this says one thing for four seconds and then stops.
pub fn notice(store: &Store) -> Option<&str> {
	store.notice.as_deref()
}

/// The two keystrokes worth telling a reader about, in the order they are
/// drawn.
///
/// The chords come from the one table, so a rebinding changes the hint. A hint
/// with a chord written into it goes stale the first time the table moves, and
/// the reader who trusts it presses the wrong key.
pub fn hints() -> Vec<(&'static str, &'static str)> {
	let mut hints = Vec::new();
	if let Some(keys) = keys::chord_for(&Command::Send) {
		hints.push((keys, "to send"));
	}
	// Not in the table on purpose: this one is the field's own, and the field's
	// bindings are not features. It is still the thing a reader most needs to
	// know about a field that sends on Return.
	hints.push(("shift-enter", "for a new line"));
	hints
}
