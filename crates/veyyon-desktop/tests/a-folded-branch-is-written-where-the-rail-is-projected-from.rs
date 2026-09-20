//! WHY THIS SUITE EXISTS
//!
//! Folding a branch in the queue rail used to write into the rail's own
//! motion, beside the frame on screen. The rows the rail lists are projected
//! from the store on every host event, so the next event rebuilt the rows
//! from a store that had never heard of the fold and the branch sprang open
//! under the operator's cursor. The fold has to land where the projection
//! reads it.
//!
//! THE CLASS THIS CLOSES: a window-local record of something the projection
//! decides. Held shut against:
//!
//! 1. The fold being sent to the host as an action, which it is not: the host
//!    lists sessions and has no opinion about which branches this window drew
//!    folded.
//! 2. The fold landing outside the active space, so folding a branch in one
//!    space folds it in another.
//! 3. A fold that cannot be undone, or one that is dropped because the host has
//!    not listed that path in this window's lifetime.
//!
//! WHAT IT DOES NOT CATCH: which rows the fold then hides, owned by
//! `crates/veyyon-desktop-surface/tests/
//! the-queue-rail-draws-branch-hierarchies-as-an-indented-collapsible-tree.rs`,
//! and the write to disk, owned by
//! `crates/veyyon-desktop/tests/
//! the-shape-a-window-was-left-in-comes-back-when-it-opens.rs`.

mod support;

use support::session;
use veyyon_desktop::{SessionIndex, actions_for};
use veyyon_desktop_model::{QueuePartition, SessionId, Store};
use veyyon_desktop_surface::Intent;

fn seeded() -> (Store, SessionIndex) {
	let mut store = Store::new();
	let id = SessionId::from("s1");
	store.sessions.insert(session("s1", QueuePartition::Live));
	store.persisted.shell.active_session = Some(id.clone());
	let mut index = SessionIndex::new();
	let _ = index.row_of(&id);
	(store, index)
}

fn folds(store: &Store) -> Vec<String> {
	store
		.persisted
		.shell
		.navigation
		.active()
		.queue
		.collapsed_parents
		.iter()
		.cloned()
		.collect()
}

fn fold(store: &mut Store, index: &SessionIndex, path: &str) {
	let actions = actions_for(&Intent::ToggleQueueParent(path.to_string()), index, store);
	assert!(
		actions.is_empty(),
		"a fold is this window's own record, not something the host is told: {actions:?}"
	);
}

#[test]
fn a_fold_is_written_into_the_navigation_the_rail_is_projected_from() {
	let (mut store, index) = seeded();
	assert_eq!(folds(&store), Vec::<String>::new(), "a window opens with nothing folded");

	fold(&mut store, &index, "/sessions/root");
	assert_eq!(folds(&store), vec!["/sessions/root".to_string()]);

	fold(&mut store, &index, "/sessions/other");
	assert_eq!(folds(&store), vec!["/sessions/other".to_string(), "/sessions/root".to_string()]);
}

#[test]
fn folding_the_same_branch_again_unfolds_it() {
	let (mut store, index) = seeded();
	fold(&mut store, &index, "/sessions/root");
	fold(&mut store, &index, "/sessions/root");
	assert_eq!(
		folds(&store),
		Vec::<String>::new(),
		"the chevron is a toggle, so the second click puts the branch back"
	);
}

#[test]
fn a_path_the_host_has_not_listed_is_still_recorded() {
	// The rail is projected from whatever the host last sent, and a session
	// the host has not listed yet has no row. Recording the fold anyway is
	// what brings the branch back folded when that session arrives.
	let (mut store, index) = seeded();
	fold(&mut store, &index, "/sessions/never-listed");
	assert_eq!(folds(&store), vec!["/sessions/never-listed".to_string()]);
}

#[test]
fn a_fold_belongs_to_the_space_it_was_made_in() {
	let (mut store, index) = seeded();
	fold(&mut store, &index, "/sessions/root");
	let second = store
		.persisted
		.shell
		.navigation
		.create("Research")
		.expect("a second space is created");
	assert!(store.persisted.shell.navigation.switch(second), "the window switches to it");
	assert_eq!(folds(&store), Vec::<String>::new(), "the new space opens with nothing folded");

	fold(&mut store, &index, "/sessions/elsewhere");
	assert_eq!(folds(&store), vec!["/sessions/elsewhere".to_string()]);

	let first = store
		.persisted
		.shell
		.navigation
		.spaces()
		.map(|space| space.id)
		.find(|id| *id != second)
		.expect("the space the window started in is still listed");
	assert!(store.persisted.shell.navigation.switch(first), "the window switches back");
	assert_eq!(
		folds(&store),
		vec!["/sessions/root".to_string()],
		"each space keeps the branches it was left folded at"
	);
}
