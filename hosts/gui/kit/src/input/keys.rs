//! The caret's own bindings.
//!
//! Thirty rows, none of them a feature. A field that did not answer to Home
//! would be a defect, so these are not documented anywhere a reader looks: a
//! shortcuts page listing thirty caret motions hides the ten that matter.
//!
//! They live beside the field rather than in the application's table for the
//! same reason the field lives here: a second window, a dialog, or a settings
//! form that puts an [`Editor`](super::Editor) on screen gets a working caret
//! by installing this table, and cannot get half of one.
//!
//! Contexts are predicates over the names a field declares on itself, so a
//! motion is written once instead of once per kind of field.

use gpui::{Action, DummyKeyboardMapper, KeyBinding, KeyBindingContextPredicate};

use super::{
	Backspace, Copy, Cut, Delete, DeleteToLineEnd, DeleteWordLeft, DeleteWordRight, DocEnd,
	DocStart, Down, End, Home, Left, Newline, Paste, Right, SelectAll, SelectDown, SelectEnd,
	SelectHome, SelectLeft, SelectRight, SelectUp, SelectWordLeft, SelectWordRight,
	ShowCharacterPalette, Up, WordLeft, WordRight,
};

/// Every field the caret motions apply in.
///
/// A predicate over the names a field declares, not a name any element carries:
/// that is what keeps a caret motion from firing while the shell has the
/// keyboard.
const EDITING: &str = "Editor || MultilineEditor || PaletteSearch";

/// The fields a vertical motion means something in.
///
/// Not the palette's field. There, up and down walk the list under it, and a
/// motion bound on the same keystroke in a context that also matched would
/// shadow whichever of the two was installed second.
const ROWS: &str = "Editor || MultilineEditor";

/// The one field where a keystroke can insert a line.
///
/// A single-line field ignores a newline anyway, but binding it there claims
/// the keystroke: the palette's field would swallow shift-enter rather than let
/// it reach whatever the window does with it.
const MULTILINE: &str = "MultilineEditor";

/// Kill to the end of the line.
///
/// `ctrl-k` is the macOS text system's spelling. Everywhere else that keystroke
/// is the command palette, since `secondary-` resolves to `ctrl-`, and the
/// palette is the one a reader reaches for: a field motion cannot take the
/// window's primary command surface.
#[cfg(target_os = "macos")]
const KILL_LINE: &str = "ctrl-k";
#[cfg(not(target_os = "macos"))]
const KILL_LINE: &str = "ctrl-shift-k";

/// One binding: the chord, the fields it applies in, and the action it sends.
struct Row {
	keys:    &'static str,
	context: &'static str,
	action:  fn() -> Box<dyn Action>,
}

/// Applies wherever a caret is.
fn editing(keys: &'static str, action: fn() -> Box<dyn Action>) -> Row {
	Row { keys, context: EDITING, action }
}

/// Applies only where the text has rows to move through.
fn rows(keys: &'static str, action: fn() -> Box<dyn Action>) -> Row {
	Row { keys, context: ROWS, action }
}

/// Applies only in a field that has more than one line to give.
fn multiline(keys: &'static str, action: fn() -> Box<dyn Action>) -> Row {
	Row { keys, context: MULTILINE, action }
}

fn table() -> Vec<Row> {
	vec![
		// Moving.
		editing("left", || Box::new(Left)),
		editing("right", || Box::new(Right)),
		rows("up", || Box::new(Up)),
		rows("down", || Box::new(Down)),
		editing("alt-left", || Box::new(WordLeft)),
		editing("alt-right", || Box::new(WordRight)),
		editing("secondary-left", || Box::new(Home)),
		editing("secondary-right", || Box::new(End)),
		editing("home", || Box::new(Home)),
		editing("end", || Box::new(End)),
		editing("secondary-up", || Box::new(DocStart)),
		editing("secondary-down", || Box::new(DocEnd)),
		// Selecting. Every motion above that a reader can hold shift with.
		editing("shift-left", || Box::new(SelectLeft)),
		editing("shift-right", || Box::new(SelectRight)),
		rows("shift-up", || Box::new(SelectUp)),
		rows("shift-down", || Box::new(SelectDown)),
		editing("alt-shift-left", || Box::new(SelectWordLeft)),
		editing("alt-shift-right", || Box::new(SelectWordRight)),
		editing("secondary-shift-left", || Box::new(SelectHome)),
		editing("secondary-shift-right", || Box::new(SelectEnd)),
		editing("secondary-a", || Box::new(SelectAll)),
		// Deleting.
		editing("backspace", || Box::new(Backspace)),
		editing("delete", || Box::new(Delete)),
		editing("alt-backspace", || Box::new(DeleteWordLeft)),
		editing("alt-delete", || Box::new(DeleteWordRight)),
		editing(KILL_LINE, || Box::new(DeleteToLineEnd)),
		// The clipboard, and the system's own character picker.
		editing("secondary-c", || Box::new(Copy)),
		editing("secondary-x", || Box::new(Cut)),
		editing("secondary-v", || Box::new(Paste)),
		editing("ctrl-secondary-space", || Box::new(ShowCharacterPalette)),
		// Writing a line without ending the message. The other half of this pair
		// is not here: plain Return sends, which is a decision about the
		// application rather than about the caret, and it lives in the command
		// table with everything else a reader can look up.
		multiline("shift-enter", || Box::new(Newline)),
	]
}

