//! Read-only session search and transcript responses.

use serde::{Deserialize, Serialize};

use crate::{SessionId, SessionSummary, TranscriptEntry, Versioned};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionSearchView {
	pub query:    String,
	pub sessions: Vec<SessionSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionTranscriptView {
	pub session:    SessionId,
	pub transcript: Versioned<Vec<TranscriptEntry>>,
}
