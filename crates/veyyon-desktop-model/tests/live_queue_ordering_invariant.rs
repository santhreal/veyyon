//! WHY: §5.2 anchors the `Live` partition on
//! `max(created_at_ms, last_recall_at_ms)` and re-anchors on unpark, recall and
//! pin alone. A turn beginning, a token arriving, a badge appearing or a
//! session being renamed must leave the order alone, or a queue reorders itself
//! under an operator who is reading it.
//!
//! CLASS CLOSED: an event that reorders `Live`. The events are swept from
//! `HostEventKind` and the snapshot sections from the shared corpus, so an
//! event or a section added to the protocol fails here — to compile, in the
//! event's case — until it is given a sample and a decision. The session index
//! is the one section allowed to change which sessions `Live` holds, and it is
//! asserted to produce the order §5.2 states rather than merely to differ.
//!
//! NOT CAUGHT: an intent the client dispatches on its own. The rail's own
//! park, defer, pin and unpark calls are in
//! `a-session-listing-keeps-the-partition-the-operator-chose.rs` and in the
//! surface suites.

use std::{fs, path::PathBuf};

use strum::IntoEnumIterator as _;
use veyyon_desktop_model::{
	BackendError, ConnectionState, ContentBlock, EntryId, ErrorScope, HostEvent, HostEventKind,
	MessageRole, QueuePartition, RequestId, Session, SessionBadge, SessionId, SessionSummary,
	SettingsView, SnapshotSection, SnapshotSectionKind, Store, StreamingMessageState,
	TranscriptEntry, reduce,
};

fn create_sample_live_sessions() -> Vec<Session> {
	vec![
		Session {
			id:                SessionId::from("session-a"),
			title:             "Alpha".to_string(),
			project_name:      "proj-1".to_string(),
			branch:            "main".to_string(),
			partition:         QueuePartition::Live,
			badge:             None,
			created_at_ms:     1000,
			last_recall_at_ms: 2000, // anchor: 2000
			defer_until_ms:    None,
			parked_at_ms:      None,
			pin_key:           None,
		},
		Session {
			id:                SessionId::from("session-b"),
			title:             "Beta".to_string(),
			project_name:      "proj-1".to_string(),
			branch:            "main".to_string(),
			partition:         QueuePartition::Live,
			badge:             None,
			created_at_ms:     3000,
			last_recall_at_ms: 1500, // anchor: 3000
			defer_until_ms:    None,
			parked_at_ms:      None,
			pin_key:           None,
		},
		Session {
			id:                SessionId::from("session-c"),
			title:             "Gamma".to_string(),
			project_name:      "proj-1".to_string(),
			branch:            "main".to_string(),
			partition:         QueuePartition::Live,
			badge:             None,
			created_at_ms:     2500,
			last_recall_at_ms: 2500, // anchor: 2500
			defer_until_ms:    None,
			parked_at_ms:      None,
			pin_key:           None,
		},
	]
}

/// A transcript entry, which three of the events below carry.
fn entry(id: &str, revision: u64, text: &str) -> TranscriptEntry {
	TranscriptEntry {
		id: EntryId::from(id),
		parent: None,
		revision,
		timestamp_ms: 5000,
		role: MessageRole::Assistant,
		content: vec![ContentBlock::Text { text: text.to_string() }],
		meta: None,
		raw_discriminator: "text".to_string(),
		raw: serde_json::json!({}),
	}
}

/// One sample event per protocol event kind.
///
/// The match is exhaustive on the kind, so an event added to the protocol fails
/// to compile here until it is given a sample and this sweep covers it.
fn sample_event(kind: HostEventKind) -> HostEvent {
	match kind {
		HostEventKind::ConnectionChanged => {
			HostEvent::ConnectionChanged(ConnectionState::Connected {
				endpoint: "127.0.0.1".to_string(),
				protocol: 1,
			})
		},
		HostEventKind::Snapshot => {
			HostEvent::Snapshot(SnapshotSection::Settings(SettingsView::new()))
		},
		HostEventKind::TranscriptAppended => {
			HostEvent::TranscriptAppended { revision: 1, entries: vec![entry("entry-1", 1, "hello")] }
		},
		HostEventKind::TranscriptUpdated => {
			HostEvent::TranscriptUpdated { revision: 2, entry: entry("entry-1", 2, "hello world") }
		},
		HostEventKind::StreamingChanged => HostEvent::StreamingChanged(Some(StreamingMessageState {
			entry:        EntryId::from("stream-1"),
			tool:         None,
			accumulating: entry("stream-1", 1, "streaming..."),
			revision:     1,
		})),
		HostEventKind::RequestSucceeded => HostEvent::RequestSucceeded { request: RequestId(1) },
		HostEventKind::RequestFailed => HostEvent::RequestFailed {
			request: RequestId(2),
			error:   BackendError {
				scope:          ErrorScope::Session,
				code:           None,
				message:        "failed".to_string(),
				retryable:      true,
				request:        Some(RequestId(2)),
				occurred_at_ms: 5000,
			},
		},
		HostEventKind::FatalProtocolError => {
			HostEvent::FatalProtocolError { message: "fatal error".to_string() }
		},
	}
}

