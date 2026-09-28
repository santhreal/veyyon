//! What the host reports about a session without its transcript: a listing
//! row and the header of the open session.

use serde::{Deserialize, Serialize};

use crate::connection::SessionId;

/// Status summary for a session stored on disk.
#[derive(
	Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ts_rs::TS, strum::EnumIter,
)]
pub enum SessionStatus {
	Complete,
	Interrupted,
	Aborted,
	Error,
	Pending,
	Unknown,
}

/// Lightweight session metadata returned in session directory listings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct SessionSummary {
	pub id:                  SessionId,
	pub workspace:           String,
	pub path:                String,
	pub cwd:                 String,
	pub title:               Option<String>,
	pub parent_path:         Option<String>,
	pub created_at_ms:       u64,
	pub modified_at_ms:      u64,
	pub message_count:       u32,
	pub size_bytes:          u64,
	pub first_message:       Option<String>,
	pub searchable_messages: Option<String>,
	pub status:              SessionStatus,
}

/// Error encountered when reading or parsing a session header file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct SessionLoadError {
	pub path:   String,
	pub reason: String,
}

/// Detailed session header information for the active session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct SessionHeaderView {
	pub id:             SessionId,
	pub schema_version: u32,
	pub title:          Option<String>,
	pub title_source:   Option<String>,
	pub parent:         Option<SessionId>,
	pub created_at_ms:  u64,
	pub cwd:            String,
	/// The mode the session is in as the host spells it (`plan`, `goal`,
	/// `none`), absent from a host that reports no mode at all.
	#[serde(default)]
	pub mode:           Option<String>,
}
