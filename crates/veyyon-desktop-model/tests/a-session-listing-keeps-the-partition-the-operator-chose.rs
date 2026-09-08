//! WHY: parking, deferring and pinning a session are the client's own state —
//! the host is never told and the summary it lists carries no partition. The
//! reducer rebuilt every session from the summary, so the next session index
//! (sent whenever a session is created, renamed, branched or deleted) returned
//! every parked, deferred and pinned session to `Live` and dropped its park,
//! defer and pin timestamps. Parking a session and then creating one undid the
//! park, which is the whole of §5.2 for an operator with a long queue.
//!
//! CLASS CLOSED: a session index reduction that overwrites client-owned queue
//! state, for every partition rather than the one that was reported. The
//! partitions are swept from `QueuePartition::ALL` and placed through an
//! exhaustive match, so a fifth placement fails to compile here until it is
//! given a placement and a decision.
//!
//! It also closes the opposite failure on the same path: the index is every
//! session the host holds, so one it no longer lists must go rather than sit in
//! the rail until a restart.
//!
//! NOT CAUGHT: what the host chooses to list. This suite drives the reducer, so
//! a host that omits a session it still holds looks the same here as a host
//! that deleted it. It also says nothing about the derived `Unsent` section,
//! which is not a placement and is projected rather than reduced.

use veyyon_desktop_model::{
	Damage, HostEvent, QueuePartition, Session, SessionId, SessionStatus, SessionSummary,
	SnapshotSection, Store, Versioned, reduce,
};

/// A session as the store holds it before any listing arrives.
fn seeded(id: &str, created_at_ms: u64) -> Session {
	Session {
		id: SessionId::from(id),
		title: format!("{id} title"),
		project_name: "repo".to_string(),
		branch: String::new(),
		partition: QueuePartition::Live,
		status: SessionStatus::Unknown,
		modified_at_ms: created_at_ms,
		read_mark_ms: Some(created_at_ms),
		created_at_ms,
		last_recall_at_ms: created_at_ms,
		defer_until_ms: None,
		parked_at_ms: None,
		pin_key: None,
	}
}

/// The host's summary for a session, with the title and modification time the
/// index reports.
fn summary(id: &str, title: &str, created_at_ms: u64, modified_at_ms: u64) -> SessionSummary {
	SessionSummary {
		id: SessionId::from(id),
		workspace: "repo".to_string(),
		path: format!("/repo/.veyyon/sessions/{id}.jsonl"),
		cwd: "/repo".to_string(),
		title: Some(title.to_string()),
		parent_path: None,
		created_at_ms,
		modified_at_ms,
		message_count: 2,
		size_bytes: 128,
		first_message: Some("hello".to_string()),
		searchable_messages: Some("hello world".to_string()),
		status: SessionStatus::Complete,
	}
}

const fn listing(summaries: Vec<SessionSummary>) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Sessions(
		Versioned { revision: 7, value: summaries },
		Vec::new(),
	))
}

/// Puts `id` into `partition` the way the operator's own action does, and
/// answers the timestamps that placement recorded.
fn place(store: &mut Store, id: &SessionId, partition: QueuePartition) {
	match partition {
		QueuePartition::Pinned => store.sessions.pin(id, Some("a".to_string())),
		QueuePartition::Live => {},
		QueuePartition::Deferred => store.sessions.defer(id, Some(9_000)),
		QueuePartition::Parked => store.sessions.park(id, 8_000),
	}
}

#[test]
fn a_listing_leaves_every_partition_and_its_timestamps_where_the_operator_put_them() {
	for partition in QueuePartition::ALL {
		let mut store = Store::new();
		store.sessions.insert(seeded("chosen", 1_000));
		let id = SessionId::from("chosen");
		place(&mut store, &id, partition);
		let before = store
			.sessions
			.get(&id)
			.cloned()
			.expect("the session is placed");

		// The same session, listed again with a newer title and modification
		// time, which is what a rename or a turn produces.
		let damage = reduce(&mut store, listing(vec![summary("chosen", "renamed", 1_000, 50_000)]));
		assert!(damage.contains(&Damage::QueueAll), "{partition:?}: the rail was not invalidated");

		let after = store
			.sessions
			.get(&id)
			.expect("the session survived the listing");
		assert_eq!(after.partition, before.partition, "{partition:?}: the listing moved the session");
		assert_eq!(
			after.parked_at_ms, before.parked_at_ms,
			"{partition:?}: the park timestamp was dropped"
		);
		assert_eq!(
			after.defer_until_ms, before.defer_until_ms,
			"{partition:?}: the defer deadline was dropped"
		);
		assert_eq!(after.pin_key, before.pin_key, "{partition:?}: the pin key was dropped");
		assert_eq!(
			after.last_recall_at_ms, before.last_recall_at_ms,
			"{partition:?}: the listing re-anchored a session, which §5.2 allows only unpark, recall \
			 and pin to do"
		);

		// The host owns the file's own metadata, so the rename does land.
		assert_eq!(after.title, "renamed", "{partition:?}: the renamed title never reached the rail");
	}
}

#[test]
fn a_listing_drops_every_session_it_no_longer_holds() {
	for partition in QueuePartition::ALL {
		let mut store = Store::new();
		store.sessions.insert(seeded("gone", 1_000));
		store.sessions.insert(seeded("kept", 2_000));
		let gone = SessionId::from("gone");
		place(&mut store, &gone, partition);

		reduce(&mut store, listing(vec![summary("kept", "kept title", 2_000, 2_000)]));

		assert!(
			store.sessions.get(&gone).is_none(),
			"{partition:?}: a session the index no longer lists must go"
		);
		assert!(
			store.sessions.get(&SessionId::from("kept")).is_some(),
			"{partition:?}: the listed session was dropped"
		);
		let listed_in = [
			&store.sessions.pinned,
			&store.sessions.live,
			&store.sessions.deferred,
			&store.sessions.parked,
		]
		.into_iter()
		.filter(|list| list.contains(&gone))
		.count();
		assert_eq!(listed_in, 0, "{partition:?}: a dropped session must leave every partition list");
	}
}

#[test]
fn a_listing_admits_a_session_the_store_has_not_seen_as_live() {
	let mut store = Store::new();
	store.sessions.insert(seeded("known", 1_000));
	store.sessions.park(&SessionId::from("known"), 8_000);

	reduce(
		&mut store,
		listing(vec![
			summary("known", "known title", 1_000, 1_000),
			summary("fresh", "fresh title", 4_000, 4_000),
		]),
	);

	let fresh = store
		.sessions
		.get(&SessionId::from("fresh"))
		.expect("the new session arrived");
	assert_eq!(fresh.partition, QueuePartition::Live);
	assert_eq!(fresh.last_recall_at_ms, 4_000, "a session first seen anchors on what the host says");
	assert_eq!(store.sessions.live, vec![SessionId::from("fresh")]);
	assert_eq!(store.sessions.parked, vec![SessionId::from("known")]);
}
