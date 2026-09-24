//! Read-only session search, transcript and prompt history responses.

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

/// One prompt submitted earlier, as the host recorded it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptHistoryEntry {
	/// Row identifier in the host's history store, stable across searches.
	pub id:              i64,
	/// The submitted prompt text, truncated by the host to a drawable width.
	pub prompt:          String,
	/// Submission time in milliseconds since the Unix epoch.
	pub submitted_at_ms: u64,
	/// Working directory the prompt was submitted from, when recorded.
	pub cwd:             Option<String>,
	/// Session the prompt was submitted from, when recorded.
	pub session:         Option<SessionId>,
	/// Flag stating the prompt text was cut to the drawable width.
	pub truncated:       bool,
}

/// The prompts the host's last history lookup matched.
///
/// An empty `query` is the listing the mode opens on: the most recent prompts
/// rather than nothing, so the mode carries rows before anything is typed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptHistoryView {
	/// Query the entries answer, empty for the opening listing.
	pub query:   String,
	/// Matching prompts, most recent first.
	pub entries: Vec<PromptHistoryEntry>,
}
