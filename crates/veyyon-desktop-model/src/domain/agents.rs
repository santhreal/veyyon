use serde::{Deserialize, Serialize};

use crate::connection::SessionId;

/// Background or worker subagent execution metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentView {
	/// Unique agent identifier.
	pub id:           String,
	/// Human-readable agent display name.
	pub display_name: String,
	/// Agent role or kind.
	pub kind:         String,
	/// Operational state.
	pub status:       String,
	/// Parent agent identifier if nested.
	pub parent:       Option<String>,
	/// Working directory or scope path.
	pub scope:        String,
	/// Owning session identifier if tied to a session.
	pub session:      Option<SessionId>,
}
