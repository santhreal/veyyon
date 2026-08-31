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
//! the keystroke. Whether the highlighted row is inside the box that scrolls is
//! arithmetic now, and checked below; whether the box then draws it is a
//! window's question.

use veyyon_gui_core::{
	command::{self, Command},
	keys,
	palette::{self, Kind, Row},
	store::{
		model::{SettingsPage, Store},
		moves,
	},
};

use super::logic::{chord, current, mark, selected_child};

fn store() -> Store {
	let mut store = Store::opened_in("veyyon", "/repo/veyyon");
	moves::new_session(&mut store);
	palette::open(&mut store);
	store
}

fn row_for(command: Command) -> Row {
	Row {
		kind: Kind::Command,
		label: command.what().to_owned(),
		detail: String::new(),
		current: false,
		command,
	}
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

/// Rows of the given kinds, in order. Only the kind matters here: the child
/// index is decided by where a run of one kind ends and the next begins.
fn rows_of(kinds: &[Kind]) -> Vec<Row> {
	kinds
		.iter()
		.map(|kind| Row {
			kind:    *kind,
			label:   "a row".to_owned(),
			detail:  String::new(),
			current: false,
			command: Command::FocusComposer,
		})
		.collect()
}

#[test]
fn the_child_index_counts_the_heading_above_every_run() {
	// The invariant, derived rather than copied from the view: a row's place
	// among the children of the box that scrolls is its own index plus one
	// heading for every run of a kind up to and including its own. Off by one
	// here scrolls to the row above the selection, which reads as a list that
	// stops one short of the bottom.
	let kinds =
		[Kind::Conversation, Kind::Conversation, Kind::Command, Kind::Command, Kind::Command];
	let rows = rows_of(&kinds);
	for selected in 0..rows.len() {
		let runs = 1
			+ kinds[..=selected]
				.windows(2)
				.filter(|pair| pair[0] != pair[1])
				.count();
		assert_eq!(
			selected_child(&rows, selected),
			selected + runs,
			"row {selected} of {kinds:?} is addressed at the wrong child"
		);
	}
}

#[test]
fn one_run_of_rows_still_carries_its_heading() {
	// The list heads every run, including the only one, so even the first row
	// is the second child.
	let rows = rows_of(&[Kind::Command, Kind::Command]);
	assert_eq!(selected_child(&rows, 0), 1);
	assert_eq!(selected_child(&rows, 1), 2);
}

#[test]
fn a_cursor_off_the_end_of_the_list_addresses_the_first_child() {
	// Reachable between a query and the frame that draws it: the rows are the
	// new ones and the cursor is the old one. The first child is a heading, and
	// scrolling to it is the top of the list.
	let rows = rows_of(&[Kind::Command]);
	assert_eq!(selected_child(&rows, 7), 0);
	assert_eq!(selected_child(&[], 0), 0);
}

#[test]
fn walking_the_palette_moves_the_child_the_window_scrolls_to() {
	// The store-level helper, against the commands a reader presses. Both rows
	// and cursor come from the store, so this is the arithmetic the sheet draws
	// with.
	let mut store = store();
	let first = super::selected_child(&store);
	Command::MovePaletteCursor { down: true }.run(&mut store);
	let second = super::selected_child(&store);
	assert!(second > first, "a walk down addressed the same child or an earlier one");

	Command::MovePaletteCursor { down: false }.run(&mut store);
	assert_eq!(super::selected_child(&store), first, "walking back addressed a different child");
}
