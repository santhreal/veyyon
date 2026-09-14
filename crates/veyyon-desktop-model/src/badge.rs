//! The row badge every queue row draws, derived from the state the host sent.
//!
//! WHY: `Session::badge` was a field only a scene fixture ever wrote. The
//! reducer set it to `None` on every listing and no other site ever set it, so
//! a session whose turn was running, whose question was waiting, or whose turn
//! ended in an error drew a bare row, while the eight badge variants, their
//! row states (§5.2) and their tints (§6) sat in the renderer unreachable. The
//! badge is a projection of host state, so it is derived here and stored
//! nowhere.
//!
//! Precedence is §0's table: `Approval`, `Input`, `Plan`, `Failed`, `Due`,
//! `Done`, `Working`, `Watching`, resolved to one badge per row. A turn in
//! flight is the one exception: it suppresses `Failed` and `Done`, which read
//! the status of a file written before the stream started, and leaves every
//! other place in the table alone.
//!
//! Two conditions in that table say `has not been read`. Nothing in the
//! protocol reports what the operator has read, so the client owns it: a
//! session carries the `modified_at_ms` it had when it was last opened
//! (`Session::read_mark_ms`), and a listing that reports a newer one is
//! unread. A session is marked read when it is first listed as well as when it
//! is opened, so attaching to a host that holds four hundred finished sessions
//! raises no attention on any of them.
//!
//! `Failed` carries the same unread condition, which §0's table states for
//! `Done` and `Due` alone. A session's status is the status of its file: an
//! error from last week is `Error` forever, so reading the table literally
//! puts a permanent attention strip on every session that ever failed. The
//! deviation is deliberate and `Failed` still outranks `Done`.
//!
//! What this does not derive: `Watching` for a session that is not open. A
//! supervised process belongs to the broker for the whole project directory
//! and is shared by every client in it (`ProcessView` carries no session), so
//! attributing one to a row would be a guess. The open session is the one
//! whose drawer shows those processes, and it is the only row that reports
//! them.

use crate::{
	connection::SessionId,
	domain::ProcessView,
	event::SessionStatus,
	session::{QueuePartition, Session, SessionBadge},
	store::Store,
	transcript::MessageRole,
};

/// The badge for one session, or `None` when it needs no attention and has
/// nothing in flight.
#[must_use]
pub fn session_badge(store: &Store, id: &SessionId, now_ms: u64) -> Option<SessionBadge> {
	let session = store.sessions.get(id)?;
	if let Some(pending) = store.interactions.get(id) {
		if !pending.approvals.is_empty() {
			return Some(SessionBadge::Approval);
		}
		if !pending.questions.is_empty() {
			return Some(SessionBadge::Input);
		}
		if !pending.plans.is_empty() {
			return Some(SessionBadge::Plan);
		}
	}

	// §0's order, with one exception it states the reason for: a turn in
	// flight suppresses `Failed` and `Done`, which are read from the status of
	// a file written before the stream started. The file says `Complete` while
	// the host is streaming into it, and the stream is the newer report. The
	// badges that do not contradict a running turn keep their places, so an
	// elapsed deferral still outranks it.
	let running = is_running(store, id, session);
	let unread = session
		.read_mark_ms
		.is_none_or(|mark| session.modified_at_ms > mark);
	if !running && unread && session.status == SessionStatus::Error {
		return Some(SessionBadge::Failed);
	}
	if session.partition == QueuePartition::Deferred
		&& session
			.defer_until_ms
			.is_some_and(|until_ms| until_ms <= now_ms)
	{
		return Some(SessionBadge::Due);
	}
	if !running && unread && is_finished(session.status) {
		return Some(SessionBadge::Done);
	}
	if running {
		return Some(SessionBadge::Working { started_at_ms: turn_started_at_ms(store, id, session) });
	}
	if store.persisted.shell.active_session.as_ref() == Some(id)
		&& store.domains.processes.iter().any(ProcessView::is_alive)
	{
		return Some(SessionBadge::Watching);
	}
	None
}

/// Whether a turn is running: a stream the host is sending for this session,
/// or a session the index reports as awaiting its reply.
fn is_running(store: &Store, id: &SessionId, session: &Session) -> bool {
	store.streaming.contains_key(id) || session.status == SessionStatus::Pending
}

/// When the running turn started, which the `Working` badge counts up from.
///
/// The operator's own message is what starts a turn, so its timestamp is the
/// elapsed time's origin. `modified_at_ms` is the fallback for a session whose
/// transcript this client has not loaded, being the last write to its file.
fn turn_started_at_ms(store: &Store, id: &SessionId, session: &Session) -> u64 {
	store
		.transcripts
		.get(id)
		.and_then(|tree| {
			tree
				.entries
				.values()
				.filter(|entry| entry.role == MessageRole::User)
				.map(|entry| entry.timestamp_ms)
				.max()
		})
		.unwrap_or(session.modified_at_ms)
}

/// Whether a status is a turn that ended, as opposed to one still owed a reply.
const fn is_finished(status: SessionStatus) -> bool {
	matches!(status, SessionStatus::Complete | SessionStatus::Interrupted | SessionStatus::Aborted)
}