/// Every caret binding, ready for `App::bind_keys`.
///
/// Panics on a row that does not parse, which is what a test turns into a
/// failure instead of a launch that silently ignores a key.
pub fn bindings() -> Vec<KeyBinding> {
	table()
		.into_iter()
		.map(|row| {
			let predicate = KeyBindingContextPredicate::parse(row.context)
				.expect("a caret binding's context must parse");
			KeyBinding::load(
				row.keys,
				(row.action)(),
				Some(std::rc::Rc::new(predicate)),
				false,
				None,
				&DummyKeyboardMapper,
			)
			.expect("a caret binding's keystroke must parse")
		})
		.collect()
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS. Every row here is a string the compiler cannot
	//! check, and both halves fail silently: a misspelled keystroke or a context
	//! predicate that does not parse would panic at launch, and a chord claimed
	//! twice in one context is a motion that never fires with nothing to say so.
	//!
	//! WHAT IT DOES NOT CATCH. Whether the field acts on the action it receives,
	//! which the editor's own suite proves, and whether an element declares the
	//! context names these predicates read, which needs a window.

	use super::*;

	#[test]
	fn every_caret_binding_parses() {
		assert_eq!(bindings().len(), table().len());
	}

	/// Every context the table uses, read out of the table rather than listed:
	/// a row in a context nobody sweeps is a row nothing checks.
	fn contexts() -> Vec<&'static str> {
		let mut contexts: Vec<&'static str> = Vec::new();
		for row in table() {
			if !contexts.contains(&row.context) {
				contexts.push(row.context);
			}
		}
		contexts.sort_unstable();
		contexts
	}

	/// Which contexts a field in `narrow` also matches, widest last. Pinned here
	/// because it is a claim about the predicate strings above, and a new
	/// context that is not in it fails
	/// `every_context_states_what_it_is_inside_of`.
	fn wider_than(narrow: &str) -> Vec<&'static str> {
		match narrow {
			_ if narrow == MULTILINE => vec![ROWS, EDITING],
			_ if narrow == ROWS => vec![EDITING],
			_ if narrow == EDITING => Vec::new(),
			other => panic!("{other} is a context nothing knows the shape of"),
		}
	}

	#[test]
	fn every_context_states_what_it_is_inside_of() {
		// The sweep that fails on a new context: adding one and leaving it out
		// of `wider_than` panics here rather than quietly skipping the clash
		// check below.
		for context in contexts() {
			let _ = wider_than(context);
		}
	}

	#[test]
	fn no_chord_is_claimed_twice_in_one_kind_of_field() {
		// Two rows on one chord where both contexts can match at once is a row
		// that never fires. The vertical motions are the case that nearly went
		// wrong: up and down in a field, and up and down in the palette's list.
		let mut clashes: Vec<String> = Vec::new();
		for context in contexts() {
			let mut claimed: Vec<&'static str> = Vec::new();
			for row in table().into_iter().filter(|row| row.context == context) {
				if claimed.contains(&row.keys) {
					clashes.push(format!("{} is claimed twice in {context}", row.keys));
				}
				claimed.push(row.keys);
			}

			// And a chord in the narrower context is not also bound in a wider
			// one, since both match wherever the narrower does.
			for wide in wider_than(context) {
				let outer: Vec<&'static str> = table()
					.into_iter()
					.filter(|row| row.context == wide)
					.map(|row| row.keys)
					.collect();
				for row in table().into_iter().filter(|row| row.context == context) {
					if outer.contains(&row.keys) {
						clashes.push(format!("{} is bound in {context} and in {wide}", row.keys));
					}
				}
			}
		}
		assert_eq!(clashes, Vec::<String>::new());
	}

	#[test]
	fn the_kill_line_chord_never_takes_the_command_palette() {
		// `secondary-k` opens the palette, and `secondary-` is Control off
		// macOS: a field motion on `ctrl-k` there would eat it.
		assert_eq!(
			KILL_LINE,
			if cfg!(target_os = "macos") {
				"ctrl-k"
			} else {
				"ctrl-shift-k"
			}
		);
		assert!(table().into_iter().all(|row| row.keys != "ctrl-k") || cfg!(target_os = "macos"));
	}

	#[test]
	fn a_motion_that_needs_rows_is_not_bound_where_there_are_none() {
		// Pinned by equality: a motion moved between the two contexts shows up
		// here, because that decision is what the palette's arrow keys depend
		// on.
		let mut vertical: Vec<&'static str> = table()
			.into_iter()
			.filter(|row| row.context == ROWS)
			.map(|row| row.keys)
			.collect();
		vertical.sort_unstable();
		assert_eq!(vertical, vec!["down", "shift-down", "shift-up", "up"]);
	}

	#[test]
	fn only_a_field_with_rows_can_be_given_another_one() {
		// A newline in the palette's field would be a line inserted into a
		// search box; in a single-line field it would be a keystroke claimed and
		// dropped. Pinned by equality so moving it has to be a decision.
		let rows: Vec<&'static str> = table()
			.into_iter()
			.filter(|row| row.context == MULTILINE)
			.map(|row| row.keys)
			.collect();
		assert_eq!(rows, vec!["shift-enter"]);
	}
}
