//! Shared test fixtures and identifier constructors.

use crate::model::*;

pub(super) fn sid(value: &str) -> SessionId {
	SessionId::new(value)
		.unwrap_or_else(|_| SessionId::new("fallback-session").unwrap_or_else(|_| unreachable!()))
}

pub(super) fn eid(value: &str) -> EntryId {
	EntryId::new(value)
		.unwrap_or_else(|_| EntryId::new("fallback-entry").unwrap_or_else(|_| unreachable!()))
}

pub(super) fn tid(value: &str) -> TerminalId {
	TerminalId::new(value)
		.unwrap_or_else(|_| TerminalId::new("fallback-terminal").unwrap_or_else(|_| unreachable!()))
}

pub(super) fn fid(value: &str) -> FileId {
	FileId::new(value)
		.unwrap_or_else(|_| FileId::new("fallback-file").unwrap_or_else(|_| unreachable!()))
}

pub(super) fn unknown_entry(id: &str, revision: u64) -> TranscriptEntry {
	TranscriptEntry {
		id: eid(id),
		parent: None,
		revision,
		timestamp_ms: 0,
		role: MessageRole::Unknown,
		content: vec![ContentBlock::Unknown {
			tag:   "future".to_owned(),
			value: Value::Object(vec![("field".to_owned(), Value::String("kept".to_owned()))]),
		}],
		meta: None,
		raw_discriminator: "future-entry".to_owned(),
		raw: Value::Opaque { media_type: "application/json".to_owned(), bytes: vec![0, 255, 3] },
	}
}
