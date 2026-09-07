//! Per-session scroll offset and block expansion persistence (§5.2, §5.3).

use std::collections::{HashMap, HashSet};

use veyyon_gpui::ListOffset;

/// Stable key identifying a block within a specific turn: `(turn_ix,
/// block_ix)`.
pub type BlockKey = (usize, usize);

/// Store managing retained scroll positions and expanded block states across
/// sessions.
#[derive(Debug, Default, Clone)]
pub struct SessionTranscriptStore {
	session_offsets:         HashMap<u64, ListOffset>,
	session_expanded_blocks: HashMap<u64, HashSet<BlockKey>>,
}

impl SessionTranscriptStore {
	/// Creates an empty session store.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Saves the scroll offset and expanded state for a session.
	pub fn save_session(
		&mut self,
		session_id: u64,
		offset: ListOffset,
		expanded_blocks: HashSet<BlockKey>,
	) {
		self.session_offsets.insert(session_id, offset);
		self
			.session_expanded_blocks
			.insert(session_id, expanded_blocks);
	}

	/// Restores the saved scroll offset and expanded states for a session.
	#[must_use]
	pub fn restore_session(&self, session_id: u64) -> (Option<ListOffset>, HashSet<BlockKey>) {
		let offset = self.session_offsets.get(&session_id).copied();
		let blocks = self
			.session_expanded_blocks
			.get(&session_id)
			.cloned()
			.unwrap_or_default();
		(offset, blocks)
	}
}
