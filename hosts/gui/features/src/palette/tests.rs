//! WHY THIS SUITE EXISTS.
//!
//! A palette row makes two promises beyond its words: the mark at its left says
//! what kind of thing it is, and the chord at its right says which keystroke
//! does it. The second is the one that breaks quietly. A chord stored on a row,
//! or written next to a command by hand, keeps printing after the key table
//! moves, and a reader who trusts it presses a key that does something else.
//!
//! The sweep runs over every searchable command, so a command added to the
//! table is checked here without anybody remembering to.
//!
//! WHAT IT DOES NOT CATCH. Whether the sheet is drawn where the eye is after
//! the keystroke, and whether the highlighted row is visible without scrolling.

use veyyon_gui_core::{
	command::{self, Command},
	keys,
	palette::{self, Row},
	store::{
		model::{SettingsPage, Store},
		moves,
	},
};

use super::logic::{chord, current, mark};

fn store() -> Store {
	let mut store = Store::opened_in("veyyon", "/repo/veyyon");
	moves::new_session(&mut store);
	palette::open(&mut store);
	store
}

fn row_for(command: Command) -> Row {
	Row { label: command.what().to_owned(), detail: "Command".to_owned(), current: false, command }
}

#[test]
fn a_chord_beside_a_row_is_the_chord_the_window_installs() {
	// The sweep. Every command a reader can find is checked against the one
	// table, so a chord printed here cannot disagree with the key that runs.
	for command in command::searchable() {
		let printed = chord(&row_for(command.clone()));
		assert_eq!(printed, keys::chord_for(&command), "{command:?} prints a chord nothing runs");
	}
}

#[test]
fn a_command_with_no_chord_prints_none_rather_than_an_empty_cap() {
	// An empty key cap beside a row reads as a chord nobody can make out.
	let unbound = row_for(Command::ToggleGroupByFolder);
	assert_eq!(chord(&unbound), None, "grouping is not bound, so nothing is printed");
	let bound = row_for(Command::OpenSettings(SettingsPage::Appearance));
	assert!(chord(&bound).is_some(), "settings is bound, so its chord is printed");
}

#[test]
fn a_conversation_row_carries_no_chord_and_no_mark() {
	// Both would be wrong for a different reason: there is no keystroke that
	// opens one particular conversation, and a mark repeated down a column of
	// titles is noise that hides the two rows that mean something.
	let store = store();
	let rows = palette::rows(&store);
	let conversation = rows
		.iter()
		.find(|row| matches!(row.command, Command::SelectSession(_)))
		.expect("a conversation is in the list");
	assert_eq!(chord(conversation), None);
	assert_eq!(mark(conversation), None);
}

#[test]
fn the_row_already_on_screen_is_the_one_marked_current() {
	let store = store();
	let rows = palette::rows(&store);
	let marked: Vec<&str> = rows
		.iter()
		.filter(|row| current(row))
		.map(|row| row.label.as_str())
		.collect();
	let selected = store
		.selected_session()
		.expect("a conversation is selected");
	assert_eq!(marked, vec![selected.title.as_str()], "exactly the conversation on screen");
}

#[test]
fn a_mark_is_drawn_for_the_commands_that_have_one_and_no_others() {
	// Pinned against the glyph table by construction rather than by a second
	// list, so the decision lives in one place.
	for command in command::searchable() {
		assert_eq!(
			mark(&row_for(command.clone())),
			crate::glyph::of(&command),
			"{command:?} draws something the glyph table does not agree with"
		);
	}
}

#[test]
fn a_filtered_list_never_leaves_the_cursor_on_a_row_it_does_not_draw() {
	// The defect that makes the keyboard untrustworthy: the highlight at an
	// index past the end, and Return running whatever the clamp lands on. The
	// view reads both from these two functions, so this is the same arithmetic
	// the sheet draws with.
	let mut store = store();
	for query in ["", "a", "conversation", "zzzz", "  ", "APPEARANCE"] {
		palette::query(&mut store, query.to_owned());
		let rows = palette::rows(&store);
		let selected = store
			.overlay
			.palette()
			.expect("the palette is open")
			.selected;
		if rows.is_empty() {
			assert_eq!(selected, 0, "{query:?}: nothing to highlight");
		} else {
			assert!(selected < rows.len(), "{query:?}: the highlight is off the end of the list");
		}
	}
}
