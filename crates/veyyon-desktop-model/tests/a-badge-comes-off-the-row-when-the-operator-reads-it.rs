//! WHY: two of §0's badge conditions say `has not been read`, and nothing in
//! the protocol reports what the operator has read. Without that state the
//! client has two failures to choose between: raise `Done` on every finished
//! session the host lists, which is every session on disk at attach, or raise
//! it on none, which is what the product did. The client owns the read mark,
//! and the reducer moves it.
//!
//! CLASS CLOSED: a badge that outlives the operator reading it, and a badge
//! that fires on a listing the operator has already seen. Every status the
//! host can report is swept from `SessionStatus::iter()` through a first
//! listing, so a seventh status fails here until it has a decision, and the
//! two paths that mark a session read — a listing while it is open and the
//! header sent when it is opened — are each driven through `reduce`.
//!
//! It also pins the ordering rule the new fields could break: `status` and
//! `modified_at_ms` are taken from every re-listing, and §5.2 re-anchors the
//! Live partition on unpark, recall and pin alone, so a turn finishing must
//! not move the row.
//!
//! NOT CAUGHT: a read mark that does not survive a restart. Nothing about the
//! client's queue state is persisted today — the partition an operator parks a
//! session into is lost with the window — so a badge raised before a restart
//! is raised again after it.

mod support;

use std::collections::HashMap;

use strum::IntoEnumIterator as _;
use veyyon_desktop_model::{SessionBadge, SessionId, SessionStatus, Store, session_badge};

use crate::support::{NOW_MS, WROTE_MS, list, open, session_id};

#[test]
fn the_first_listing_of_a_finished_session_raises_no_attention() {
	let mut store = Store::new();
	for status in SessionStatus::iter() {
		store.sessions.remove(&session_id());
		list(&mut store, status, WROTE_MS);
		let derived = session_badge(&store, &session_id(), NOW_MS);
		let expected = match status {
			SessionStatus::Pending => Some(SessionBadge::Working { started_at_ms: WROTE_MS }),
			_ => None,
		};
		assert_eq!(derived, expected, "first listing of {status:?}");
	}
}

#[test]
fn a_turn_that_finished_while_the_operator_was_elsewhere_is_read_by_opening_it() {
	let mut store = Store::new();
	list(&mut store, SessionStatus::Pending, WROTE_MS);
	// The operator is looking at another session, so this one is not active.
	store.persisted.shell.active_session = Some(SessionId::from("session_0002"));
	list(&mut store, SessionStatus::Complete, WROTE_MS + 5000);
	assert_eq!(session_badge(&store, &session_id(), NOW_MS), Some(SessionBadge::Done));

	open(&mut store);
	assert_eq!(session_badge(&store, &session_id(), NOW_MS), None, "opening the session reads it");
}

#[test]
fn a_failure_the_operator_has_read_stops_asking() {
	let mut store = Store::new();
	list(&mut store, SessionStatus::Pending, WROTE_MS);
	store.persisted.shell.active_session = Some(SessionId::from("session_0002"));
	list(&mut store, SessionStatus::Error, WROTE_MS + 5000);
	assert_eq!(session_badge(&store, &session_id(), NOW_MS), Some(SessionBadge::Failed));

	store.persisted.shell.active_session = Some(session_id());
	list(&mut store, SessionStatus::Error, WROTE_MS + 5000);
	assert_eq!(session_badge(&store, &session_id(), NOW_MS), None);
}

#[test]
fn a_listing_that_reports_a_new_status_does_not_reorder_the_partition() {
	let mut store = Store::new();
	list(&mut store, SessionStatus::Complete, WROTE_MS);
	let before: Vec<SessionId> = store.sessions.live.clone();
	let anchors: HashMap<SessionId, u64> = store
		.sessions
		.items
		.iter()
		.map(|(id, session)| (id.clone(), session.live_anchor()))
		.collect();
	list(&mut store, SessionStatus::Error, WROTE_MS + 90_000);
	assert_eq!(store.sessions.live, before);
	for (id, session) in &store.sessions.items {
		assert_eq!(Some(&session.live_anchor()), anchors.get(id), "anchor of {id:?}");
	}
}
