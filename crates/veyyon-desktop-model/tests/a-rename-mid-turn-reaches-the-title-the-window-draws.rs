//! WHY: the active session's header is the only section that reports a rename
//! of the open session on its own. The host re-sends the whole index on create,
//! rename and delete, but a title the model authors mid-turn arrives as
//! `ActiveSession` first, and the reducer read the id out of that header and
//! discarded the rest. The titlebar and the queue row kept the previous name
//! until some unrelated session was created, renamed or deleted, since only
//! that re-sends the index.
//!
//! CLASS CLOSED: an `ActiveSession` header whose fields are dropped instead of
//! reaching the row the queue draws — for every partition the operator may
//! have moved the session into, swept from `QueuePartition::ALL` so a sixth
//! partition fails here until it is given a decision.
//!
//! It also pins the three ownership rules that make this reduction safe, since
//! the obvious "fix" is to rebuild the row from the header: the index is the
//! sole authority on which sessions exist, it owns the workspace name, and
//! `created_at_ms` is the Live anchor §5.2 re-anchors on unpark, recall and pin
//! alone. `live_queue_ordering_invariant.rs` sweeps the first across every
//! section.
//!
//! NOT CAUGHT: whether the host sends a header on rename at all, and whether
//! the surface draws the title it now holds. `veyyon-desktop`'s
//! `every-answer-the-host-sends-reaches-the-window.rs` sweeps the second, and
//! the gui-host suites own the first.

use veyyon_desktop_model::{
	Damage, HostEvent, QueuePartition, Session, SessionHeaderView, SessionId, SessionStatus,
	SnapshotSection, Store, Versioned, reduce,
};

/// A session as the store holds it once the index has listed it.
fn listed(id: &str, partition: QueuePartition) -> Session {
	Session {
		id: SessionId::from(id),
		title: "old title".to_string(),
		project_name: "repo".to_string(),
		branch: String::new(),
		partition,
		status: SessionStatus::Unknown,
		modified_at_ms: 1_000,
		read_mark_ms: Some(1_000),
		created_at_ms: 1_000,
		last_recall_at_ms: 1_000,
		defer_until_ms: None,
		parked_at_ms: None,
		pin_key: None,
	}
}

/// The header the host sends for the session it just opened or renamed.
fn header(id: &str, title: Option<&str>) -> SnapshotSection {
	SnapshotSection::ActiveSession(Versioned {
		revision: 7,
		value:    SessionHeaderView {
			id:             SessionId::from(id),
			schema_version: 3,
			title:          title.map(str::to_string),
			title_source:   Some("model".to_string()),
			parent:         None,
			created_at_ms:  4_000,
			cwd:            "/repo".to_string(),
			mode:           None,
		},
	})
}

#[test]
fn a_renamed_session_carries_its_new_title_into_the_row() {
	for partition in QueuePartition::ALL {
		let mut store = Store::new();
		store.sessions.insert(listed("sess-1", partition));

		reduce(&mut store, HostEvent::Snapshot(header("sess-1", Some("plan the cutover"))));

		let session = store
			.sessions
			.get(&SessionId::from("sess-1"))
			.expect("the header must not drop the session it names");
		assert_eq!(
			session.title, "plan the cutover",
			"a rename reported through the header must reach the {partition:?} row"
		);
		assert_eq!(
			session.partition, partition,
			"the header carries no partition and must not move the session"
		);
	}
}

#[test]
fn the_index_keeps_the_workspace_name_and_the_live_anchor() {
	let mut store = Store::new();
	store
		.sessions
		.insert(listed("sess-1", QueuePartition::Live));

	reduce(&mut store, HostEvent::Snapshot(header("sess-1", Some("plan the cutover"))));

	let session = store
		.sessions
		.get(&SessionId::from("sess-1"))
		.expect("the session stays");
	assert_eq!(
		session.project_name, "repo",
		"the index owns the workspace name; the header carries a cwd, not a name"
	);
	assert_eq!(
		session.created_at_ms, 1_000,
		"created_at_ms is the Live anchor and is re-read only on unpark, recall and pin"
	);
	assert_eq!(
		session.last_recall_at_ms, 1_000,
		"opening a session is not a recall and must not reorder the Live partition"
	);
}

#[test]
fn a_header_for_a_session_the_index_has_not_listed_adds_no_row() {
	let mut store = Store::new();

	reduce(&mut store, HostEvent::Snapshot(header("sess-new", Some("first prompt"))));

	assert_eq!(
		store.persisted.shell.active_session,
		Some(SessionId::from("sess-new")),
		"the header selects the session it names, and the listing that follows brings its row"
	);
	assert!(
		store.sessions.get(&SessionId::from("sess-new")).is_none(),
		"the index is the sole authority on which sessions exist"
	);
	assert!(store.sessions.live.is_empty(), "a header adds nothing to a partition");
}

#[test]
fn an_untitled_header_leaves_no_row_nameless() {
	let mut store = Store::new();
	store
		.sessions
		.insert(listed("sess-1", QueuePartition::Live));
	store
		.sessions
		.insert(listed("sess-2", QueuePartition::Live));

	reduce(&mut store, HostEvent::Snapshot(header("sess-1", None)));
	reduce(&mut store, HostEvent::Snapshot(header("sess-2", Some("   "))));

	assert_eq!(
		store
			.sessions
			.get(&SessionId::from("sess-1"))
			.expect("the session stays")
			.title,
		"new session",
		"a header with no title falls back to the same placeholder the index uses"
	);
	assert_eq!(
		store
			.sessions
			.get(&SessionId::from("sess-2"))
			.expect("the session stays")
			.title,
		"new session",
		"a whitespace title is no title"
	);
}

#[test]
fn the_row_the_header_changed_is_reported_as_damaged() {
	let mut store = Store::new();
	store
		.sessions
		.insert(listed("sess-1", QueuePartition::Live));

	let damage = reduce(&mut store, HostEvent::Snapshot(header("sess-1", Some("renamed"))));

	assert!(
		damage.contains(&Damage::QueueAll),
		"a title the queue draws changed, so the rail must be redrawn: {damage:?}"
	);
	assert!(
		damage.contains(&Damage::Titlebar),
		"the titlebar draws the active session's title: {damage:?}"
	);
}
