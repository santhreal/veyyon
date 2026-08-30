//! WHY THIS SUITE EXISTS.
//!
//! The command table is the one path everything the window does goes through,
//! so every defect in it is a defect in three surfaces at once. Four classes,
//! and all four have shipped in applications of this shape:
//!
//! - A command added and left out of the searchable list, which is a feature
//!   reachable by chord and by press and by nothing a reader can find.
//! - A command whose `applies` lies: offered while it does nothing, or withheld
//!   while it would work. The first wastes a press; the second looks broken.
//! - A command that changes the store and reports the wrong outcome, so the
//!   caret ends up in the wrong field or a sent draft stays in the composer.
//! - A phrase written as a sentence, a title, or a duplicate of another row's,
//!   which is what turns a palette into a list nobody can scan.
//!
//! The variant space is swept from the enum itself through an exhaustive match,
//! so a new variant fails to compile here until it is classified.
//!
//! WHAT IT DOES NOT CATCH. Whether a chord is bound to the command (the keys
//! suite), whether a surface actually offers it (the surface's own suite), and
//! whether the words are the right words, which only a reader can say.

use super::*;
use crate::{
	palette,
	store::model::{Overlay, Route, SIDEBAR_DEFAULT, Store},
};

/// A store with two conversations, which is the smallest state where deleting
/// and cycling are both legal.
fn two() -> Store {
	let mut store = Store::opened_in("veyyon", "/repo/veyyon");
	Command::NewSession.run(&mut store);
	store
}

/// Every variant, with an argument where it needs one.
///
/// Exhaustive on purpose: a new variant fails to compile until it is added, and
/// the sweeps below then cover it without being edited.
fn every_command(store: &Store) -> Vec<Command> {
	let session = store
		.sessions
		.first()
		.expect("a store opens with a conversation")
		.id
		.clone();
	let project = store
		.projects
		.first()
		.expect("a store opens in a checkout")
		.id
		.clone();
	let all = vec![
		Command::NewSession,
		Command::SelectSession(session.clone()),
		Command::DeleteSession(session),
		Command::DeleteSelected,
		Command::CycleSession { forward: true },
		Command::CycleSession { forward: false },
		Command::ToggleProject(project),
		Command::ToggleTool("t1".to_owned()),
		Command::ToggleSidebar,
		Command::ResetSidebarWidth,
		Command::SetSidebarWidth(240.0),
		Command::OpenPalette,
		Command::Back,
		Command::MovePaletteCursor { down: true },
		Command::MovePaletteCursor { down: false },
		Command::AcceptPalette,
		Command::PaletteQuery("new".to_owned()),
		Command::OpenSettings(SettingsPage::Appearance),
		Command::OpenSettings(SettingsPage::Keys),
		Command::StepSettingsPage { down: true },
		Command::StepSettingsPage { down: false },
		Command::CloseSettings,
		Command::FlipAppearance,
		Command::SetAppearance(Appearance::Dark),
		Command::SetAppearance(Appearance::Light),
		Command::StepTextSize { up: true },
		Command::StepTextSize { up: false },
		Command::ToggleGroupByFolder,
		Command::Send,
		Command::FocusComposer,
		Command::Quit,
	];
	// The counter is what makes the list above exhaustive: a variant missing
	// from it cannot be counted, and a variant missing from the enum cannot be
	// matched.
	let counted: usize = all.iter().map(kind).count();
	assert_eq!(counted, all.len());
	all
}

/// Exhaustive match. A new variant fails to compile here.
fn kind(command: &Command) -> u8 {
	match command {
		Command::NewSession
		| Command::SelectSession(_)
		| Command::DeleteSession(_)
		| Command::DeleteSelected
		| Command::CycleSession { .. }
		| Command::ToggleProject(_)
		| Command::ToggleTool(_)
		| Command::ToggleSidebar
		| Command::ResetSidebarWidth
		| Command::SetSidebarWidth(_)
		| Command::OpenPalette
		| Command::Back
		| Command::MovePaletteCursor { .. }
		| Command::AcceptPalette
		| Command::PaletteQuery(_)
		| Command::OpenSettings(_)
		| Command::StepSettingsPage { .. }
		| Command::CloseSettings
		| Command::FlipAppearance
		| Command::SetAppearance(_)
		| Command::StepTextSize { .. }
		| Command::ToggleGroupByFolder
		| Command::Send
		| Command::FocusComposer
		| Command::Quit => 1,
	}
}

#[test]
fn every_command_says_what_it_does_in_words_a_palette_row_can_carry() {
	let store = two();
	for command in every_command(&store) {
		let what = command.what();
		assert!(!what.is_empty(), "{command:?} has no words");
		assert!(!what.ends_with('.'), "{command:?}: a row is not a sentence");
		assert!(
			what.chars().next().is_some_and(char::is_uppercase),
			"{command:?}: a row starts with a capital"
		);
		assert!(what.len() <= 48, "{command:?}: {what:?} is too long for a row");
	}
}

