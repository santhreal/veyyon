//! The client transcript cache: the display order and last revision of the
//! most recently used sessions.

use std::collections::{HashMap, VecDeque};

use veyyon_desktop_model::SessionId;

use super::flat::DisplayOrder;

/// Sessions whose transcripts the client keeps. Opening a cached session
/// renders it at once, before the host answers.
pub const TRANSCRIPT_CACHE_SESSIONS: usize = 8;

/// What the client keeps of one session's transcript.
#[derive(Debug, Default)]
pub struct Cached {
	/// The active branch in display order.
	pub order:    DisplayOrder,
	/// The newest transcript revision the host sent for the session, or
	/// `None` before the first.
	pub revision: Option<u64>,
}

/// A least-recently-used set of [`Cached`] transcripts bounded by
/// [`TRANSCRIPT_CACHE_SESSIONS`].
#[derive(Debug, Default)]
pub struct TranscriptCache {
	entries: HashMap<SessionId, Cached>,
	/// Most recent first.
	recency: VecDeque<SessionId>,
}

impl TranscriptCache {
	/// The cached transcript of `session`.
	pub fn get(&self, session: &SessionId) -> Option<&Cached> {
		self.entries.get(session)
	}

	/// The cached transcript of `session`, for an update.
	pub fn get_mut(&mut self, session: &SessionId) -> Option<&mut Cached> {
		self.entries.get_mut(session)
	}

	/// Marks `session` most recently used, creating an empty entry for it,
	/// and returns the session evicted to stay within capacity.
	///
	/// `keep` is never evicted: it is the session on screen.
	pub fn touch(&mut self, session: &SessionId, keep: Option<&SessionId>) -> Option<SessionId> {
		match self.recency.iter().position(|held| held == session) {
			Some(0) => {},
			Some(ix) => {
				if let Some(held) = self.recency.remove(ix) {
					self.recency.push_front(held);
				}
			},
			None => {
				self.recency.push_front(session.clone());
				self.entries.insert(session.clone(), Cached::default());
			},
		}
		if self.recency.len() <= TRANSCRIPT_CACHE_SESSIONS {
			return None;
		}
		let victim = self
			.recency
			.iter()
			.rposition(|held| held != session && Some(held) != keep)?;
		let evicted = self.recency.remove(victim)?;
		self.entries.remove(&evicted);
		Some(evicted)
	}
}
