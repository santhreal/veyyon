//! Stable identifiers crossing the host boundary.
//!
//! Product identifiers reject empty text at construction. `RequestId` is the
//! frontend-generated correlation value and starts at one.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct EmptyId;

impl fmt::Display for EmptyId {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str("identifier must not be empty")
	}
}

macro_rules! text_id {
	($name:ident) => {
		#[derive(
			Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
		)]
		#[serde(transparent)]
		pub struct $name(String);

		impl $name {
			pub fn new(value: impl Into<String>) -> Result<Self, EmptyId> {
				let value = value.into();
				if value.trim().is_empty() {
					Err(EmptyId)
				} else {
					Ok(Self(value))
				}
			}

			pub fn as_str(&self) -> &str {
				&self.0
			}

			pub fn from_static(value: &'static str) -> Self {
				Self(value.to_owned())
			}
		}

		impl fmt::Display for $name {
			fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
				formatter.write_str(&self.0)
			}
		}
	};
}

text_id!(WorkspaceId);
text_id!(SessionId);
text_id!(EntryId);
text_id!(ToolId);
text_id!(TerminalId);
text_id!(AgentId);
text_id!(TaskId);
text_id!(ProviderId);
text_id!(ModelId);
text_id!(McpServerId);
text_id!(FileId);
text_id!(NoticeId);
text_id!(InteractionId);
text_id!(ExtensionId);
text_id!(ProcessId);
text_id!(AccountId);
text_id!(AttachmentId);
text_id!(SpaceId);

#[derive(
	Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(transparent)]
pub struct RequestId(u64);

impl RequestId {
	pub const FIRST: Self = Self(1);

	pub fn new(value: u64) -> Option<Self> {
		(value != 0).then_some(Self(value))
	}

	pub fn get(self) -> u64 {
		self.0
	}

	pub(crate) fn next(self) -> Self {
		if self.0 == u64::MAX {
			Self::FIRST
		} else {
			Self(self.0 + 1)
		}
	}
}
