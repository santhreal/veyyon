//! The prompt a branch forks at (§5.1).
//!
//! A branch cuts the transcript above the operator's last prompt, so that
//! prompt is on no branch afterwards: the fork keeps the entries before it and
//! the source session keeps the rest. The window names the entry it forks at
//! and hands its text back to the composer, which is what makes a branch an
//! edit of that prompt rather than the loss of it.
//!
//! The entry and the text are read from one walk, so the entry the host is
//! given is the entry whose words come back. The walk is the projection's own
//! `turns`, so the prompt handed back reads exactly as the transcript drew it.

use veyyon_desktop_model::{EntryId, SessionId, Store, SurfaceId, TranscriptTree};
use veyyon_desktop_surface::Turn;

use super::{SessionIndex, turns};

/// The entry a branch forks at and the prompt recorded in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchPoint {
	/// The transcript entry holding the operator's last prompt.
	pub entry:  EntryId,
	/// That prompt's text, as the transcript states it.
	pub prompt: String,
}

/// The last prompt on a transcript's active branch.
///
/// `None` for a transcript the window has not loaded and for one the operator
/// has said nothing in: the host then picks the entry itself, which is the
/// same choice made one end further away.
#[must_use]
pub fn branch_point_of(tree: &TranscriptTree) -> Option<BranchPoint> {
	let turns = turns(tree);
	turns
		.turns
		.iter()
		.enumerate()
		.rev()
		.find_map(|(index, turn)| match turn {
			Turn::Operator(text) | Turn::OperatorArtifacts { text, .. } => {
				let entry = EntryId(turns.anchors.get(index)?.clone());
				Some(BranchPoint { entry, prompt: text.clone() })
			},
			Turn::Agent { .. } => None,
		})
}

/// The last prompt of a session the window holds a transcript for.
#[must_use]
pub fn branch_point(store: &Store, session: &SessionId) -> Option<BranchPoint> {
	store.transcripts.get(session).and_then(branch_point_of)
}

/// The prompt a settled branch hands back to the composer.
///
/// The request's own surface names the row that was forked, so the text comes
/// from the transcript that still holds it: the fork's own transcript has
/// already replaced the drawn one and the prompt is not in it. A row control's
/// surface is keyed by the row rather than the session, so the row is resolved
/// the same way the action that sent it was.
#[must_use]
pub fn branched_draft(store: &Store, index: &SessionIndex, surface: &SurfaceId) -> Option<String> {
	let SurfaceId::SessionBranchButton(row) = surface else {
		return None;
	};
	let session = index.session_of(row.0.parse().ok()?)?;
	branch_point(store, session).map(|point| point.prompt)
}
