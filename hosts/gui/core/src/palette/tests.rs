//! WHY THIS SUITE EXISTS.
//!
//! The palette draws one list, highlights one index into it, and runs whatever
//! that index points at. Three collections have to agree, and the defect class
//! is any disagreement between them:
//!
//! - the drawn rows and the filtered rows differing, so the highlight sits on a
//!   row the reader is not looking at;
//! - a cursor left past the end of a shortened list, which runs the wrong row
//!   or nothing at all on Return;
//! - a match found on text the row does not print, which answers a query with a
//!   line that has nothing to do with it;
//! - an accept that runs a row and leaves the sheet on screen, over the page it
//!   just opened.
//!
//! The command corpus is swept from `command::searchable()` at run time, so a
//! command added to that list is covered here without editing this file.
//!
//! WHAT IT DOES NOT CATCH. Ranking. The rows come back in a defined order and
//! the tests pin that order, but whether the first row is the one a reader
//! meant is not a property a test can hold.

use super::*;
use crate::store::{
	model::{SessionId, SettingsPage},
	moves,
};

fn store() -> Store {
	Store::opened_in("veyyon", "/repo/veyyon")
}

/// Send one message so a conversation takes its title from the text, which is
/// what makes a conversation findable by typing.
fn titled(store: &mut Store, text: &str) -> SessionId {
	let id = moves::new_session(store);
	moves::set_draft(store, text.to_owned(), text.len());
	moves::send(store);
	id
}

#[test]
fn the_palette_opens_empty_at_the_first_row_and_a_closed_one_lists_nothing() {
	let mut store = store();
	open(&mut store);
	let palette = store.overlay.palette().expect("the palette is open");
	assert_eq!(palette.query, "");
	assert_eq!(palette.selected, 0);
	assert!(!rows(&store).is_empty());

	close(&mut store);
	assert!(!store.overlay.is_open());
	assert!(rows(&store).is_empty(), "a closed palette still has rows to draw");
}

#[test]
fn the_list_is_every_conversation_and_then_every_command_that_applies() {
	let mut store = store();
	moves::new_session(&mut store);
	open(&mut store);

	let rows = rows(&store);
	let conversations = store.sessions.len();
	let commands = crate::command::searchable()
		.into_iter()
		.filter(|command| command.applies(&store))
		.count();
	assert_eq!(
		rows.len(),
		conversations + commands,
		"a row the palette does not list is a command nobody can find"
	);
	// Conversations first, unbroken: switching is the common case, and a list
	// that interleaves the two makes it scroll.
	assert!(
		rows[..conversations]
			.iter()
			.all(|row| row.kind == Kind::Conversation),
		"a command landed among the conversations"
	);
	assert!(
		rows[conversations..]
			.iter()
			.all(|row| row.kind == Kind::Command)
	);
	assert_eq!(
		rows.iter().filter(|row| row.current).count(),
		1,
		"exactly one row is the conversation that is open"
	);
}

#[test]
fn typing_filters_both_corpora_and_puts_the_cursor_back_on_the_first_match() {
	let mut store = store();
	titled(&mut store, "the caret jumps in the composer");
	open(&mut store);
	move_cursor(&mut store, 3);
	assert!(store.overlay.palette().expect("open").selected > 0);

	query(&mut store, "caret".to_owned());
	assert_eq!(
		store.overlay.palette().expect("open").selected,
		0,
		"the cursor stayed past the end of the shortened list"
	);
	let matched = rows(&store);
	assert_eq!(matched.len(), 1);
	assert_eq!(matched[0].kind, Kind::Conversation, "a conversation was matched as a command");

	query(&mut store, "no such thing anywhere".to_owned());
	assert!(rows(&store).is_empty());
}

#[test]
fn a_command_is_found_by_the_words_a_reader_would_type_for_it() {
	// Keywords, not the phrase alone: "dark" and "theme" are what somebody
	// looking for the appearance switch types, and neither is in its name.
	let mut store = store();
	open(&mut store);
	for word in ["dark", "theme", "light"] {
		query(&mut store, word.to_owned());
		let found: Vec<String> = rows(&store).into_iter().map(|row| row.label).collect();
		assert!(
			found
				.iter()
				.any(|label| label == crate::command::Command::FlipAppearance.what()),
			"{word:?} did not find the appearance switch: {found:?}"
		);
	}
}

