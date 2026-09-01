use serde::{Deserialize, Serialize};

use crate::{connection::EntryId, transcript::TranscriptEntry};

/// State container representing in-flight assistant token generation and active
/// tool progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamingMessageState {
	pub entry:        EntryId,
	pub tool:         Option<String>,
	pub accumulating: TranscriptEntry,
	pub revision:     u64,
}
