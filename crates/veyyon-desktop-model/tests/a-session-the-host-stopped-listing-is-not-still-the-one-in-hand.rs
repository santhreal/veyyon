//! WHY: the window addresses a session by the id it holds in
//! `persisted.shell.active_session`, and every section that carries no session
//! of its own is filed under it — the transcript above all, which the protocol
//! sends as a bare list of entries. Deleting the open session dropped its row
//! and left that pointer naming it, so the next prompt was submitted to a
//! session the host had erased and the next transcript was filed under a row
//! nothing drew.
//!
//! CLASS CLOSED: a listing that stops naming a session, whatever else it
//! changes and whichever session was open, leaves nothing behind that
//! addresses it: no row, no transcript, and not the active pointer. Driven
//! through `reduce` with the host's own sections. Held shut against:
//!
//! 1. A delete of the open session that keeps the pointer, so the next
//!    transcript is filed under the erased id.
//! 2. A delete of the open session that keeps its transcript, so the entries
//!    are served again when the id is reused.
//! 3. A delete of another session that clears the pointer, which would close
//!    the session the operator is reading.
//! 4. An empty listing that leaves either behind.
//!
//! NOT CAUGHT: what the window draws once the pointer is empty, which is the
//! surface's own shell state; and the host-side ordering that puts a header in
//! front of a transcript, which
//! `a-transcript-arrives-behind-the-header-that-says-whose-it-is.test.ts`
//! owns.

mod support;

use veyyon_desktop_model::{
	HostEvent, SessionId, SessionStatus, SnapshotSection, Store, Versioned, reduce,
};

use crate::support::{NOW_MS, WROTE_MS, open, session_id, summary, user_entry};

/// A second session the host lists beside the one the fixtures name.
fn other_id() -> SessionId {
	SessionId::from("session_0002")
}

/// Reduces a listing of exactly the sessions named, at one status.
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

/// Files one transcript entry under whichever session is open.
fn transcript(store: &mut Store) {
	reduce(
		store,
		HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
			revision: 10,
			value:    vec![user_entry(NOW_MS)],
		})),
	);
}

/// A store holding two listed sessions, the first of them open and read.
fn two_listed_with_the_first_open() -> Store {
	let mut store = Store::new();
	list_ids(&mut store, &[session_id(), other_id()]);
	open(&mut store);
	transcript(&mut store);
	assert_eq!(
		store.persisted.shell.active_session.as_ref(),
		Some(&session_id()),
		"the fixture did not open the session it names"
	);
	assert_eq!(
		store.transcripts.get(&session_id()).map(|tree| tree.len()),
		Some(1),
		"the fixture filed no transcript under the open session"
	);
	store
}

#[test]
fn a_listing_that_drops_the_open_session_leaves_nothing_addressing_it() {
	let mut store = two_listed_with_the_first_open();

	list_ids(&mut store, &[other_id()]);

	assert!(
		store.sessions.get(&session_id()).is_none(),
		"the row of a session the host no longer lists is still held"
	);
	assert!(
		store.transcripts.get(&session_id()).is_none(),
		"the transcript of a deleted session is still held, and is served again if its id returns"
	);
	assert_eq!(
		store.persisted.shell.active_session, None,
		"the window still addresses the session the host erased"
	);
}

#[test]
fn a_transcript_after_the_open_session_was_dropped_is_not_filed_under_it() {
	let mut store = two_listed_with_the_first_open();
	list_ids(&mut store, &[other_id()]);

	transcript(&mut store);

	assert!(
		store.transcripts.get(&session_id()).is_none(),
		"entries were filed under the id the host erased"
	);
	assert!(
		store.transcripts.get(&other_id()).is_none(),
		"entries were filed under a session no header named"
	);
}

#[test]
fn a_listing_that_drops_another_session_keeps_the_one_in_hand() {
	let mut store = two_listed_with_the_first_open();

	list_ids(&mut store, &[session_id()]);

	assert!(
		store.sessions.get(&other_id()).is_none(),
		"the row of the dropped session is still held"
	);
	assert_eq!(
		store.persisted.shell.active_session.as_ref(),
		Some(&session_id()),
		"dropping another session closed the one the operator is reading"
	);
	assert_eq!(
		store.transcripts.get(&session_id()).map(|tree| tree.len()),
		Some(1),
		"dropping another session took the open session's transcript with it"
	);
}

#[test]
fn a_host_that_lists_nothing_leaves_no_session_in_hand() {
	let mut store = two_listed_with_the_first_open();

	list_ids(&mut store, &[]);

	assert!(store.sessions.items.is_empty(), "a row survived an empty listing");
	assert!(store.transcripts.is_empty(), "a transcript survived an empty listing");
	assert_eq!(
		store.persisted.shell.active_session, None,
		"the window still addresses a session after the host listed none"
	);
}

#[test]
fn a_re_listing_that_changes_nothing_keeps_the_session_in_hand() {
	let mut store = two_listed_with_the_first_open();

	list_ids(&mut store, &[session_id(), other_id()]);

	assert_eq!(
		store.persisted.shell.active_session.as_ref(),
		Some(&session_id()),
		"a re-listing of the same sessions closed the open one"
	);
	assert_eq!(
		store.transcripts.get(&session_id()).map(|tree| tree.len()),
		Some(1),
		"a re-listing of the same sessions dropped the open transcript"
	);
}
