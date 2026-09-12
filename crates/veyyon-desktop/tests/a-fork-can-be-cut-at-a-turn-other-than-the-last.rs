//! WHY: the host forks at any entry the desktop names, and the desktop could
//! name exactly one: the last prompt on the branch. A transcript read back
//! ten turns and forked from the turn the operator was looking at was not
//! reachable, so taking a different road from an earlier prompt meant copying
//! its words out of the window and opening a session that shared none of its
//! history. The turn menu names its own turn, and this is the reading that
//! turns that turn into an entry and a prompt.
//!
//! CLASS CLOSED: a fork cut somewhere other than the turn it was asked for.
//! Every turn of a seeded transcript is asked for in turn, swept from the
//! projection at run time rather than listed here, and each is pinned to the
//! entry that turn holds by exact equality -- so a reading that answers with
//! the transcript's end, with the first prompt, or with the entry next to the
//! right one turns this red at every index but the one it happens to match.
//! Beside them the turns a fork cannot be cut at, each of which asks for
//! nothing rather than forking somewhere arbitrary: an agent's reply, an index
//! past the end, a session the window holds no transcript for, and a window
//! with no session open at all.
//!
//! The prompt the fork hands back is read in the same sweep, because the two
//! are one decision: the words kept for the composer are the words of the
//! entry that was named, and a row fork and a turn fork of the same session
//! hand back different prompts.
//!
//! NOT CAUGHT: that the host forks where it was told, which is
//! `a-branch-forks-at-the-entry-the-desktop-named.test.ts` driving the real
//! handler; the menu that offers the row, which is the surface crate's
//! `a-fork-is-offered-at-the-turn-that-can-carry-one.rs`; and the keeper's
//! restore of the handed-back draft, which is
//! `a-branched-prompt-survives-the-session-the-fork-opened.rs`.

mod support;

use support::{entry, session};
use veyyon_desktop::{
	SessionIndex, actions_for,
	project::{branch_point, branched_draft, land_branched_draft},
};
use veyyon_desktop_model::{
	ContentBlock, EntryId, HostAction, MessageRole, QueuePartition, SessionId, Store, SurfaceId,
};
use veyyon_desktop_surface::Intent;

/// The prompts the seeded session holds, oldest first, each answered.
const PROMPTS: [&str; 3] = ["what does this crate do", "read the file first", "now change it"];

/// The entry each prompt was recorded under, index-aligned with `PROMPTS`.
const PROMPT_ENTRIES: [&str; 3] = ["e1", "e3", "e5"];

/// A session of three prompts, each with a reply after it, so the turns
/// alternate and every index means something different.
fn seeded(store: &mut Store, id: &str) -> SessionId {
	let session_id = SessionId::from(id);
	store.sessions.insert(session(id, QueuePartition::Live));
	store.persisted.shell.active_session = Some(session_id.clone());
	let tree = store.transcripts.entry(session_id.clone()).or_default();
	let mut parent: Option<String> = None;
	for (index, prompt) in PROMPTS.iter().enumerate() {
		let prompt_id = PROMPT_ENTRIES[index].to_string();
		let reply_id = format!("r{index}");
		tree.append(entry(&prompt_id, parent.as_deref(), MessageRole::User, vec![
			ContentBlock::Text { text: (*prompt).to_string() },
		]));
		tree.append(entry(&reply_id, Some(&prompt_id), MessageRole::Assistant, vec![
			ContentBlock::Text { text: format!("answering {prompt}") },
		]));
		parent = Some(reply_id);
	}
	session_id
}

/// The turn index each prompt is drawn at: a prompt, then the reply merged
/// into one agent turn, so the prompts sit on the even indices.
const fn prompt_turn(index: usize) -> usize {
	index * 2
}

/// The branch control the row's requests register under, which is the row and
/// not the session (§4.3).
fn branch_surface(row: u64) -> SurfaceId {
	SurfaceId::SessionBranchButton(SessionId::from(row.to_string()))
}

