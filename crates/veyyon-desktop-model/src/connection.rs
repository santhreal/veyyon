use serde::{Deserialize, Serialize};

/// Protocol wire version.
pub const PROTOCOL_VERSION: u32 = 1;

/// Request identifier correlating host requests and responses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RequestId(pub u64);

/// Unique session identifier.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub String);

impl From<&str> for SessionId {
	fn from(value: &str) -> Self {
		Self(value.to_string())
	}
}

impl From<String> for SessionId {
	fn from(value: String) -> Self {
		Self(value)
	}
}

/// Unique transcript entry identifier.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct EntryId(pub String);

impl From<&str> for EntryId {
	fn from(value: &str) -> Self {
		Self(value.to_string())
	}
}

impl From<String> for EntryId {
	fn from(value: String) -> Self {
		Self(value)
	}
}

/// Unique interaction identifier for operator decisions.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct InteractionId(pub String);

impl From<&str> for InteractionId {
	fn from(value: &str) -> Self {
		Self(value.to_string())
	}
}

impl From<String> for InteractionId {
	fn from(value: String) -> Self {
		Self(value)
	}
}

/// Container associating a monotonically increasing revision with payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Versioned<T> {
	pub revision: u64,
	pub value:    T,
}

/// Host transport connection states mirroring wire protocol definitions.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConnectionState {
	#[default]
	Detached,
	Connecting {
		attempt: u32,
	},
	Syncing {
		received: u32,
		expected: Option<u32>,
	},
	Connected {
		endpoint: String,
		protocol: u32,
	},
	Reconnecting {
		attempt:     u32,
		retry_at_ms: u64,
		message:     String,
	},
	Fatal {
		message: String,
	},
}
