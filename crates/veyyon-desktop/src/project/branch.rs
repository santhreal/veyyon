//! The prompt a branch forks at (§5.1).
//!
//! A branch cuts the transcript above a prompt, so that prompt is on no branch
//! afterwards: the fork keeps the entries before it and the source session
//! keeps the rest. The window names the entry it forks at and hands its text
//! back to the composer, which is what makes a branch an edit of that prompt
//! rather than the loss of it.
//!
//! Two controls cut a fork, and both name their own entry. A row menu's
//! `Branch` forks at the last prompt of that row's session, which is the
//! session as a whole read from the rail. A turn menu's `Branch from here`
//! forks at the prompt that turn holds, which is how a road not taken is
//! reached from the turn that took the other one: the host accepts any entry
//! on the branch, and until the window could name one the operator could only
//! fork at the end however far back they had read.
//!
//! The entry and the text are read from one walk, so the entry the host is
//! given is the entry whose words come back. The walk is the projection's own
//! `turns`, so the prompt handed back reads exactly as the transcript drew it.
//! The words are then kept until the host settles the fork, because by then
//! the transcript in front of the operator is the fork's own and a second
//! reading would answer with a different prompt.

use veyyon_desktop_model::{EntryId, SessionId, Store, SurfaceId, TranscriptTree};
use veyyon_desktop_surface::Turn;

use super::transcript::{Turns, turns};
use crate::state::record_draft;

/// The entry a branch forks at and the prompt recorded in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchPoint {
	/// The transcript entry holding the prompt the fork cuts.
	pub entry:  EntryId,
	/// That prompt's text, as the transcript states it.
	pub prompt: String,
}

/// The prompt one turn of a walked transcript holds.
///
/// `None` for an agent turn: a reply is no entry a fork can be cut at, and a
/// branch named at one is a branch the host refuses.
fn point_in(walked: &Turns, index: usize) -> Option<BranchPoint> {
	match walked.turns.get(index)? {
		Turn::Operator(text) | Turn::OperatorArtifacts { text, .. } => {
			let entry = EntryId(walked.anchors.get(index)?.clone());
			Some(BranchPoint { entry, prompt: text.clone() })
		},
		Turn::Agent { .. } => None,
	}
}

/// The last prompt on a transcript's active branch.
///
/// `None` for a transcript the window has not loaded and for one the operator
/// has said nothing in: the host then picks the entry itself, which is the
/// same choice made one end further away.
#[must_use]
pub fn branch_point_of(tree: &TranscriptTree) -> Option<BranchPoint> {
	let walked = turns(tree);
	(0..walked.turns.len())
		.rev()
		.find_map(|index| point_in(&walked, index))
}

/// The last prompt of a session the window holds a transcript for.
#[must_use]
pub fn branch_point(store: &Store, session: &SessionId) -> Option<BranchPoint> {
	store.transcripts.get(session).and_then(branch_point_of)
}

/// The prompt the turn at `index` holds, for a fork cut at that turn.
///
/// The index is the transcript's own, which is the index the frame recorded
/// its boxes under, so the turn the operator pressed is the turn the fork is
/// cut at. `None` for an index no turn was drawn for and for a turn that is
/// not a prompt.
#[must_use]
pub fn branch_point_at(store: &Store, session: &SessionId, index: usize) -> Option<BranchPoint> {
	let tree = store.transcripts.get(session)?;
	point_in(&turns(tree), index)
}

/// Remembers the prompt a fork the window has just named cut, under the row
/// whose control asked for it.
///
/// The row is the key because that is what the request registers under, and
/// what the settled request hands back here.
pub fn record_fork(store: &mut Store, row: u64, point: &BranchPoint) {
	store
		.forks
		.insert(SessionId::from(row.to_string()), point.prompt.clone());
}

/// The prompt a settled branch hands back to the composer.
///
/// Read from what the fork recorded when it was named rather than from the
/// transcript: a turn fork and a row fork cut different prompts out of the
/// same session, and by the time the host settles either one the drawn
/// transcript is the fork's own.
#[must_use]
pub fn branched_draft<'a>(store: &'a Store, surface: &SurfaceId) -> Option<&'a String> {
	let SurfaceId::SessionBranchButton(row) = surface else {
		return None;
	};
	store.forks.get(row)
}

/// Puts the prompt a settled branch handed back where the window will draw it.
///
/// A fork moves the session pointer, and the keeper reads the drawn window's
/// shape as the outgoing session's before it restores the incoming one's, so
/// a prompt written straight into the editor is recorded against the session
/// the fork was cut from and then drawn over with the fork's empty draft. It
/// is written as the fork's own draft instead, and the keeper's own restore
/// puts it in the composer.
///
/// A window that remembers nothing has no such restore, so the words are
/// handed back for the caller to put in the editor itself. That is the whole
/// meaning of the returned value: `None` is a prompt already landed, or no
/// branch at all.
pub fn land_branched_draft(
	store: &mut Store,
	surface: &SurfaceId,
	remembered: bool,
) -> Option<String> {
	let SurfaceId::SessionBranchButton(row) = surface else {
		return None;
	};
	let text = store.forks.remove(row)?;
	if !remembered {
		return Some(text);
	}
	let session = store.persisted.shell.active_session.clone()?;
	record_draft(&mut store.persisted, &session, &text);
	None
}