/// Every snapshot section the shared corpus carries, which is one per variant.
fn corpus_sections() -> Vec<SnapshotSection> {
	let fixture =
		PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/snapshot-sections.json");
	let raw = fs::read_to_string(&fixture).expect("the shared snapshot corpus is readable");
	serde_json::from_str(&raw).expect("the shared snapshot corpus decodes")
}

/// The `Live` order §5.2 states for a session index: anchor descending, ties by
/// id ascending.
fn expected_live(summaries: &[SessionSummary]) -> Vec<SessionId> {
	let mut ordered: Vec<(u64, SessionId)> = summaries
		.iter()
		.map(|summary| (summary.created_at_ms.max(summary.modified_at_ms), summary.id.clone()))
		.collect();
	ordered.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
	ordered.into_iter().map(|(_, id)| id).collect()
}

/// A store holding the three sample `Live` sessions, in the order §5.2 gives
/// them, with a badge set so activity is part of every case below.
fn seeded_store() -> Store {
	let mut store = Store::new();
	for session in create_sample_live_sessions() {
		store.sessions.insert(session);
	}
	assert_eq!(
		store.sessions.live,
		vec![
			SessionId::from("session-b"),
			SessionId::from("session-c"),
			SessionId::from("session-a"),
		],
		"anchor descending: Beta 3000, Gamma 2500, Alpha 2000"
	);
	if let Some(session_a) = store.sessions.get_mut(&SessionId::from("session-a")) {
		session_a.badge = Some(SessionBadge::Working { started_at_ms: 9999 });
	}
	store
}

#[test]
fn no_event_the_host_sends_reorders_the_live_partition() {
	for kind in HostEventKind::iter() {
		let event = sample_event(kind);
		assert_eq!(
			HostEventKind::from(&event),
			kind,
			"the sample for {kind:?} is an event of another kind, so that kind is unswept"
		);

		let mut store = seeded_store();
		let prior_live = store.sessions.live.clone();
		let _ = reduce(&mut store, event);
		assert_eq!(store.sessions.live, prior_live, "{kind:?} reordered the Live partition");
	}
}

#[test]
fn only_a_session_index_changes_which_sessions_live_holds() {
	for section in corpus_sections() {
		let kind = SnapshotSectionKind::from(&section);
		let listed = match &section {
			SnapshotSection::Sessions(versioned, _) => Some(expected_live(&versioned.value)),
			_ => None,
		};

		let mut store = seeded_store();
		let prior_live = store.sessions.live.clone();
		let _ = reduce(&mut store, HostEvent::Snapshot(section));

		match listed {
			Some(expected) => assert_eq!(
				store.sessions.live, expected,
				"the session index is every session the host holds, so Live is exactly what it \
				 listed, in anchor order"
			),
			None => assert_eq!(
				store.sessions.live, prior_live,
				"{kind:?} is not the session index and must leave the Live partition alone"
			),
		}
	}
}

#[test]
fn test_reanchoring_only_on_unpark_recall_pin() {
	let mut store = Store::new();
	for session in create_sample_live_sessions() {
		store.sessions.insert(session);
	}

	// 1. Park session-b
	store.sessions.park(&SessionId::from("session-b"), 4000);
	assert_eq!(store.sessions.live, vec![
		SessionId::from("session-c"),
		SessionId::from("session-a")
	]);

	// 2. Unpark session-b at t=6000 -> re-anchored to 6000 (top of Live)
	store.sessions.unpark(&SessionId::from("session-b"), 6000);
	assert_eq!(store.sessions.live, vec![
		SessionId::from("session-b"),
		SessionId::from("session-c"),
		SessionId::from("session-a")
	]);

	// 3. Defer session-a until t=10000
	store
		.sessions
		.defer(&SessionId::from("session-a"), Some(10000));
	assert_eq!(store.sessions.live, vec![
		SessionId::from("session-b"),
		SessionId::from("session-c")
	]);

	// 4. Recall session-a at t=7000 -> re-anchored to 7000 (top of Live)
	store.sessions.recall(&SessionId::from("session-a"), 7000);
	assert_eq!(store.sessions.live, vec![
		SessionId::from("session-a"),
		SessionId::from("session-b"),
		SessionId::from("session-c")
	]);
}
