//! Provider fault injection taxonomy and payloads.

use serde::{Deserialize, Serialize};

/// The menu of provider faults that `vmock` can inject.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FaultKind {
	/// Abrupt mid-stream connection closure (`ECONNRESET`-shaped hard close).
	MidStreamDrop,
	/// Idle stall where the server stops responding and remains silent until
	/// timeout.
	IdleStall,
	/// Upstream HTTP 401 Unauthorized error with JSON payload.
	Http401,
	/// Upstream HTTP 429 Rate Limit Exceeded with `Retry-After` header.
	Http429,
	/// Upstream HTTP 500 Internal Server Error.
	Http500,
	/// Upstream HTTP 503 Service Unavailable.
	Http503,
	/// SSE stream containing syntactically truncated JSON.
	TruncatedJson,
	/// SSE stream containing invalid UTF-8 byte sequences.
	InvalidUtf8,
	/// SSE stream with an unterminated event missing the final double-newline.
	UnterminatedEvent,
	/// SSE stream delivering an unexpected / malformed thinking block structure.
	UnexpectedThinkingBlock,
}

impl FaultKind {
	/// All defined fault kinds in source order for exhaustive test sweeps.
	pub const ALL: &'static [Self] = &[
		Self::MidStreamDrop,
		Self::IdleStall,
		Self::Http401,
		Self::Http429,
		Self::Http500,
		Self::Http503,
		Self::TruncatedJson,
		Self::InvalidUtf8,
		Self::UnterminatedEvent,
		Self::UnexpectedThinkingBlock,
	];

	/// Returns all fault kind variants.
	#[must_use]
	pub const fn all() -> &'static [Self] {
		Self::ALL
	}

	/// Returns a human-readable identifier for this fault.
	#[must_use]
	pub const fn as_str(&self) -> &'static str {
		match self {
			Self::MidStreamDrop => "mid-stream-drop",
			Self::IdleStall => "idle-stall",
			Self::Http401 => "http-401",
			Self::Http429 => "http-429",
			Self::Http500 => "http-500",
			Self::Http503 => "http-503",
			Self::TruncatedJson => "truncated-json",
			Self::InvalidUtf8 => "invalid-utf8",
			Self::UnterminatedEvent => "unterminated-event",
			Self::UnexpectedThinkingBlock => "unexpected-thinking-block",
		}
	}
}

pub use crate::vmock::h2c::{
	H2ConnectionFault, H2FaultInstall, H2FaultKind, H2Reason, MID_DATA_CHUNK,
};
