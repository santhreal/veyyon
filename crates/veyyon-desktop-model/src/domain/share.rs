//! Share session domain views and phase models.

use serde::{Deserialize, Serialize};

/// Relay session sharing status and link bundle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareView {
	/// Where the share is: what the window draws and what a control may ask for.
	pub state:         String,
	/// The relay the share runs on; null when the settings name none.
	pub relay_url:     Option<String>,
	/// The link another veyyon opens. Null unless hosting.
	pub link:          Option<String>,
	/// The same room in a browser.
	pub web_link:      Option<String>,
	/// The two links above, read-only.
	pub view_link:     Option<String>,
	pub web_view_link: Option<String>,
	/// The parties connected to the relay.
	pub participants:  Vec<ShareParticipantView>,
	/// Why the last attempt failed; null when nothing failed.
	pub error:         Option<String>,
}

/// One party on the relay, the hosting session included.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareParticipantView {
	/// Relay peer id. The hosting session is 0.
	pub id:        u64,
	pub name:      String,
	/// False for a guest that arrived by the read-only link.
	pub can_write: bool,
	/// True for the row that is this window's own session.
	pub is_host:   bool,
}

/// Where the share is: what the window draws and what a control may ask for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, strum::EnumIter)]
pub enum SharePhase {
	/// Not currently sharing.
	Off,
	/// Establishing connection with the relay.
	Starting,
	/// Actively sharing this session over the relay.
	Hosting,
	/// Terminating relay connection.
	Stopping,
	/// A word from a host on a newer protocol. The card draws without claiming
	/// anything.
	Unknown,
}

impl SharePhase {
	/// Returns wire name identifier.
	#[must_use]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Off => "off",
			Self::Starting => "starting",
			Self::Hosting => "hosting",
			Self::Stopping => "stopping",
			Self::Unknown => "unknown",
		}
	}
}

impl From<&str> for SharePhase {
	fn from(state: &str) -> Self {
		match state.to_ascii_lowercase().as_str() {
			"off" => Self::Off,
			"starting" => Self::Starting,
			"hosting" => Self::Hosting,
			"stopping" => Self::Stopping,
			_ => Self::Unknown,
		}
	}
}

impl ShareView {
	/// The phase parsed from the word the host sent.
	#[must_use]
	pub fn phase(&self) -> SharePhase {
		SharePhase::from(self.state.as_str())
	}
}
