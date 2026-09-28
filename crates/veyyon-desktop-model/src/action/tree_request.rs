//! The requests that fork a session and move it through its entry tree.

use serde::{Deserialize, Serialize};

use crate::{
	action_kind::HostActionKind,
	connection::{EntryId, SessionId},
};

/// The requests the tree sheet and the `/fork` row send, each tagged as the
/// wire names it.
///
/// A family of its own rather than more variants of `HostAction`; the variant
/// that holds it is `untagged`, so a window still sends
/// `{"NavigateTree": {…}}` and the host still reads one flat action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub enum TreeRequest {
	/// Copies the session, whole, into a new session and opens the copy.
	/// Refused while a turn is streaming.
	ForkSession { session: SessionId },
	/// Asks for the session's entry tree, answered with a `SessionTree`
	/// section.
	LoadSessionTree { session: SessionId },
	/// Moves the session's leaf to `entry`, so the next prompt continues
	/// from there. `summarize` records a summary of the branch left behind,
	/// steered by `instructions` when given. Refused while a turn is
	/// streaming; answered with the session's transcript and a fresh
	/// `SessionTree`.
	NavigateTree {
		session:      SessionId,
		entry:        EntryId,
		summarize:    bool,
		instructions: Option<String>,
	},
	/// Stops the branch summary a pending `NavigateTree` is writing, which
	/// fails that navigation and leaves the leaf where it was.
	AbortBranchSummary { session: SessionId },
	/// Sets the label on `entry`, or clears it when `label` is `None`, and
	/// answers with a fresh `SessionTree`.
	SetEntryLabel { session: SessionId, entry: EntryId, label: Option<String> },
}

impl TreeRequest {
	/// Resolves the discriminant kind for this request.
	#[must_use]
	pub const fn kind(&self) -> HostActionKind {
		match self {
			Self::ForkSession { .. } => HostActionKind::ForkSession,
			Self::LoadSessionTree { .. } => HostActionKind::LoadSessionTree,
			Self::NavigateTree { .. } => HostActionKind::NavigateTree,
			Self::AbortBranchSummary { .. } => HostActionKind::AbortBranchSummary,
			Self::SetEntryLabel { .. } => HostActionKind::SetEntryLabel,
		}
	}
}
