use serde::{Deserialize, Serialize};

use crate::{
	capabilities::{Capability, CapabilityStatus},
	connection::{ConnectionState, RequestId, SessionId, Versioned},
	error::BackendError,
	interaction::PendingDecisions,
	streaming::StreamingMessageState,
	transcript::TranscriptEntry,
};

/// Status summary for a session stored on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SessionStatus {
	Complete,
	Interrupted,
	Aborted,
	Error,
	Pending,
	Unknown,
}

/// Lightweight session metadata returned in session directory listings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionLoadError {
	pub path:   String,
	pub reason: String,
}

/// Detailed session header information for the active session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionHeaderView {
	pub id:             SessionId,
	pub schema_version: u32,
	pub title:          Option<String>,
	pub title_source:   Option<String>,
	pub parent:         Option<SessionId>,
	pub created_at_ms:  u64,
	pub cwd:            String,
}

/// Domain sections received during initial connection or snapshot
/// synchronization.
///
/// Each section is the whole of its domain as the host holds it at that
/// moment, so reducing one replaces rather than merges.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SnapshotSection {
	Sessions(Versioned<Vec<SessionSummary>>, Vec<SessionLoadError>),
	ActiveSession(Versioned<SessionHeaderView>),
	Transcript(Versioned<Vec<TranscriptEntry>>),
	Capabilities(Vec<(Capability, CapabilityStatus)>),
	/// Every decision a session is waiting on. Sent whenever one is raised or
	/// answered, and empty once none remain.
	Interactions {
		session: SessionId,
		pending: PendingDecisions,
	},
	Settings(serde_json::Value),
	Diagnostics(serde_json::Value),
}

/// Complete enumeration of the eight protocol event variants dispatched by host
/// transport.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum HostEvent {
	ConnectionChanged(ConnectionState),
	Snapshot(SnapshotSection),
	TranscriptAppended { revision: u64, entries: Vec<TranscriptEntry> },
	TranscriptUpdated { revision: u64, entry: TranscriptEntry },
	StreamingChanged(Option<StreamingMessageState>),
	RequestSucceeded { request: RequestId },
	RequestFailed { request: RequestId, error: BackendError },
	FatalProtocolError { message: String },
}

impl HostEvent {
	/// Returns the discriminator tag name for test sweeps.
	#[must_use]
	pub const fn tag(&self) -> &'static str {
		match self {
			Self::ConnectionChanged(_) => "ConnectionChanged",
			Self::Snapshot(_) => "Snapshot",
			Self::TranscriptAppended { .. } => "TranscriptAppended",
			Self::TranscriptUpdated { .. } => "TranscriptUpdated",
			Self::StreamingChanged(_) => "StreamingChanged",
			Self::RequestSucceeded { .. } => "RequestSucceeded",
			Self::RequestFailed { .. } => "RequestFailed",
			Self::FatalProtocolError { .. } => "FatalProtocolError",
		}
	}
}
