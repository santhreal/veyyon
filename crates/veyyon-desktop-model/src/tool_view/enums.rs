//! Semantic status, tone, side, and content kind enumerations for `ToolView`.

use serde::{Deserialize, Serialize};

/// What a tool reports about its own state.
///
/// Semantic, never a glyph: the host chooses the symbol, the colour, and
/// whether `Running` animates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ViewStatus {
	Success,
	Done,
	Error,
	Warning,
	Info,
	Pending,
	Running,
	Aborted,
}

impl ViewStatus {
	/// Returns all status variants in canonical order.
	#[must_use]
	pub const fn all() -> [Self; 8] {
		[
			Self::Success,
			Self::Done,
			Self::Error,
			Self::Warning,
			Self::Info,
			Self::Pending,
			Self::Running,
			Self::Aborted,
		]
	}

	/// Whether this status indicates an active/in-progress operation.
	#[must_use]
	pub const fn is_active(self) -> bool {
		matches!(self, Self::Running | Self::Pending)
	}

	/// Whether this status indicates a failure/error condition.
	#[must_use]
	pub const fn is_error(self) -> bool {
		matches!(self, Self::Error | Self::Aborted)
	}

	/// Whether this status indicates successful completion.
	#[must_use]
	pub const fn is_success(self) -> bool {
		matches!(self, Self::Success | Self::Done)
	}
}

/// The role a run of text plays, which a host maps to its own appearance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ViewTone {
	Title,
	Accent,
	Output,
	Link,
	Muted,
	Dim,
	DiffAdded,
	DiffRemoved,
	Success,
	Warning,
	Error,
	Info,
	Cost,
	Text,
}

/// Which side of a change one line of a diff section is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ViewDiffSide {
	Added,
	Removed,
	Context,
	Gap,
}

/// What a framed block's body is, deciding where state is presented.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ViewContentsKind {
	#[default]
	Report,
	Data,
	Listing,
}