#[test]
fn a_fork_is_cut_at_the_entry_the_pressed_turn_holds() {
	for (index, prompt) in PROMPTS.iter().enumerate() {
		let mut store = Store::new();
		let session_id = seeded(&mut store, "sess-1");
		let mut index_map = SessionIndex::new();
		let row = index_map.row_of(&session_id);

		assert_eq!(
			actions_for(&Intent::BranchTurn(prompt_turn(index)), &index_map, &mut store),
			vec![HostAction::BranchSession {
				session: session_id.clone(),
				entry:   Some(EntryId::from(PROMPT_ENTRIES[index])),
			}],
			"a fork at turn {} names the entry that turn holds",
			prompt_turn(index)
		);
		assert_eq!(
			branched_draft(&store, &branch_surface(row)).map(String::as_str),
			Some(*prompt),
			"and keeps that entry's own prompt for the composer"
		);
	}
}

/// The defect itself: the rail's fork and the turn's fork of one session cut
/// at different entries, and only the rail's could be asked for.
#[test]
fn a_turn_fork_and_a_row_fork_of_one_session_cut_at_different_entries() {
	let mut store = Store::new();
	let session_id = seeded(&mut store, "sess-1");
	let mut index_map = SessionIndex::new();
	let row = index_map.row_of(&session_id);

	let last = branch_point(&store, &session_id).expect("a prompt to fork at");
	assert_eq!(
		(last.entry, last.prompt.as_str()),
		(EntryId::from("e5"), PROMPTS[2]),
		"the row's fork cuts at the transcript's last prompt"
	);

	assert_eq!(
		actions_for(&Intent::BranchTurn(prompt_turn(0)), &index_map, &mut store),
		vec![HostAction::BranchSession { session: session_id, entry: Some(EntryId::from("e1")) }],
		"the first turn's fork cuts at the first prompt, which no row fork can name"
	);
	assert_eq!(
		land_branched_draft(&mut store, &branch_surface(row), false).as_deref(),
		Some(PROMPTS[0]),
		"and the words handed back are that prompt's, not the transcript's last"
	);
	assert_eq!(
		branched_draft(&store, &branch_surface(row)),
		None,
		"a landed fork is handed back once, so the next settled request writes nothing"
	);
}

#[test]
fn a_turn_no_fork_can_be_cut_at_asks_for_nothing() {
	let mut store = Store::new();
	let session_id = seeded(&mut store, "sess-1");
	let mut index_map = SessionIndex::new();
	let row = index_map.row_of(&session_id);
	let turns = 2 * PROMPTS.len();

	// An agent turn sits between two prompts, and the index past the end is a
	// turn the transcript never drew.
	for turn in [1, 3, turns, turns + 7] {
		assert_eq!(
			actions_for(&Intent::BranchTurn(turn), &index_map, &mut store),
			Vec::new(),
			"turn {turn} is no prompt, so nothing is sent rather than a fork at the end"
		);
		assert_eq!(
			branched_draft(&store, &branch_surface(row)),
			None,
			"and no prompt is kept for turn {turn}"
		);
	}
}

#[test]
fn a_session_the_window_holds_no_transcript_for_forks_at_no_turn() {
	let mut store = Store::new();
	let session_id = SessionId::from("sess-2");
	store
		.sessions
		.insert(session("sess-2", QueuePartition::Live));
	store.persisted.shell.active_session = Some(session_id.clone());
	let mut index_map = SessionIndex::new();
	let row = index_map.row_of(&session_id);

	assert_eq!(
		actions_for(&Intent::BranchTurn(0), &index_map, &mut store),
		Vec::new(),
		"a transcript the window never loaded has no turn to name an entry from"
	);
	assert_eq!(branched_draft(&store, &branch_surface(row)), None, "and hands nothing back");
}

#[test]
fn a_window_with_no_session_open_forks_nothing() {
	let mut store = Store::new();
	seeded(&mut store, "sess-1");
	store.persisted.shell.active_session = None;
	let index_map = SessionIndex::new();

	assert_eq!(
		actions_for(&Intent::BranchTurn(0), &index_map, &mut store),
		Vec::new(),
		"a turn of no open session is a fork of nothing"
	);
	assert!(store.forks.is_empty(), "and nothing is kept for a fork that was never asked for");
}
