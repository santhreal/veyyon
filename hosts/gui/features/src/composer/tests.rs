//! WHY THIS SUITE EXISTS.
//!
//! Two defects, both of which a reader meets before anything else in the
//! window: a send control that looks pressable over an empty field, and a hint
//! that prints a chord the window does not answer to. The second is the one
//! that survives a refactor, because moving a binding in the key table leaves a
//! hardcoded hint behind saying the old one.
//!
//! WHAT IT DOES NOT CATCH. Whether the caret is in the field, which needs a
//! window, and how the hint wraps at a narrow width.

use veyyon_gui_core::{
	command::Command,
	keys,
	store::{model::Store, moves},
};

use super::logic::{PLACEHOLDER, armed, hints, notice};

fn store() -> Store {
	Store::opened_in("veyyon", "/repo/veyyon")
}

#[test]
fn a_field_of_whitespace_has_nothing_to_send() {
	let mut store = store();
	assert!(!armed(&store), "an untouched field is not armed");
	for blank in ["", " ", "\t", "\n", "   \n\t "] {
		moves::set_draft(&mut store, blank.to_owned(), blank.len());
		assert!(!armed(&store), "{blank:?} is not a message");
	}
	moves::set_draft(&mut store, " x ".to_owned(), 3);
	assert!(armed(&store), "a character surrounded by blanks is a message");
}

#[test]
fn every_hint_prints_a_chord_the_window_answers_to() {
	// The defect this closes: a hint written as a literal, left saying
	// "secondary-return" after the table moved to something else. Both tables
	// are checked, because one of the two chords is the field's own.
	let commands: Vec<String> = crate::act::bindings()
		.iter()
		.chain(veyyon_gui_kit::input::keys::bindings().iter())
		.map(|binding| {
			binding
				.keystrokes()
				.iter()
				.map(|keystroke| keystroke.inner().unparse())
				.collect::<Vec<String>>()
				.join(" ")
		})
		.collect();
	for (chord, _) in hints() {
		let wanted = gpui::Keystroke::parse(chord)
			.expect("a hint's chord parses")
			.unparse();
		assert!(commands.contains(&wanted), "{chord:?} is in the hint and in no key table");
	}
}

#[test]
fn the_send_hint_is_whatever_the_table_says_sends() {
	let sends = keys::chord_for(&Command::Send).expect("send is bound");
	let hints = hints();
	assert_eq!(hints.first().map(|(chord, _)| *chord), Some(sends));
	assert_eq!(hints.first().map(|(_, what)| *what), Some("to send"));
}

#[test]
fn the_hint_is_two_rows_and_says_what_each_one_does() {
	// A hint is one line under a field. Three chords is a keyboard page, which
	// is a different surface and is reachable from settings.
	let hints = hints();
	assert_eq!(hints.len(), 2, "{hints:?} is not a hint any more");
	for (chord, what) in hints {
		assert!(!chord.is_empty() && !what.is_empty());
		assert!(what.len() < 24, "{what:?} is a sentence, not a label");
	}
}

#[test]
fn a_notice_is_shown_while_the_store_holds_one_and_not_after() {
	let mut store = store();
	assert_eq!(notice(&store), None);
	moves::notify(&mut store, "Deleted");
	assert_eq!(notice(&store), Some("Deleted"));
	// The store retires it on its own clock, and the composer follows rather
	// than keeping a copy: a line that outlives the notice is a stale claim.
	let deadline = store.notice_until.expect("a notice has a deadline");
	moves::tick(&mut store, deadline + 1);
	assert_eq!(notice(&store), None);
}

#[test]
fn the_placeholder_says_what_to_do_and_names_nothing() {
	// The window says "veyyon" once in its chrome at most, and this is not the
	// place: a placeholder is an instruction.
	assert!(!PLACEHOLDER.to_lowercase().contains("veyyon"));
	assert!(PLACEHOLDER.len() < 32, "{PLACEHOLDER:?} is a paragraph in a field");
	assert!(!PLACEHOLDER.ends_with('.'), "a placeholder is a label, not a sentence");
}
