use veyyon_desktop_model::{
	BackendError, ConnectionState, ContentBlock, Damage, EntryId, EntryMeta, ErrorScope, HostEvent,
	MessageRole, RequestId, SessionHeaderView, SessionId, SessionSummary, SnapshotSection, Store,
	StreamingMessageState, TranscriptEntry, Versioned, reduce,
};

#[test]
fn test_reduce_connection_changed() {
	let mut store = Store::new();
	let event = HostEvent::ConnectionChanged(ConnectionState::Connecting { attempt: 2 });
	let damage = reduce(&mut store, event);

	assert_eq!(store.connection, ConnectionState::Connecting { attempt: 2 });
	assert!(damage.contains(&Damage::ConnectionLine));
	assert!(damage.contains(&Damage::Titlebar));
}

#[test]
fn test_reduce_snapshot_sections() {
	let mut store = Store::new();

	// 1. Snapshot Sessions
	let summary = SessionSummary {
		id:                  SessionId::from("session-1"),
		workspace:           "workspace-a".to_string(),
		path:                "/path/to/session-1".to_string(),
		cwd:                 "/path/to".to_string(),
		title:               Some("Session Title".to_string()),
		parent_path:         None,
		created_at_ms:       1000,
		modified_at_ms:      2000,
		message_count:       5,
		size_bytes:          1024,
		first_message:       Some("hello".to_string()),
		searchable_messages: Some("hello world".to_string()),
		status:              veyyon_desktop_model::SessionStatus::Complete,
	};
	let sessions_event = HostEvent::Snapshot(SnapshotSection::Sessions(
		Versioned { revision: 1, value: vec![summary] },
		Vec::new(),
	));
	let damage_sessions = reduce(&mut store, sessions_event);
	assert!(damage_sessions.contains(&Damage::QueueAll));
	assert!(
		store
			.sessions
			.items
			.contains_key(&SessionId::from("session-1"))
	);

	// 2. Snapshot ActiveSession
	let active_event = HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
		revision: 1,
		value:    SessionHeaderView {
			id:             SessionId::from("session-1"),
			schema_version: 1,
			title:          Some("Session Title".to_string()),
			title_source:   None,
			parent:         None,
			created_at_ms:  1000,
			cwd:            "/path/to".to_string(),
		},
	}));
	let damage_active = reduce(&mut store, active_event);
	assert!(damage_active.contains(&Damage::Titlebar));
	assert!(damage_active.contains(&Damage::Composer(SessionId::from("session-1"))));
	assert!(damage_active.contains(&Damage::RightPanelChrome(SessionId::from("session-1"))));

	// 3. Snapshot Transcript
	let entry = TranscriptEntry {
		id:                EntryId::from("entry-1"),
		parent:            None,
		revision:          1,
		timestamp_ms:      1000,
		role:              MessageRole::User,
		content:           vec![ContentBlock::Text { text: "Hello".to_string() }],
		meta:              None,
		raw_discriminator: "text".to_string(),
		raw:               serde_json::json!({}),
	};
	let transcript_event = HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
		revision: 1,
		value:    vec![entry],
	}));
	let damage_transcript = reduce(&mut store, transcript_event);
	assert!(damage_transcript.contains(&Damage::TranscriptFull(SessionId::from("session-1"))));
}

#[test]
fn test_reduce_transcript_appended() {
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(SessionId::from("session-1"));

	let entry = TranscriptEntry {
		id:                EntryId::from("entry-2"),
		parent:            None,
		revision:          2,
		timestamp_ms:      2000,
		role:              MessageRole::Assistant,
		content:           vec![ContentBlock::Text { text: "Response".to_string() }],
		meta:              Some(EntryMeta {
			provider:    Some("anthropic".to_string()),
			model:       Some("claude-3-5-sonnet".to_string()),
			stop_reason: Some("end_turn".to_string()),
			error:       None,
			usage:       None,
		}),
		raw_discriminator: "text".to_string(),
		raw:               serde_json::json!({}),
	};

	let event = HostEvent::TranscriptAppended { revision: 2, entries: vec![entry] };
	let damage = reduce(&mut store, event);

	assert!(
		damage.contains(&Damage::TranscriptEntry(
			SessionId::from("session-1"),
			EntryId::from("entry-2")
		))
	);
	assert!(damage.contains(&Damage::QueueRow(SessionId::from("session-1"))));
	assert!(damage.contains(&Damage::RunBar(SessionId::from("session-1"))));
}

