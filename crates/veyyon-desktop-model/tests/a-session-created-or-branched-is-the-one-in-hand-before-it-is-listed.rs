//! WHY: creating a session, opening one and branching one all arrive in the
//! same order from the host: the header of the session it is now on, the
//! transcript belonging to it, then the whole index again. The index is the
//! only authority on which sessions exist, so the header of a session no
//! listing has named yet reaches the store before any row for it does, and the
//! transcript is filed under it before the row arrives. A reducer that took
//! the index as the authority on what may be addressed would leave a created
//! or branched session unreachable: no active pointer, or a transcript
//! dropped by the listing that was supposed to reveal the row.
//!
//! CLASS CLOSED: an ordering of those three sections, for any of the three
//! workflows, that leaves the window on a session other than the one the host
//! reports, or that loses the transcript of the session it is on. Driven
//! through `reduce` with the host's own sections in the order
//! `emitActiveSessionAndTranscript` then `emitSessionList` sends them
//! (`packages/coding-agent/src/gui-host/actions/sessions.ts`). Held shut
//! against:
//!
//! 1. A header for an unlisted session that is refused, so a created session is
//!    never the one in hand.
//! 2. A header for an unlisted session that invents a row, so the rail draws a
//!    session with no workspace and no clock until the listing corrects it.
//! 3. A listing that clears the transcript of a session it has just revealed,
//!    which is the transcript of every session the operator creates, opens or
//!    branches.
//! 4. A branch whose transcript is filed under its parent, or which replaces
//!    the parent's own transcript.
//! 5. A reopen that adds the entries to the copy already held, so a session
//!    trimmed by a compaction, a branch or a rewind still shows the turns the
//!    host dropped.
//!
//! NOT CAUGHT: the host-side ordering itself, which
//! `a-transcript-arrives-behind-the-header-that-says-whose-it-is.test.ts`
//! owns; what the rail draws for a session held with no row, which is the
//! surface's projection; and the intent-to-action direction, which
//! `an-intent-maps-to-the-actions-the-host-answers.rs` owns.

mod support;

use veyyon_desktop_model::{
	ContentBlock, Damage, EntryId, HostEvent, MessageRole, SessionId, SessionStatus,
	SnapshotSection, Store, TranscriptEntry, Versioned, reduce,
};

use crate::support::{NOW_MS, WROTE_MS, session_id, summary};

/// The session a branch of the fixture's session is written to.
fn branch_id() -> SessionId {
	SessionId::from("session_0001_branch")
}

/// Reduces a listing of exactly the sessions named.
fn list_ids(store: &mut Store, ids: &[SessionId]) {
	let value = ids
		.iter()
		.map(|id| {
			let mut row = summary(SessionStatus::Complete, WROTE_MS);
			row.id = id.clone();
			row
		})
		.collect();
	reduce(
		store,
		HostEvent::Snapshot(SnapshotSection::Sessions(Versioned { revision: 9, value }, Vec::new())),
	);
}

/// Reduces the header the host states for `id` before anything belonging to it.
fn header(store: &mut Store, id: &SessionId) -> veyyon_desktop_model::DamageSet {
	reduce(
		store,
		HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
			revision: 2,
			value:    veyyon_desktop_model::SessionHeaderView {
				id:             id.clone(),
				schema_version: 1,
				title:          Some("Rewrite the walker cache".to_string()),
				title_source:   None,
				parent:         None,
				created_at_ms:  NOW_MS - 600_000,
				cwd:            "/repo".to_string(),
				mode:           None,
			},
		})),
	)
}

/// One entry of the session the store is on, named so the text it carries
/// says which transcript it came from.
fn entry(text: &str) -> TranscriptEntry {
	TranscriptEntry {
		id:                EntryId::from(text),
		parent:            None,
		revision:          1,
		timestamp_ms:      NOW_MS,
		role:              MessageRole::User,
		content:           vec![ContentBlock::Text { text: text.to_string() }],
		meta:              None,
		raw_discriminator: "User".to_string(),
		raw:               serde_json::Value::Null,
	}
}

/// Reduces a transcript of `texts` for whichever session the store is on.
fn transcript(store: &mut Store, texts: &[&str]) {
	reduce(
		store,
		HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
			revision: 10,
			value:    texts.iter().map(|text| entry(text)).collect(),
		})),
	);
}

/// The text of every entry held for `id`, in the order the tree roots them.
fn texts_held_for(store: &Store, id: &SessionId) -> Vec<String> {
	let Some(tree) = store.transcripts.get(id) else {
		return Vec::new();
	};
	tree
		.root_entries
		.iter()
		.filter_map(|entry_id| tree.get(entry_id))
		.flat_map(|held| held.content.iter())
		.filter_map(|block| match block {
			ContentBlock::Text { text } => Some(text.clone()),
			_ => None,
		})
		.collect()
}