#[test]
fn every_match_is_visible_in_the_row_it_produced() {
	// A corpus matched on something the row does not print is a query answered
	// with a line the reader cannot connect to what they typed. A command may
	// match on a keyword, so its label is exempt; a conversation may not.
	let mut store = store();
	titled(&mut store, "a note about the sidebar");
	open(&mut store);
	for text in ["a", "conv", "side", "settings", "light", "delete"] {
		query(&mut store, text.to_owned());
		for row in rows(&store)
			.into_iter()
			.filter(|row| row.kind == Kind::Conversation)
		{
			assert!(
				row.label.to_lowercase().contains(text),
				"{text:?} returned the conversation {:?}, which does not contain it",
				row.label
			);
		}
	}
}

#[test]
fn the_cursor_clamps_at_both_ends_rather_than_wrapping() {
	// A list that wraps under a held arrow key never settles at either end,
	// which is the one thing a reader is trying to do with a held key.
	let mut store = store();
	open(&mut store);
	let count = rows(&store).len();
	assert!(count > 1);

	move_cursor(&mut store, -5);
	assert_eq!(store.overlay.palette().expect("open").selected, 0);
	move_cursor(&mut store, count as isize + 5);
	assert_eq!(store.overlay.palette().expect("open").selected, count - 1);
}

#[test]
fn taking_a_conversation_row_hands_back_the_command_that_shows_it() {
	let mut store = store();
	let first = store.sessions[0].id.clone();
	let second = titled(&mut store, "the other conversation");
	moves::select(&mut store, &first);

	open(&mut store);
	let at = rows(&store)
		.iter()
		.position(|row| row.command == Command::SelectSession(second.clone()))
		.expect("the other conversation is in the list");
	move_cursor(&mut store, at as isize);
	let taken = accept(&mut store);

	assert_eq!(taken, Some(Command::SelectSession(second)));
	assert!(!store.overlay.is_open(), "the sheet outlived the row it ran");
}

#[test]
fn the_palette_closes_before_its_command_runs() {
	// A command that opens a page or another overlay would otherwise leave the
	// palette floating over what it opened.
	let mut store = store();
	open(&mut store);
	query(
		&mut store,
		Command::OpenSettings(SettingsPage::Appearance)
			.what()
			.to_owned(),
	);
	let taken = accept(&mut store).expect("a row matched");
	assert!(!store.overlay.is_open());
	taken.run(&mut store);
	assert!(!store.overlay.is_open(), "settings opened behind the palette");
}

#[test]
fn taking_a_row_from_an_empty_list_changes_nothing() {
	let mut store = store();
	open(&mut store);
	query(&mut store, "nothing matches this".to_owned());
	let before = store.clone();
	assert_eq!(accept(&mut store), None);
	assert_eq!(store, before, "an accept over an empty list did something");
}

#[test]
fn every_command_the_palette_offers_changes_the_store() {
	// The class this closes: a row offered for a command whose `run` is a no-op
	// in the state it was offered from, which reads as a dead row. Focus-only
	// commands are the recorded exception, since their whole effect is an
	// outcome the shell carries out.
	let mut store = store();
	titled(&mut store, "something to send");
	moves::set_draft(&mut store, "a draft".to_owned(), "a draft".len());
	open(&mut store);

	let mut dead: Vec<&'static str> = Vec::new();
	for row in rows(&store)
		.into_iter()
		.filter(|row| row.kind == Kind::Command)
	{
		let mut probe = store.clone();
		close(&mut probe);
		let quiet = probe.clone();
		let outcome = row.command.clone().run(&mut probe);
		probe.notice = None;
		probe.notice_until = None;
		if probe == quiet && outcome == crate::command::Outcome::nothing() {
			dead.push(row.command.what());
		}
	}
	assert_eq!(dead, Vec::<&'static str>::new());
}
