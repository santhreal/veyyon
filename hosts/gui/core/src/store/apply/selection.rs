//! Session selection adoption after a session index or active-session change.
//!
//! Selection is frontend state, but the set it points into is engine-owned, so
//! every arrival of that set has to reconcile the two. Without this the shell
//! draws "Select a session" beside a populated conversation list, and a
//! selection that names a deleted session keeps addressing it.

use super::Store;
use crate::model::SessionSummary;

impl Store {
	/// Reconcile the selected session with the session index.
	///
	/// Returns whether the selection changed. Called after the index or the
	/// active session arrives, and after a deletion removes rows.
	pub(crate) fn adopt_session_selection(&mut self) -> bool {
		let Some(sessions) = self.replica.sessions.sessions.readable() else {
			return false;
		};
		let sessions = &sessions.value;
		if let Some(selected) = self.frontend.selected_session.as_ref() {
			if sessions.iter().any(|session| &session.id == selected) {
				return false;
			}
			self.frontend.selected_session = None;
		}
		let adopted = self
			.replica
			.active_session
			.readable()
			.map(|active| active.value.id.clone())
			.filter(|id| sessions.iter().any(|session| &session.id == id))
			.or_else(|| most_recent(sessions).map(|session| session.id.clone()));
		if adopted.is_none() {
			return false;
		}
		self.frontend.selected_session = adopted;
		true
	}
}

/// The session a user last worked in, which is the one to open unread.
fn most_recent(sessions: &[SessionSummary]) -> Option<&SessionSummary> {
	sessions
		.iter()
		.max_by_key(|session| (session.modified_at_ms, session.created_at_ms))
}
