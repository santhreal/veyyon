//! WHY THIS SUITE EXISTS.
//!
//! Every interaction in this window is a move over the store rather than a
//! socket call, so a defect here is invisible in a screenshot and invisible to
//! a type check: a conversation list nobody can select from, a composer that
//! takes characters and sends nothing, a title that never takes the name of
//! what was written, a palette whose cursor and whose accept read two different
//! lists.
//!
//! The class it closes is one shape: a move that reports success while leaving
//! the store where it was, or leaving it somewhere the window cannot draw
//! (nothing selected, a caret past the end of a draft, a palette cursor past
//! its last row).
//!
//! Each test drives the real move against a real opened store, in the order the
//! window calls them.
//!
//! WHAT IT DOES NOT CATCH. Anything about drawing: layout, colour, hit testing,
//! focus, or whether the element that calls a move is reachable with a pointer.
//! A move proved here and wired to nothing passes; the windowed suite in
//! `the_keyboard_reaches_every_route.rs` covers the wiring.

mod answering;
mod settings;
mod writing;

use super::{
	model::{Route, SESSION_TITLE_UNTITLED, SessionId, SettingsPage, Store},
	moves,
};

fn store() -> Store {
	Store::opened_in("checkout", "/repo/checkout")
}

/// Type into the selected conversation and send, the way the composer does.
fn type_and_send(store: &mut Store, text: &str) -> bool {
	moves::set_draft(store, text.to_owned(), text.len());
	moves::send(store)
}

// ---- what the window opens on ----

#[test]
fn the_window_opens_on_one_empty_conversation_in_the_directory_it_was_started_in() {
	let store = store();
	assert_eq!(store.projects.len(), 1, "the checkout the process was started in");
	assert_eq!(store.projects[0].name, "checkout");
	assert_eq!(store.projects[0].path, "/repo/checkout");
	assert_eq!(store.sessions.len(), 1, "one conversation to type into");
	assert_eq!(
		store.selected.as_ref(),
		Some(&store.sessions[0].id),
		"a window with nothing selected has a composer pointing at nothing"
	);
	assert_eq!(store.sessions[0].title, SESSION_TITLE_UNTITLED);
	assert!(store.sessions[0].messages.is_empty(), "no fixture transcript");
	assert_eq!(store.route, Route::Chat);
	assert!(!store.overlay.is_open());
	assert!(store.notice.is_none());
}

#[test]
fn every_conversation_belongs_to_a_project_the_store_can_name() {
	let mut store = store();
	moves::new_session(&mut store);
	for session in &store.sessions {
		assert!(
			store.project(&session.project).is_some(),
			"{} belongs to a checkout the sidebar cannot draw a heading for",
			session.id.as_str()
		);
	}
}

// ---- selection ----

#[test]
fn selecting_a_conversation_that_is_not_there_leaves_the_selection_alone() {
	let mut store = store();
	let was = store.selected.clone();
	moves::select(&mut store, &SessionId::new("nothing-like-this"));
	assert_eq!(store.selected, was, "the composer would point at nothing");
}

#[test]
fn selecting_leaves_settings_and_closes_the_palette() {
	let mut store = store();
	let first = store.sessions[0].id.clone();
	moves::open_settings(&mut store, SettingsPage::Keys);
	crate::palette::open(&mut store);
	moves::select(&mut store, &first);
	assert_eq!(store.route, Route::Chat, "a selection that lands behind settings is invisible");
	assert!(!store.overlay.is_open());
}

#[test]
fn cycling_walks_the_drawn_order_and_wraps_at_both_ends() {
	let mut store = store();
	moves::new_session(&mut store);
	moves::new_session(&mut store);
	let order = store.visible_order();
	assert_eq!(order.len(), 3);

	moves::select(&mut store, &order[0]);
	for step in 1..=order.len() {
		moves::cycle(&mut store, true);
		let expected = &order[step % order.len()];
		assert_eq!(store.selected.as_ref(), Some(expected), "forward step {step}");
	}
	for step in 1..=order.len() {
		moves::cycle(&mut store, false);
		let expected = &order[(order.len() - step) % order.len()];
		assert_eq!(store.selected.as_ref(), Some(expected), "backward step {step}");
	}
}

#[test]
fn the_drawn_order_is_the_order_the_keyboard_walks() {
	// The sidebar draws `rows` per project and the keyboard walks
	// `visible_order`. Two functions, one order, or an arrow key lands
	// somewhere the eye did not expect.
	let mut store = store();
	moves::new_session(&mut store);
	store.now_ms = 500;
	type_and_send(&mut store, "the newest thing said");

	let project = store.projects[0].id.clone();
	let drawn: Vec<SessionId> = store
		.rows(&project)
		.into_iter()
		.map(|session| session.id.clone())
		.collect();
	assert_eq!(drawn, store.visible_order());
	assert_eq!(
		drawn.first(),
		store.selected.as_ref(),
		"the conversation just written in is not at the top of the list"
	);
}

#[test]
fn a_folded_checkout_is_out_of_the_keyboards_reach() {
	let mut store = store();
	let project = store.projects[0].id.clone();
	moves::toggle_project(&mut store, &project);
	assert!(store.visible_order().is_empty(), "an arrow key would select an invisible row");
	moves::toggle_project(&mut store, &project);
	assert_eq!(store.visible_order().len(), 1);
}

// ---- new conversations, and deleting them ----

#[test]
fn a_new_conversation_is_selected_empty_and_named_untitled() {
	let mut store = store();
	let before = store.sessions.len();
	let id = moves::new_session(&mut store);
	assert_eq!(store.sessions.len(), before + 1);
	assert_eq!(store.selected.as_ref(), Some(&id));
	let session = store.selected_session().unwrap();
	assert_eq!(session.title, SESSION_TITLE_UNTITLED);
	assert!(session.messages.is_empty());
	assert!(session.draft.is_empty());
}

#[test]
fn two_new_conversations_never_share_an_id() {
	let mut store = store();
	let mut ids = vec![store.sessions[0].id.clone()];
	for _ in 0..8 {
		ids.push(moves::new_session(&mut store));
	}
	let count = ids.len();
	ids.sort();
	ids.dedup();
	assert_eq!(ids.len(), count, "two rows with one id are one row as far as a click is concerned");
}

#[test]
fn deleting_moves_the_selection_to_a_conversation_that_is_still_there() {
	let mut store = store();
	let first = store.sessions[0].id.clone();
	let second = moves::new_session(&mut store);
	moves::delete_session(&mut store, &second);

	assert!(store.session(&second).is_none());
	assert_eq!(store.selected.as_ref(), Some(&first));
	assert!(store.notice.is_some(), "a deletion that says nothing looks like a bug");
}

#[test]
fn deleting_something_else_leaves_the_selection_where_it_was() {
	let mut store = store();
	let first = store.sessions[0].id.clone();
	let second = moves::new_session(&mut store);
	moves::delete_session(&mut store, &first);
	assert_eq!(
		store.selected.as_ref(),
		Some(&second),
		"the selection followed a deletion of another row"
	);
}

#[test]
fn the_last_conversation_cannot_be_deleted() {
	// An empty list leaves the composer pointing at nothing, which takes a
	// keystroke and drops it.
	let mut store = store();
	let only = store.sessions[0].id.clone();
	moves::delete_session(&mut store, &only);
	assert_eq!(store.sessions.len(), 1);
	assert_eq!(store.selected.as_ref(), Some(&only));
	assert!(store.notice.is_none(), "nothing happened, so nothing is announced");
}

// ---- the notice line ----
