//! WHY: the prompt a branch hands back was written straight into the editor
//! on the settled request, and the next keeper sync drew over it. A fork moves
//! the session pointer, and the keeper records the drawn window's shape as the
//! OUTGOING session's before restoring the incoming one's, so the words landed
//! twice wrong at once: recorded as an unsent draft against the session the
//! fork was cut from, which lifts that row into `Unsent`, and then replaced in
//! the composer by the fork's own empty draft. The window came back from a
//! branch with nothing in it, which is the defect
//! `a-branch-forks-at-the-prompt-it-hands-back.rs` could not see, because it
//! reads the prompt out of the store and never drives a window.
//!
//! CLASS CLOSED: a draft the window puts in front of the operator from outside
//! the composer's own typing, landing under the wrong session or being drawn
//! over by the restore that follows it. Both arms of `land_branched_draft` are
//! driven here against a real window and a real keeper -- the remembered one,
//! where the keeper's restore is the mechanism, and the unremembered one,
//! where the caller is handed the words because no restore will run -- and
//! each is read on both sessions, so a prompt that lands on the source turns
//! this red as surely as one that lands nowhere.
//!
//! NOT CAUGHT: which entry the fork cut, and which prompt belongs to it, which
//! is the suite named above; the host's own fork, which is proved by the
//! gui-host suite of the same name; and the one line of `host_view.rs` that
//! calls `land_branched_draft` on a settled request, which no in-process test
//! reaches and which `proof/scenes/desktop-branch-draft.sh` reads out of the
//! live window.

mod support;

use support::{
	entry,
	memory::{FIRST, SECOND, driven, keeper_over, store_on},
	session,
};
use veyyon_desktop::{SessionIndex, actions_for, project::land_branched_draft};
use veyyon_desktop_model::{
	ContentBlock, HostAction, MessageRole, QueuePartition, SessionId, Store, SurfaceId,
};
use veyyon_desktop_surface::Intent;

/// The prompt the fork cuts off the transcript it forks.
const PROMPT: &str = "read the file first, then change it";

/// A store on `FIRST`, holding one prompt of the operator's, with `SECOND`
/// listed beside it as the session a fork of it opens under.
fn forked_store() -> (Store, SessionIndex, u64) {
	let mut store = store_on(FIRST);
	let source = SessionId::from(FIRST);
	store.sessions.insert(session(FIRST, QueuePartition::Live));
	store.sessions.insert(session(SECOND, QueuePartition::Live));
	let tree = store.transcripts.entry(source.clone()).or_default();
	tree.append(entry("e1", None, MessageRole::User, vec![ContentBlock::Text {
		text: PROMPT.to_string(),
	}]));
	let mut index = SessionIndex::new();
	let row = index.row_of(&source);
	index.row_of(&SessionId::from(SECOND));
	// The fork is asked for on the row the operator pressed, which is what
	// records the prompt it cuts. The request settles later, by which time the
	// fork's own header and transcript have reached the store and the pointer
	// is already on the session the fork opened.
	assert!(
		matches!(actions_for(&Intent::BranchSession(row), &index, &mut store).as_slice(), [
			HostAction::BranchSession { entry: Some(_), .. }
		]),
		"the fork names the prompt it cuts"
	);
	store.persisted.shell.active_session = Some(SessionId::from(SECOND));
	(store, index, row)
}

/// The draft each session is remembered as holding.
fn drafts(store: &Store) -> (String, String) {
	let read = |id: &str| {
		store
			.persisted
			.composer
			.get(&SessionId::from(id))
			.map(|entry| entry.draft_text.clone())
			.unwrap_or_default()
	};
	(read(FIRST), read(SECOND))
}

#[test]
fn a_window_that_remembers_a_draft_opens_the_fork_holding_the_prompt() {
	let (_tree, dir) = support::memory::state_dir("gui-branch-draft-remembered");
	driven(support::memory::seeded(), |window| {
		let (mut store, _index, row) = forked_store();
		let mut keeper = keeper_over(&dir);
		let branch = SurfaceId::SessionBranchButton(SessionId::from(row.to_string()));

		let handed = window
			.update(|view, win, cx| {
				// The window is on the source until the first sync adopts it,
				// which is the state the request was sent in.
				store.persisted.shell.active_session = Some(SessionId::from(FIRST));
				keeper.sync(view, &mut store, win, 0, cx);
				store.persisted.shell.active_session = Some(SessionId::from(SECOND));
				land_branched_draft(&mut store, &branch, true)
			})
			.expect("the settled branch is landed");
		assert_eq!(
			handed, None,
			"a window that remembers a draft is handed nothing to put in the editor itself"
		);

		let (source_draft, fork_draft) = drafts(&store);
		assert_eq!(fork_draft, PROMPT, "the fork is remembered as holding the prompt it cut");
		assert_eq!(
			source_draft, "",
			"the session the fork was cut from holds no unsent draft it never had"
		);

		let drawn = window
			.update(|view, win, cx| {
				keeper.sync(view, &mut store, win, 1, cx);
				view.composer_text().to_string()
			})
			.expect("the sync that opens the fork restores its draft");
		assert_eq!(
			drawn, PROMPT,
			"the composer the fork opened holds the prompt the fork cut, not an empty draft"
		);

		// The prompt is now the fork's own draft, so recording the drawn window
		// keeps it there rather than writing it back onto the source.
		window
			.update(|view, win, cx| keeper.sync(view, &mut store, win, 2, cx))
			.expect("the fork's own shape is recorded under its own key");
		let (source_after, fork_after) = drafts(&store);
		assert_eq!(fork_after, PROMPT, "the fork keeps the draft it opened holding");
		assert_eq!(source_after, "", "and the source still holds none");
	});
}

#[test]
fn a_window_that_remembers_nothing_is_handed_the_prompt_to_draw_itself() {
	let (mut store, _index, row) = forked_store();
	let branch = SurfaceId::SessionBranchButton(SessionId::from(row.to_string()));

	let handed = land_branched_draft(&mut store, &branch, false);
	assert_eq!(
		handed.as_deref(),
		Some(PROMPT),
		"with no keeper to restore it, the prompt is handed back for the editor"
	);
	assert_eq!(
		drafts(&store),
		(String::new(), String::new()),
		"and nothing is remembered against either session, because nothing is remembered at all"
	);
}

#[test]
fn a_settled_request_that_is_no_branch_leaves_every_draft_alone() {
	let (mut store, _index, row) = forked_store();
	let sid = SessionId::from(row.to_string());

	for surface in [
		SurfaceId::QueueSessionRow(sid.clone()),
		SurfaceId::SessionExportButton(sid.clone()),
		SurfaceId::SessionCompactButton(sid.clone()),
		SurfaceId::ComposerSendButton(sid),
	] {
		assert_eq!(
			land_branched_draft(&mut store, &surface, true),
			None,
			"{surface:?} is no branch and hands nothing back"
		);
		assert_eq!(
			drafts(&store),
			(String::new(), String::new()),
			"{surface:?} wrote a draft it had no prompt for"
		);
	}
}
