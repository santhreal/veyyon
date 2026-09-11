use std::collections::HashMap;

use crate::{
	capabilities::CapabilityMap,
	connection::{ConnectionState, SessionId},
	domain::{Domains, QueuedPrompts},
	interaction::PendingDecisions,
	notifications::NotificationQueue,
	persistence::PersistedState,
	retries::RetryMemory,
	session::{SessionCollection, SessionMode},
	streaming::StreamingMessageState,
	transcript::TranscriptTree,
};
/// Root state container for the desktop client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Store {
	/// Single definition of host transport connection status and handshake
	/// progress.
	pub connection:    ConnectionState,
	/// Single definition of backend feature availability across all thirty
	/// protocol capabilities.
	pub capabilities:  CapabilityMap,
	/// Single definition of all known sessions partitioned across the five queue
	/// segments.
	pub sessions:      SessionCollection,
	/// Single definition of transcript entry trees and node relationships
	/// indexed by session.
	pub transcripts:   HashMap<SessionId, TranscriptTree>,
	/// Single definition of in-flight assistant token generation and active tool
	/// progress.
	pub streaming:     HashMap<SessionId, StreamingMessageState>,
	/// Single definition of operator decision requests awaiting input, approval,
	/// or plan review.
	pub interactions:  HashMap<SessionId, PendingDecisions>,
	/// Single definition of the mode each session runs in, as the host stated
	/// it on that session's header.
	pub modes:         HashMap<SessionId, SessionMode>,
	/// Single definition of the prompts each session holds behind a running
	/// turn, as the host reported them.
	pub queued:        HashMap<SessionId, QueuedPrompts>,
	/// Single definition of layout, geometry, panel visibility, and local client
	/// persistence.
	pub persisted:     PersistedState,
	/// Single definition of all panel-domain views received from the host.
	pub domains:       Domains,
	/// Single definition of the request each control would send again after
	/// the host refused the one it sent.
	pub retries:       RetryMemory,
	/// Single definition of the announcements raised for something that
	/// happened out of view: a refused request, a protocol error, a decision
	/// waiting on a session that is not the open one.
	pub notifications: NotificationQueue,
	/// Single definition of the prompt each branch cut off the transcript it
	/// forked, keyed by the queue row whose control asked for the fork.
	///
	/// Written when the fork is named and read when the host settles it, so
	/// the words handed back to the composer are the words of the entry the
	/// window actually forked at rather than a second reading of a transcript
	/// the fork has since changed. A row forked twice keeps one entry, so the
	/// map is bounded by the rows that were forked.
	pub forks:         HashMap<SessionId, String>,
}

impl Default for Store {
	fn default() -> Self {
		Self::new()
	}
}

impl Store {
	/// Creates an initialized store with default sub-stores and detached
	/// connection state.
	#[must_use]
	pub fn new() -> Self {
		Self {
			connection:    ConnectionState::Detached,
			capabilities:  CapabilityMap::new(),
			sessions:      SessionCollection::new(),
			transcripts:   HashMap::new(),
			streaming:     HashMap::new(),
			interactions:  HashMap::new(),
			modes:         HashMap::new(),
			queued:        HashMap::new(),
			persisted:     PersistedState::new(),
			domains:       Domains::new(),
			retries:       RetryMemory::new(),
			notifications: NotificationQueue::new(),
			forks:         HashMap::new(),
		}
	}

	/// Creates a store whose persisted state is what the last window wrote.
	///
	/// The rest starts detached and empty: everything else in the store is the
	/// host's, and the window has not attached yet (§8.10).
	#[must_use]
	pub fn with_persisted(persisted: PersistedState) -> Self {
		Self { persisted, ..Self::new() }
	}
}
