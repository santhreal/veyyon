use std::collections::HashMap;

use crate::{
	capabilities::CapabilityMap,
	composer::ComposerDraft,
	connection::{ConnectionState, SessionId},
	domain::Domains,
	interaction::PendingDecisions,
	persistence::PersistedState,
	session::SessionCollection,
	streaming::StreamingMessageState,
	transcript::TranscriptTree,
};
/// Root state container for the desktop client.
#[derive(Debug, Clone, PartialEq)]
pub struct Store {
	/// Single definition of host transport connection status and handshake
	/// progress.
	pub connection:      ConnectionState,
	/// Single definition of backend feature availability across all thirty
	/// protocol capabilities.
	pub capabilities:    CapabilityMap,
	/// Single definition of all known sessions partitioned across the five queue
	/// segments.
	pub sessions:        SessionCollection,
	/// Single definition of transcript entry trees and node relationships
	/// indexed by session.
	pub transcripts:     HashMap<SessionId, TranscriptTree>,
	/// Single definition of in-flight assistant token generation and active tool
	/// progress.
	pub streaming:       HashMap<SessionId, StreamingMessageState>,
	/// Single definition of operator decision requests awaiting input, approval,
	/// or plan review.
	pub interactions:    HashMap<SessionId, PendingDecisions>,
	/// Single definition of unsubmitted input text, attachments, and turn
	/// dispatch modes.
	pub composer_drafts: HashMap<SessionId, ComposerDraft>,
	/// Single definition of layout, geometry, panel visibility, and local client
	/// persistence.
	pub persisted:       PersistedState,
	/// Single definition of all panel-domain views received from the host.
	pub domains:         Domains,
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
			connection:      ConnectionState::Detached,
			capabilities:    CapabilityMap::new(),
			sessions:        SessionCollection::new(),
			transcripts:     HashMap::new(),
			streaming:       HashMap::new(),
			interactions:    HashMap::new(),
			composer_drafts: HashMap::new(),
			persisted:       PersistedState::new(),
			domains:         Domains::new(),
		}
	}
}
