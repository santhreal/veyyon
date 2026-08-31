//! WHY: the shell drew "Select a session" beside a populated conversation list,
//! and the composer refused to send, because selection was frontend state that
//! nothing reconciled against the arriving engine-owned session index. The
//! class is every arrival of that index: a first load, a later load that
//! replaces it, an active session named by the host, and a deletion that
//! removes the selected row. Each has to leave the selection naming a session
//! that exists.
//!
//! Not covered here: which session the host considers active is the host's
//! call, and a host that names none falls back to the most recently modified
//! row. This suite does not test the view that reads the selection.

use super::helpers::*;
use crate::{
	host::{HostEvent, SnapshotSection},
	model::*,
	store::Store,
};

fn summary(id: &str, modified_at_ms: u64) -> SessionSummary {
	SessionSummary {
		id: sid(id),
		workspace: WorkspaceId::new("workspace")
			.unwrap_or_else(|_| unreachable!("static workspace id")),
		path: format!("/repo/{id}.jsonl"),
		cwd: "/repo".to_owned(),
		title: Some(id.to_owned()),
		parent_path: None,
		created_at_ms: 1,
		modified_at_ms,
		message_count: 1,
		size_bytes: 1,
		first_message: None,
		searchable_messages: None,
		status: SessionStatus::Complete,
	}
}

fn index(revision: u64, sessions: Vec<SessionSummary>) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Sessions(Versioned { revision, value: sessions }, vec![]))
}

fn active(revision: u64, id: &str) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
		revision,
		value: SessionHeaderView {
			id:             sid(id),
			schema_version: 1,
			title:          Some(id.to_owned()),
			title_source:   None,
			parent:         None,
			created_at_ms:  1,
			cwd:            "/repo".to_owned(),
		},
	}))
}

#[test]
fn the_most_recent_session_opens_when_the_index_arrives_without_an_active_session() {
	let mut store = Store::detached();
	assert_eq!(store.frontend.selected_session, None);
	store.apply(index(1, vec![summary("older", 10), summary("newest", 30), summary("mid", 20)]));
	assert_eq!(store.frontend.selected_session, Some(sid("newest")));
}

#[test]
fn the_host_named_active_session_wins_over_recency() {
	let mut store = Store::detached();
	store.apply(active(1, "older"));
	store.apply(index(1, vec![summary("older", 10), summary("newest", 30)]));
	assert_eq!(store.frontend.selected_session, Some(sid("older")));
}

#[test]
fn an_active_session_arriving_after_the_index_does_not_move_a_live_selection() {
	let mut store = Store::detached();
	store.apply(index(1, vec![summary("older", 10), summary("newest", 30)]));
	assert_eq!(store.frontend.selected_session, Some(sid("newest")));
	store.apply(active(1, "older"));
	assert_eq!(
		store.frontend.selected_session,
		Some(sid("newest")),
		"a selection that still names a live session is never retargeted"
	);
}

#[test]
fn a_deleted_selection_is_replaced_rather_than_left_addressing_a_gone_session() {
	let mut store = Store::detached();
	store.apply(index(1, vec![summary("kept", 10), summary("doomed", 30)]));
	assert_eq!(store.frontend.selected_session, Some(sid("doomed")));
	store.apply(index(2, vec![summary("kept", 10)]));
	assert_eq!(store.frontend.selected_session, Some(sid("kept")));
}

#[test]
fn an_empty_index_selects_nothing_and_clears_a_stale_selection() {
	let mut store = Store::detached();
	store.apply(index(1, vec![summary("only", 10)]));
	assert_eq!(store.frontend.selected_session, Some(sid("only")));
	store.apply(index(2, vec![]));
	assert_eq!(store.frontend.selected_session, None);
}

#[test]
fn a_stale_active_session_naming_no_live_row_falls_back_to_recency() {
	let mut store = Store::detached();
	store.apply(active(1, "vanished"));
	store.apply(index(1, vec![summary("kept", 10), summary("newest", 30)]));
	assert_eq!(store.frontend.selected_session, Some(sid("newest")));
}

#[test]
fn an_unreadable_index_leaves_the_selection_alone() {
	let mut store = Store::detached();
	store.apply(index(1, vec![summary("only", 10)]));
	store.apply(HostEvent::Snapshot(SnapshotSection::Sessions(
		Versioned { revision: 0, value: vec![] },
		vec![],
	)));
	assert_eq!(
		store.frontend.selected_session,
		Some(sid("only")),
		"a superseded revision is dropped before it can clear the selection"
	);
}