#[test]
fn test_reduce_transcript_updated() {
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(SessionId::from("session-1"));

	let entry = TranscriptEntry {
		id:                EntryId::from("entry-2"),
		parent:            None,
		revision:          3,
		timestamp_ms:      2000,
		role:              MessageRole::Assistant,
		content:           vec![ContentBlock::Text { text: "Updated Response".to_string() }],
		meta:              None,
		raw_discriminator: "text".to_string(),
		raw:               serde_json::json!({}),
	};

	let event = HostEvent::TranscriptUpdated { revision: 3, entry };
	let damage = reduce(&mut store, event);

	assert!(
		damage.contains(&Damage::TranscriptEntry(
			SessionId::from("session-1"),
			EntryId::from("entry-2")
		))
	);
}

#[test]
fn test_reduce_streaming_changed() {
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(SessionId::from("session-1"));

	let entry = TranscriptEntry {
		id:                EntryId::from("entry-stream"),
		parent:            None,
		revision:          1,
		timestamp_ms:      1000,
		role:              MessageRole::Assistant,
		content:           vec![ContentBlock::Text { text: "Streaming chunk".to_string() }],
		meta:              None,
		raw_discriminator: "text".to_string(),
		raw:               serde_json::json!({}),
	};

	let stream_state = StreamingMessageState {
		entry:        EntryId::from("entry-stream"),
		tool:         None,
		accumulating: entry,
		revision:     1,
	};

	// 1. Streaming in progress
	let event_active = HostEvent::StreamingChanged(Some(stream_state));
	let damage_active = reduce(&mut store, event_active);
	assert!(damage_active.contains(&Damage::TranscriptEntry(
		SessionId::from("session-1"),
		EntryId::from("entry-stream")
	)));
	assert!(damage_active.contains(&Damage::RunBar(SessionId::from("session-1"))));

	// 2. Streaming complete (None)
	let event_ended = HostEvent::StreamingChanged(None);
	let damage_ended = reduce(&mut store, event_ended);
	assert!(damage_ended.contains(&Damage::RunBar(SessionId::from("session-1"))));
}

#[test]
fn test_reduce_request_succeeded() {
	let mut store = Store::new();
	let event = HostEvent::RequestSucceeded { request: RequestId(42) };
	let damage = reduce(&mut store, event);
	assert!(damage.is_empty());
}

#[test]
fn test_reduce_request_failed() {
	let mut store = Store::new();
	let error = BackendError {
		scope:          ErrorScope::Connection,
		code:           Some("ECONNREFUSED".to_string()),
		message:        "Connection failed".to_string(),
		retryable:      true,
		request:        Some(RequestId(42)),
		occurred_at_ms: 1000,
	};

	let event = HostEvent::RequestFailed { request: RequestId(42), error };
	let damage = reduce(&mut store, event);
	assert!(damage.contains(&Damage::ConnectionLine));
}

#[test]
fn test_reduce_fatal_protocol_error() {
	let mut store = Store::new();
	let event =
		HostEvent::FatalProtocolError { message: "Framing error: message exceeds 8MB".to_string() };
	let damage = reduce(&mut store, event);

	assert!(matches!(store.connection, ConnectionState::Fatal { .. }));
	assert!(damage.contains(&Damage::FullWindow));
	// FullWindow coarsens and subsumes all finer damages
	assert_eq!(damage.len(), 1);
}