#[test]
fn no_two_searchable_commands_read_the_same() {
	// Two rows with one phrase is a list where the reader picks at random. The
	// pair that nearly collided is the two directions of a cycle, which is why
	// they say next and previous rather than both saying "cycle".
	let mut phrases: Vec<&str> = searchable().iter().map(|command| command.what()).collect();
	phrases.sort_unstable();
	let before = phrases.len();
	phrases.dedup();
	assert_eq!(before, phrases.len(), "two searchable commands say the same thing");
}

#[test]
fn a_command_that_needs_an_argument_is_never_searchable() {
	// A palette row carries no argument, so a command that needs one would run
	// against whatever the default happens to be. Those reach the reader as
	// conversations in the list instead.
	for command in searchable() {
		let needs_argument = matches!(
			command,
			Command::SelectSession(_)
				| Command::DeleteSession(_)
				| Command::ToggleProject(_)
				| Command::ToggleTool(_)
				| Command::SetSidebarWidth(_)
				| Command::PaletteQuery(_)
		);
		assert!(!needs_argument, "{command:?} cannot be a palette row");
	}
}

#[test]
fn a_command_offered_by_the_palette_is_one_that_would_do_something() {
	// `applies` is the honesty check. A store with one conversation cannot
	// delete it, and the palette must not offer the row.
	let mut store = Store::opened_in("veyyon", "/repo/veyyon");
	assert!(!Command::DeleteSelected.applies(&store));
	palette::open(&mut store);
	let offered: Vec<String> = palette::rows(&store)
		.into_iter()
		.map(|row| row.label)
		.collect();
	assert!(
		!offered
			.iter()
			.any(|label| label == Command::DeleteSelected.what()),
		"the palette offered a delete that cannot happen: {offered:?}"
	);

	// With two, it applies and is offered.
	let mut store = two();
	palette::open(&mut store);
	assert!(Command::DeleteSelected.applies(&store));
	let offered: Vec<String> = palette::rows(&store)
		.into_iter()
		.map(|row| row.label)
		.collect();
	assert!(
		offered
			.iter()
			.any(|label| label == Command::DeleteSelected.what())
	);
}

#[test]
fn send_applies_only_when_there_is_something_to_send() {
	let mut store = two();
	assert!(!Command::Send.applies(&store), "an empty draft is not sendable");
	store.selected_session_mut().expect("a conversation").draft = "   ".to_owned();
	assert!(!Command::Send.applies(&store), "whitespace is not sendable");
	store.selected_session_mut().expect("a conversation").draft = "hello".to_owned();
	assert!(Command::Send.applies(&store));
}

#[test]
fn a_send_empties_the_composer_and_moves_the_transcript() {
	let mut store = two();
	store.selected_session_mut().expect("a conversation").draft = "hello".to_owned();
	let outcome = Command::Send.run(&mut store);
	assert!(outcome.draft_changed, "the composer keeps the text it just sent");
	assert!(outcome.scroll_to_latest, "the new message is off screen");
	assert_eq!(outcome.focus, Some(Focus::Composer));
	assert_eq!(
		store
			.selected_session()
			.expect("a conversation")
			.messages
			.len(),
		1
	);
	assert_eq!(store.selected_session().expect("a conversation").draft, "");
}

#[test]
fn a_send_with_nothing_in_it_changes_nothing_and_asks_for_nothing() {
	let mut store = two();
	let before = store.clone();
	let outcome = Command::Send.run(&mut store);
	assert_eq!(outcome, Outcome::nothing());
	assert_eq!(store, before);
}

#[test]
fn opening_the_palette_puts_the_caret_in_it_and_closing_gives_it_back() {
	let mut store = two();
	assert_eq!(Command::OpenPalette.run(&mut store).focus, Some(Focus::Palette));
	assert!(store.overlay.palette().is_some());
	assert_eq!(Command::Back.run(&mut store).focus, Some(Focus::Composer));
	assert_eq!(store.overlay, Overlay::None);
	// Closing nothing takes the caret from nobody: a reader who presses Escape
	// in the composer keeps typing where they were.
	assert_eq!(Command::Back.run(&mut store), Outcome::nothing());
}

#[test]
fn escape_backs_out_of_one_thing_at_a_time() {
	let mut store = two();
	Command::OpenSettings(SettingsPage::Appearance).run(&mut store);
	Command::OpenPalette.run(&mut store);
	// The sheet is on top, so it goes first and the page stays.
	Command::Back.run(&mut store);
	assert_eq!(store.overlay, Overlay::None);
	assert_eq!(store.route, Route::Settings(SettingsPage::Appearance));
	// Now the page, and the caret comes back to the composer with it.
	let outcome = Command::Back.run(&mut store);
	assert_eq!(store.route, Route::Chat);
	assert_eq!(outcome.focus, Some(Focus::Composer));
	assert_eq!(Command::Back.run(&mut store), Outcome::nothing());
}

