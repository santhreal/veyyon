use veyyon_desktop_model::{
	BackendError, ConnectionState, ContentBlock, EntryId, ErrorScope, HostEvent, MessageRole,
	QueuePartition, RequestId, Session, SessionBadge, SessionId, SnapshotSection, Store,
	StreamingMessageState, TranscriptEntry, reduce,
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

fn generate_sample_events() -> Vec<HostEvent> {
	vec![
		HostEvent::ConnectionChanged(ConnectionState::Connected {
			endpoint: "127.0.0.1".to_string(),
			protocol: 1,
		}),
		HostEvent::Snapshot(SnapshotSection::Settings(serde_json::json!({}))),
		HostEvent::TranscriptAppended {
			revision: 1,
			entries:  vec![TranscriptEntry {
				id:                EntryId::from("entry-1"),
				parent:            None,
				revision:          1,
				timestamp_ms:      5000,
				role:              MessageRole::Assistant,
				content:           vec![ContentBlock::Text { text: "hello".to_string() }],
				meta:              None,
				raw_discriminator: "text".to_string(),
				raw:               serde_json::json!({}),
			}],
		},
		HostEvent::TranscriptUpdated {
			revision: 2,
			entry:    TranscriptEntry {
				id:                EntryId::from("entry-1"),
				parent:            None,
				revision:          2,
				timestamp_ms:      5000,
				role:              MessageRole::Assistant,
				content:           vec![ContentBlock::Text { text: "hello world".to_string() }],
				meta:              None,
				raw_discriminator: "text".to_string(),
				raw:               serde_json::json!({}),
			},
		},
		HostEvent::StreamingChanged(Some(StreamingMessageState {
			entry:        EntryId::from("stream-1"),
			tool:         None,
			accumulating: TranscriptEntry {
				id:                EntryId::from("stream-1"),
				parent:            None,
				revision:          1,
				timestamp_ms:      5000,
				role:              MessageRole::Assistant,
				content:           vec![ContentBlock::Text { text: "streaming...".to_string() }],
				meta:              None,
				raw_discriminator: "text".to_string(),
				raw:               serde_json::json!({}),
			},
			revision:     1,
		})),
		HostEvent::RequestSucceeded { request: RequestId(1) },
		HostEvent::RequestFailed {
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
		HostEvent::FatalProtocolError { message: "fatal error".to_string() },
	]
}

#[test]
fn test_live_ordering_invariant_preserved_across_all_host_events() {
	let sample_events = generate_sample_events();
	assert_eq!(sample_events.len(), 8, "Must test all 8 HostEvent variants");

	for event in sample_events {
		let mut store = Store::new();
		for session in create_sample_live_sessions() {
			store.sessions.insert(session);
		}

		// Initial live order should be: Beta (3000), Gamma (2500), Alpha (2000)
		let expected_order = vec![
			SessionId::from("session-b"),
			SessionId::from("session-c"),
			SessionId::from("session-a"),
		];
		assert_eq!(store.sessions.live, expected_order, "Initial sorting invariant violated");

		let prior_live = store.sessions.live.clone();

		// Add badge or token activity - must NOT change order
		if let Some(session_a) = store.sessions.get_mut(&SessionId::from("session-a")) {
			session_a.badge = Some(SessionBadge::Working { started_at_ms: 9999 });
		}

		// Apply event through pure reducer
		let _ = reduce(&mut store, event);

		// Assert order is strictly preserved
		assert_eq!(store.sessions.live, prior_live, "Live order was unexpectedly mutated by event");
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
	store.sessions.defer(&SessionId::from("session-a"), 10000);
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
