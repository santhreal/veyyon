//! WHY: `/retry` and `/rephrase` both address what the agent said last, and
//! the window reaches them from two places: the command list and the menu a
//! right-click opens on a turn. A menu built from the turn alone offers them
//! on every answer in the transcript, so a press on an answer from an hour ago
//! sends a request the host answers against the last one — a turn the operator
//! was not looking at is re-run, or a reply they did not point at is asked for
//! again. A prompt is worse still: neither verb has an answer to work from
//! there, and the host refuses the press after the menu promised it.
//!
//! CLASS CLOSED: a turn-level verb offered on a turn it does not act on. The
//! menu is built for every combination of the two facts it reads — whether the
//! turn is a prompt, and whether it is the transcript's last — so a row
//! offered on the wrong one of the four is an assertion here rather than a
//! refusal the operator meets. The command rows and the actions both verbs
//! send are swept beside it, since a row that lists and maps to nothing is the
//! same silence from the other end.
//!
//! NOT CAUGHT: what the host does with either action, which
//! `packages/coding-agent/test/gui-host/
//! a-turn-that-failed-is-run-again-and-a-finished-reply-is-said-again.test.ts`
//! owns against a real session, and the pointer hit test that decides which
//! turn the menu opened on, which `a-fork-can-be-cut-at-a-turn-other-than-the-
//! last.rs` owns.

mod support;

use std::collections::HashMap;

use support::{NOW_MS, session};
use veyyon_desktop::{SessionIndex, actions_for, project};
use veyyon_desktop_model::{HostAction, QueuePartition, SessionId, Store};
use veyyon_desktop_surface::{
	Intent, ShellState,
	palette::{PaletteItemKind, commands::command_items},
	transcript::{TurnMenu, turn_menu_items},
};
use veyyon_gpui::{Pixels, Point, px};

/// A menu opened on a turn that is a prompt or an answer, last or earlier.
fn menu(forkable: bool, last: bool) -> TurnMenu {
	TurnMenu {
		turn: 3,
		origin: Point::<Pixels> { x: px(10.0), y: px(20.0) },
		text: "what was said".to_owned(),
		forkable,
		last,
	}
}

/// The rows the menu draws, by label, in the order they are drawn.
fn labels(menu: &TurnMenu) -> Vec<String> {
	turn_menu_items(menu)
		.into_iter()
		.map(|(item, _)| item.label.to_string())
		.collect()
}

/// The intents the menu's rows send, in the order they are drawn.
fn intents(menu: &TurnMenu) -> Vec<Intent> {
	turn_menu_items(menu)
		.into_iter()
		.map(|(_, intent)| intent)
		.collect()
}

/// A store holding one session, open, and the index that names its row.
fn open_session() -> (Store, SessionIndex) {
	let mut store = Store::new();
	store.sessions.insert(session("s", QueuePartition::Live));
	store.persisted.shell.active_session = Some(SessionId::from("s"));
	let mut index = SessionIndex::new();
	let mut state = ShellState::default();
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	(store, index)
}

#[test]
fn the_last_answer_is_the_only_turn_that_offers_running_again_or_saying_again() {
	assert_eq!(labels(&menu(false, true)), ["Copy", "Run again", "Say that in plainer prose"]);
	assert_eq!(intents(&menu(false, true)), [
		Intent::CopyText("what was said".to_owned()),
		Intent::RetryTurn,
		Intent::RephraseReply,
	]);
}

#[test]
fn an_earlier_answer_offers_neither_verb() {
	assert_eq!(labels(&menu(false, false)), ["Copy"]);
}

#[test]
fn a_prompt_offers_the_fork_and_neither_verb_even_as_the_last_turn() {
	assert_eq!(labels(&menu(true, true)), ["Copy", "Branch from here"]);
	assert_eq!(labels(&menu(true, false)), ["Copy", "Branch from here"]);
	assert_eq!(intents(&menu(true, true)), [
		Intent::CopyText("what was said".to_owned()),
		Intent::BranchTurn(3),
	]);
}

#[test]
fn both_verbs_are_typed_as_the_commands_the_terminal_spells_them() {
	let rows: Vec<(String, Intent)> = command_items()
		.into_iter()
		.filter_map(|item| match item.kind {
			PaletteItemKind::Command { intent } => Some((item.title, *intent)),
			_ => None,
		})
		.collect();
	assert!(
		rows.contains(&("/retry".to_owned(), Intent::RetryTurn)),
		"/retry is not a command row that runs the last turn again: {rows:?}"
	);
	assert!(
		rows.contains(&("/rephrase".to_owned(), Intent::RephraseReply)),
		"/rephrase is not a command row that asks for the reply again: {rows:?}"
	);
}

#[test]
fn both_verbs_address_the_open_session_and_nothing_when_none_is_open() {
	let (mut store, index) = open_session();
	let session = SessionId::from("s");
	assert_eq!(actions_for(&Intent::RetryTurn, &index, &mut store), [HostAction::RetryTurn {
		session: session.clone(),
	}]);
	assert_eq!(actions_for(&Intent::RephraseReply, &index, &mut store), [
		HostAction::RephraseReply { session }
	]);

	store.persisted.shell.active_session = None;
	assert!(
		actions_for(&Intent::RetryTurn, &index, &mut store).is_empty(),
		"a retry with no session open named a session anyway"
	);
	assert!(
		actions_for(&Intent::RephraseReply, &index, &mut store).is_empty(),
		"a rephrase with no session open named a session anyway"
	);
}