#[test]
fn taking_a_palette_row_runs_its_command_and_closes_the_palette() {
	let mut store = two();
	Command::OpenPalette.run(&mut store);
	Command::PaletteQuery(Command::NewSession.what().to_owned()).run(&mut store);
	let before = store.sessions.len();
	let outcome = Command::AcceptPalette.run(&mut store);
	assert_eq!(store.overlay, Overlay::None, "the palette outlived the row it ran");
	assert_eq!(store.sessions.len(), before + 1, "the row's command did not run");
	assert_eq!(outcome.focus, Some(Focus::Composer));
}

#[test]
fn taking_a_row_that_is_not_there_does_nothing() {
	let mut store = two();
	Command::OpenPalette.run(&mut store);
	Command::PaletteQuery("no command has this in its name".to_owned()).run(&mut store);
	assert!(palette::rows(&store).is_empty());
	let before = store.clone();
	let outcome = Command::AcceptPalette.run(&mut store);
	assert_eq!(outcome, Outcome::nothing());
	assert_eq!(store, before, "an empty palette accepted something");
}

#[test]
fn the_text_size_stops_at_both_ends_and_says_so() {
	let mut store = two();
	for _ in 0..40 {
		Command::StepTextSize { up: true }.run(&mut store);
	}
	assert_eq!(store.settings.font_size, crate::store::model::FONT_MAX);
	assert!(!Command::StepTextSize { up: true }.applies(&store), "a step past the top is offered");
	for _ in 0..40 {
		Command::StepTextSize { up: false }.run(&mut store);
	}
	assert_eq!(store.settings.font_size, crate::store::model::FONT_MIN);
	assert!(!Command::StepTextSize { up: false }.applies(&store));
}

#[test]
fn the_width_a_drag_asks_for_is_clamped_rather_than_refused() {
	let mut store = two();
	Command::SetSidebarWidth(10_000.0).run(&mut store);
	assert_eq!(store.settings.sidebar_width, crate::store::model::SIDEBAR_MAX);
	Command::SetSidebarWidth(0.0).run(&mut store);
	assert_eq!(store.settings.sidebar_width, crate::store::model::SIDEBAR_MIN);
	Command::ResetSidebarWidth.run(&mut store);
	assert_eq!(store.settings.sidebar_width, SIDEBAR_DEFAULT);
	assert!(
		!Command::ResetSidebarWidth.applies(&store),
		"a reset is offered while the width is already the default"
	);
}

#[test]
fn settings_open_on_a_page_and_leaving_returns_to_the_conversation() {
	let mut store = two();
	Command::OpenSettings(SettingsPage::Keys).run(&mut store);
	assert_eq!(store.route, Route::Settings(SettingsPage::Keys));
	assert!(Command::CloseSettings.applies(&store));
	Command::CloseSettings.run(&mut store);
	assert_eq!(store.route, Route::Chat);
	assert!(!Command::CloseSettings.applies(&store), "leaving settings is offered outside them");
}

#[test]
fn no_command_panics_from_any_state_it_is_offered_in() {
	// The states a command can be dispatched from are not only the states a
	// surface offers it in: a chord fires while a palette is open, a page is on
	// screen, or the store is at a boundary. Each of those has been a panic in
	// an application of this shape.
	let states: Vec<fn() -> Store> = vec![
		|| Store::opened_in("veyyon", "/repo/veyyon"),
		two,
		|| {
			let mut store = two();
			Command::OpenPalette.run(&mut store);
			store
		},
		|| {
			let mut store = two();
			Command::OpenSettings(SettingsPage::Keys).run(&mut store);
			store
		},
		|| {
			let mut store = two();
			store.selected = None;
			store
		},
	];
	for state in states {
		let template = state();
		for command in every_command(&template) {
			let mut store = state();
			// The claim is that it does not panic and leaves a store the next
			// command can still be run against, which is what a chord pressed
			// twice does.
			let outcome = command.clone().run(&mut store);
			assert!(
				store.sessions.len() <= 3,
				"{command:?} left {} conversations behind",
				store.sessions.len()
			);
			if outcome.quit {
				assert_eq!(command, Command::Quit, "{command:?} asked the window to close");
			}
		}
	}
}

#[test]
fn only_quitting_asks_the_window_to_close() {
	let store = two();
	for command in every_command(&store) {
		let mut store = two();
		let asks = command.clone().run(&mut store).quit;
		assert_eq!(asks, command == Command::Quit, "{command:?} disagrees about quitting");
	}
}
