//! The session index and the active session's header: the two snapshot
//! sections that write the queue's own rows rather than a domain view.

use std::collections::HashSet;

use crate::{
	connection::SessionId,
	event::SessionSummary,
	session::{QueuePartition, Session},
	store::Store,
};

/// Reduces the host's session index, which is every session the host holds.
///
/// The partition a session sits in, the park, defer and pin timestamps, and the
/// anchor those set are the client's state: the operator parks a session here
/// and the host is never told. A re-listing therefore updates what the file
/// says about a session already held and leaves the rest of it alone.
/// Rebuilding each session from the summary instead returns every parked,
/// deferred and pinned session to `Live` the next time any session is created,
/// renamed or deleted, since each of those sends the whole index again.
///
/// The status and the last write are what the file says, so a re-listing takes
/// both: they are the row badge's inputs (`badge::session_badge`) and neither
/// orders a partition. The read mark moves with them for the session the
/// operator has open and for one seen for the first time, so a turn that ends
/// under the operator's eyes raises no attention and attaching to a host
/// holding finished sessions raises none either.
///
/// A session the index no longer lists is gone with its file and is dropped,
/// along with the transcript held for it. Dropping the one the window is on
/// also clears the active pointer, so nothing addresses a session the host no
/// longer holds.
pub(super) fn reduce_session_index(store: &mut Store, summaries: Vec<SessionSummary>) {
	let active = store.persisted.shell.active_session.clone();
	let mut listed: HashSet<SessionId> = HashSet::with_capacity(summaries.len());
	for summary in summaries {
		let id = summary.id.clone();
		listed.insert(id.clone());
		let title = summary
			.title
			.filter(|t| !t.trim().is_empty())
			.unwrap_or_else(|| "new session".to_string());
		if let Some(known) = store.sessions.get_mut(&id) {
			// Live anchor re-anchors on unpark, recall and pin alone (§5.2).
			known.title = title;
			known.project_name = summary.workspace;
			known.status = summary.status;
			known.modified_at_ms = summary.modified_at_ms;
			known.path = summary.path;
			known.parent_path = summary.parent_path;
			if active.as_ref() == Some(&id) {
				known.read_mark_ms = Some(summary.modified_at_ms);
			}
			continue;
		}
		store.sessions.insert(Session {
			id,
			title,
			project_name: summary.workspace,
			branch: String::new(),
			partition: QueuePartition::Live,
			status: summary.status,
			created_at_ms: summary.created_at_ms,
			modified_at_ms: summary.modified_at_ms,
			read_mark_ms: Some(summary.modified_at_ms),
			last_recall_at_ms: summary.modified_at_ms,
			defer_until_ms: None,
			parked_at_ms: None,
			pin_key: None,
			path: summary.path,
			parent_path: summary.parent_path,
		});
	}

	let dropped: Vec<SessionId> = store
		.sessions
		.items
		.iter()
		.filter(|(id, _)| !listed.contains(*id))
		.map(|(id, _)| id.clone())
		.collect();
	for id in dropped {
		store.sessions.remove(&id);
		store.transcripts.remove(&id);
		// A session the host no longer holds cannot be the one the window is
		// on: leaving the pointer would address a deleted session with the
		// next prompt and file the next transcript under it.
		if store.persisted.shell.active_session.as_ref() == Some(&id) {
			store.persisted.shell.active_session = None;
		}
	}
}

/// Applies the active session's own header to the row the queue draws.
///
/// The header is the only section that reports a rename of the open session:
/// the host re-sends the whole index on create, rename and delete, but a title
/// the model authored mid-turn arrives here first, and dropping it left the
/// titlebar and the rail on the previous name until the next listing.
///
/// The title is all it carries that the queue draws. The index is the sole
/// authority on which sessions exist and on the workspace name, so a header
/// naming a session the index has not listed yet selects it and adds no row;
/// the listing that follows brings one. `created_at_ms` anchors the Live order
/// and §5.2 re-anchors on unpark, recall and pin alone, so it is not read here
/// for the same reason `reduce_session_index` does not re-read it.
///
/// Opening a session reads it: the header arrives when the operator opens one,
/// so the read mark takes the last write the index reported and the `Done`,
/// `Due` and `Failed` badges (§0) come off the row.
pub(super) fn reduce_active_header(store: &mut Store, id: &SessionId, title: Option<String>) {
	let Some(known) = store.sessions.get_mut(id) else {
		return;
	};
	known.title = title
		.filter(|t| !t.trim().is_empty())
		.unwrap_or_else(|| "new session".to_string());
	known.read_mark_ms = Some(known.modified_at_ms);
}
