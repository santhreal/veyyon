//! `AppState` reduces a batch of host events and emits one typed event per
//! region the batch changed, and nothing for a region it left alone.
//!
//! WHY: a view re-renders on the events it subscribes to. An event emitted
//! for an unchanged region (a sidebar notified per streamed delta, a
//! transcript reset by a reopen at the same revision) costs a render, and a
//! splice range that is off by one draws the wrong entries. The suites drive
//! the real reducer through `reduce_batch`, and through a gpui subscription
//! where the emit path itself is the contract.
//!
//! Gap: the host's revision numbers are taken as given; a host that reuses
//! a revision for different content is caught only when the display order
//! differs too.

mod remembered;
mod sessions;
mod transcript;

use veyyon_desktop_app::{AppState, StoreEvent};
use veyyon_desktop_model::{
	EntryId, HostEvent, MessageRole, SessionHeaderView, SessionId, SessionStatus, SessionSummary,
	SnapshotSection, StreamingMessageState, TranscriptEntry, Versioned,
};

/// A session id.
fn sid(id: &str) -> SessionId {
	SessionId::from(id)
}

/// An assistant entry with no content.
fn entry(id: &str, parent: Option<&str>, revision: u64) -> TranscriptEntry {
	TranscriptEntry {
		id: EntryId::from(id),
		parent: parent.map(EntryId::from),
		revision,
		timestamp_ms: revision,
		role: MessageRole::Assistant,
		content: Vec::new(),
		meta: None,
		raw_discriminator: String::new(),
		raw: serde_json::Value::Null,
	}
}

/// The ids `{session}-0` to `{session}-{count - 1}`, each the child of the
/// one before.
fn chain(session: &str, count: usize, revision: u64) -> Vec<TranscriptEntry> {
	(0..count)
		.map(|ix| {
			let parent = ix.checked_sub(1).map(|up| format!("{session}-{up}"));
			entry(&format!("{session}-{ix}"), parent.as_deref(), revision)
		})
		.collect()
}

/// The host making `session` active and sending its transcript whole: a
/// chain of `count` entries at `revision`.
fn opened(session: &str, revision: u64, count: usize) -> Vec<HostEvent> {
	let header = SessionHeaderView {
		id:             sid(session),
		schema_version: 1,
		title:          None,
		title_source:   None,
		parent:         None,
		created_at_ms:  0,
		cwd:            format!("/w/{session}"),
		mode:           None,
	};
	vec![
		HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned { revision, value: header })),
		HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
			revision,
			value: chain(session, count, revision),
		})),
	]
}

/// A streamed delta of the message `entry`.
fn delta(entry_id: &str, revision: u64) -> HostEvent {
	HostEvent::StreamingChanged(Some(StreamingMessageState {
		entry: EntryId::from(entry_id),
		tool: None,
		accumulating: entry(entry_id, None, revision),
		revision,
	}))
}

/// An index row for a session file.
fn summary(id: &str, cwd: &str, modified_at_ms: u64, parent: Option<&str>) -> SessionSummary {
	SessionSummary {
		id: sid(id),
		workspace: "ws-default".to_owned(),
		path: format!("/sessions/{id}.jsonl"),
		cwd: cwd.to_owned(),
		title: Some(format!("title {id}")),
		parent_path: parent.map(|up| format!("/sessions/{up}.jsonl")),
		created_at_ms: 0,
		modified_at_ms,
		message_count: 1,
		size_bytes: 1,
		first_message: None,
		searchable_messages: None,
		status: SessionStatus::Complete,
	}
}

/// The host's session index.
const fn listing(summaries: Vec<SessionSummary>) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Sessions(
		Versioned { revision: 1, value: summaries },
		Vec::new(),
	))
}

/// The ids on the active branch of `session`, in display order.
fn displayed_ids(state: &AppState, session: &str) -> Vec<String> {
	let session = sid(session);
	(0..state.entry_count(&session))
		.filter_map(|ix| state.entry_at(&session, ix))
		.map(|entry| entry.id.0.clone())
		.collect()
}

/// The events that name `session`'s transcript as replaced.
fn resets(events: &[StoreEvent]) -> Vec<&StoreEvent> {
	events
		.iter()
		.filter(|event| matches!(event, StoreEvent::TranscriptReset { .. }))
		.collect()
}