#[test]
fn a_header_for_a_session_no_listing_names_selects_it_and_draws_no_row() {
	let mut store = Store::new();
	list_ids(&mut store, &[session_id()]);

	let damage = header(&mut store, &branch_id());

	assert_eq!(
		store.persisted.shell.active_session.as_ref(),
		Some(&branch_id()),
		"the window is not on the session the host says it is on, so a created or branched session \
		 is unreachable until the next listing"
	);
	assert!(
		store.sessions.get(&branch_id()).is_none(),
		"the header invented a row the index never listed, and the index is the only authority on \
		 which sessions exist"
	);
	assert_eq!(store.sessions.items.len(), 1, "the listed session's row was disturbed");
	assert!(
		damage.contains(&Damage::Composer(branch_id())),
		"the composer was not told to redraw for the session it now sends to"
	);
	assert!(damage.contains(&Damage::Titlebar), "the titlebar still names the previous session");
}

#[test]
fn the_listing_that_follows_a_creation_keeps_the_transcript_that_came_before_it() {
	let mut store = Store::new();
	list_ids(&mut store, &[session_id()]);

	header(&mut store, &branch_id());
	transcript(&mut store, &["the branch's first turn"]);
	list_ids(&mut store, &[session_id(), branch_id()]);

	assert!(
		store.sessions.get(&branch_id()).is_some(),
		"the listing that reveals a created session drew no row for it"
	);
	assert_eq!(
		store.persisted.shell.active_session.as_ref(),
		Some(&branch_id()),
		"the listing moved the window off the session the host is on"
	);
	assert_eq!(
		texts_held_for(&store, &branch_id()),
		vec!["the branch's first turn".to_string()],
		"the listing that revealed the row dropped the transcript that arrived before it"
	);
}

#[test]
fn a_branch_is_the_session_in_hand_and_its_parent_transcript_is_left_alone() {
	let mut store = Store::new();
	list_ids(&mut store, &[session_id()]);
	header(&mut store, &session_id());
	transcript(&mut store, &["the parent's turn", "the parent's answer"]);

	header(&mut store, &branch_id());
	transcript(&mut store, &["the parent's turn", "the branch's answer"]);
	list_ids(&mut store, &[session_id(), branch_id()]);

	assert_eq!(
		store.persisted.shell.active_session.as_ref(),
		Some(&branch_id()),
		"the window stayed on the parent after the host branched it"
	);
	assert_eq!(
		texts_held_for(&store, &session_id()),
		vec!["the parent's turn".to_string(), "the parent's answer".to_string()],
		"the branch's transcript was filed over its parent's"
	);
	assert_eq!(
		texts_held_for(&store, &branch_id()),
		vec!["the parent's turn".to_string(), "the branch's answer".to_string()],
		"the branch holds a transcript other than the one the host sent for it"
	);
}

#[test]
fn reopening_a_session_holds_exactly_the_entries_the_host_last_sent() {
	let mut store = Store::new();
	list_ids(&mut store, &[session_id(), branch_id()]);
	header(&mut store, &session_id());
	transcript(&mut store, &["the parent's turn", "the turn a compaction folded away"]);
	header(&mut store, &branch_id());
	transcript(&mut store, &["the branch's answer"]);

	// A reopen after a compaction, a branch or a rewind sends fewer entries
	// than the copy already held, so a tree that took the section as an
	// addition still shows what the host dropped. Entries are keyed by id, so
	// this is the only way the difference is observable.
	header(&mut store, &session_id());
	transcript(&mut store, &["the parent's turn"]);

	assert_eq!(
		texts_held_for(&store, &session_id()),
		vec!["the parent's turn".to_string()],
		"reopening a session left an entry the host no longer sends in its transcript"
	);
	assert_eq!(
		texts_held_for(&store, &branch_id()),
		vec!["the branch's answer".to_string()],
		"reopening one session disturbed the transcript held for another"
	);
}

#[test]
fn a_transcript_the_host_sends_before_any_header_reaches_no_listed_session() {
	let mut store = Store::new();
	list_ids(&mut store, &[session_id(), branch_id()]);

	transcript(&mut store, &["entries belonging to nothing named"]);

	assert!(
		texts_held_for(&store, &session_id()).is_empty(),
		"a transcript with no header in front of it was filed under a listed session"
	);
	assert!(
		texts_held_for(&store, &branch_id()).is_empty(),
		"a transcript with no header in front of it was filed under a listed session"
	);
}
