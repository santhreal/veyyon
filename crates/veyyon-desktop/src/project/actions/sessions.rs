//! What one session's own management asks the host for.
//!
//! These are the answers a queue row's menu and the commands beside it send:
//! deleting a session, forking one, renaming, exporting, compacting, handing
//! off, and loading a transcript back. Each names the session it acts on by
//! the row it was taken on, falling back to the open session for a command
//! that names no row.

use veyyon_desktop_model::{HostAction, SessionId, Store};
use veyyon_desktop_surface::Intent;

use crate::project::{
	SessionIndex,
	branch::{branch_point, branch_point_at, record_fork},
};

/// The actions one session-management intent asks for, or `None` for an
/// intent this module does not own.
pub(super) fn session_actions(
	intent: &Intent,
	index: &SessionIndex,
	store: &mut Store,
	active: Option<&SessionId>,
) -> Option<Vec<HostAction>> {
	let actions = match intent {
		Intent::DeleteSession(row) => index.session_of(*row).map_or_else(Vec::new, |session| {
			vec![HostAction::DeleteSession { session: session.clone() }]
		}),
		// The window names the entry it forks at, so the prompt it hands back to
		// the composer is the prompt the fork actually cut. A transcript the
		// window has not loaded names none and the host picks the same entry
		// itself.
		Intent::BranchSession(row) => {
			index
				.session_of(*row)
				.cloned()
				.map_or_else(Vec::new, |session| {
					let point = branch_point(store, &session);
					if let Some(point) = point.as_ref() {
						record_fork(store, *row, point);
					}
					vec![HostAction::BranchSession { session, entry: point.map(|point| point.entry) }]
				})
		},
		// A fork cut at one turn names that turn's own prompt. The index is the
		// transcript's, which is what the frame recorded its boxes under, so a
		// press on a reply or on a turn no longer drawn asks for nothing rather
		// than forking at the end.
		Intent::BranchTurn(turn) => active
			.and_then(|session| {
				let row = index.row_id(session)?;
				let point = branch_point_at(store, session, *turn)?;
				Some((session.clone(), row, point))
			})
			.map_or_else(Vec::new, |(session, row, point)| {
				record_fork(store, row, &point);
				vec![HostAction::BranchSession { session, entry: Some(point.entry) }]
			}),
		Intent::RenameSession { session, title } => {
			index.session_of(*session).map_or_else(Vec::new, |s| {
				vec![HostAction::RenameSession { session: s.clone(), title: title.clone() }]
			})
		},
		Intent::ExportSession(row) => named(*row, index, active).map_or_else(Vec::new, |s| {
			vec![HostAction::ExportSession { session: s, format: "html".to_string() }]
		}),
		Intent::CompactSession(row) => named(*row, index, active)
			.map_or_else(Vec::new, |s| vec![HostAction::CompactSession { session: s }]),
		Intent::HandoffSession(row) => named(*row, index, active).map_or_else(Vec::new, |s| {
			vec![HostAction::HandoffSession { session: s, target: String::new() }]
		}),
		Intent::LoadTranscript(row) => named(*row, index, active)
			.map_or_else(Vec::new, |s| vec![HostAction::LoadTranscript { session: s, before: None }]),
		_ => return None,
	};
	Some(actions)
}

/// The session a command acts on: the row it was taken on, or the open one
/// for a command reached from the palette, which names no row.
fn named(row: Option<u64>, index: &SessionIndex, active: Option<&SessionId>) -> Option<SessionId> {
	row.and_then(|row| index.session_of(row))
		.or(active)
		.cloned()
}
