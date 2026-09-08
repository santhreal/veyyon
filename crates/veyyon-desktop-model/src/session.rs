use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::{connection::SessionId, event::SessionStatus};

/// The partition the operator put a session in.
///
/// Four, not the five sections the rail draws: `Unsent` is derived from the
/// draft a session holds (§0) and is never a placement, so it is not a state a
/// session can be moved into. `project::queue` states which sessions it covers
/// and the rail draws it above these four.
#[derive(
	Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, strum::EnumIter,
)]
pub enum QueuePartition {
	Pinned,
	Live,
	Deferred,
	Parked,
}

impl QueuePartition {
	/// Complete slice of all four placements.
	pub const ALL: [Self; 4] = [Self::Pinned, Self::Live, Self::Deferred, Self::Parked];
}

/// Status badges indicating operational state or required operator attention.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, strum::EnumDiscriminants)]
#[strum_discriminants(name(BadgeKind), derive(Hash, PartialOrd, Ord, strum::EnumIter))]
#[strum_discriminants(
	doc = "Fieldless projection of `SessionBadge`, so a scene gate can sweep every badge."
)]
pub enum SessionBadge {
	Approval,
	Input,
	Plan,
	Failed,
	Due,
	Done,
	Working { started_at_ms: u64 },
	Watching,
}

/// Individual session metadata and partition placement state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
	pub id:                SessionId,
	pub title:             String,
	pub project_name:      String,
	pub branch:            String,
	pub partition:         QueuePartition,
	/// The status the host's index reports for the session's file, which the
	/// row badge is derived from (`badge::session_badge`).
	pub status:            SessionStatus,
	pub created_at_ms:     u64,
	/// The last write to the session's file, as the index reports it.
	pub modified_at_ms:    u64,
	/// The `modified_at_ms` the session had when the operator last had it
	/// open. A listing that reports a newer one is unread, which is what §0's
	/// `Done`, `Due` and `Failed` badges test.
	pub read_mark_ms:      Option<u64>,
	pub last_recall_at_ms: u64,
	pub defer_until_ms:    Option<u64>,
	pub parked_at_ms:      Option<u64>,
	pub pin_key:           Option<String>,
}

impl Session {
	/// Computes the ordering anchor timestamp for this session in the `Live`
	/// partition.
	#[must_use]
	pub fn live_anchor(&self) -> u64 {
		self.created_at_ms.max(self.last_recall_at_ms)
	}
}

/// Container holding all sessions indexed by identifier and partitioned across
/// the four placements.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionCollection {
	pub items:    HashMap<SessionId, Session>,
	pub pinned:   Vec<SessionId>,
	pub live:     Vec<SessionId>,
	pub deferred: Vec<SessionId>,
	pub parked:   Vec<SessionId>,
}

impl SessionCollection {
	/// Creates an empty session collection.
	#[must_use]
	pub fn new() -> Self {
		Self {
			items:    HashMap::new(),
			pinned:   Vec::new(),
			live:     Vec::new(),
			deferred: Vec::new(),
			parked:   Vec::new(),
		}
	}

	/// Inserts or updates a session, adding its identifier to the designated
	/// partition list.
	pub fn insert(&mut self, session: Session) {
		let id = session.id.clone();
		let partition = session.partition;
		self.items.insert(id.clone(), session);

		self.remove_from_all_lists(&id);
		match partition {
			QueuePartition::Pinned => self.pinned.push(id),
			QueuePartition::Live => self.live.push(id),
			QueuePartition::Deferred => self.deferred.push(id),
			QueuePartition::Parked => self.parked.push(id),
		}
		self.reindex_partition(partition);
	}

	/// Retrieves a session by its identifier.
	#[must_use]
	pub fn get(&self, id: &SessionId) -> Option<&Session> {
		self.items.get(id)
	}

	/// Retrieves a mutable reference to a session by its identifier.
	#[must_use]
	pub fn get_mut(&mut self, id: &SessionId) -> Option<&mut Session> {
		self.items.get_mut(id)
	}

	/// Removes a session from the collection and all partition lists.
	pub fn remove(&mut self, id: &SessionId) -> Option<Session> {
		self.remove_from_all_lists(id);
		self.items.remove(id)
	}

	/// Reindexes a partition according to its invariant sorting rules.
	pub fn reindex_partition(&mut self, partition: QueuePartition) {
		match partition {
			QueuePartition::Live => {
				let items = &self.items;
				self.live.sort_by(|a, b| {
					let anchor_a = items.get(a).map_or(0, Session::live_anchor);
					let anchor_b = items.get(b).map_or(0, Session::live_anchor);
					anchor_b.cmp(&anchor_a).then_with(|| a.cmp(b))
				});
			},
			QueuePartition::Pinned => {
				let items = &self.items;
				self.pinned.sort_by(|a, b| {
					let key_a = items.get(a).and_then(|s| s.pin_key.as_deref());
					let key_b = items.get(b).and_then(|s| s.pin_key.as_deref());
					key_a.cmp(&key_b).then_with(|| a.cmp(b))
				});
			},
			QueuePartition::Deferred => {
				let items = &self.items;
				self.deferred.sort_by(|a, b| {
					let until_a = items
						.get(a)
						.and_then(|s| s.defer_until_ms)
						.unwrap_or(u64::MAX);
					let until_b = items
						.get(b)
						.and_then(|s| s.defer_until_ms)
						.unwrap_or(u64::MAX);
					until_a.cmp(&until_b).then_with(|| a.cmp(b))
				});
			},
			QueuePartition::Parked => {
				let items = &self.items;
				self.parked.sort_by(|a, b| {
					let parked_a = items.get(a).and_then(|s| s.parked_at_ms).unwrap_or(0);
					let parked_b = items.get(b).and_then(|s| s.parked_at_ms).unwrap_or(0);
					parked_b.cmp(&parked_a).then_with(|| a.cmp(b))
				});
			},
		}
	}

	/// Moves a session from `Parked` to `Live`, re-anchoring with the provided
	/// timestamp.
	pub fn unpark(&mut self, id: &SessionId, now_ms: u64) {
		if let Some(session) = self.items.get_mut(id) {
			session.partition = QueuePartition::Live;
			session.last_recall_at_ms = now_ms;
			session.parked_at_ms = None;
		}
		self.remove_from_all_lists(id);
		self.live.push(id.clone());
		self.reindex_partition(QueuePartition::Live);
		self.reindex_partition(QueuePartition::Parked);
	}

	/// Moves a session from `Deferred` to `Live`, re-anchoring with the provided
	/// timestamp.
	pub fn recall(&mut self, id: &SessionId, now_ms: u64) {
		if let Some(session) = self.items.get_mut(id) {
			session.partition = QueuePartition::Live;
			session.last_recall_at_ms = now_ms;
			session.defer_until_ms = None;
		}
		self.remove_from_all_lists(id);
		self.live.push(id.clone());
		self.reindex_partition(QueuePartition::Live);
		self.reindex_partition(QueuePartition::Deferred);
	}

	/// Moves a session into `Pinned` with an optional sort key.
	pub fn pin(&mut self, id: &SessionId, pin_key: Option<String>) {
		if let Some(session) = self.items.get_mut(id) {
			session.partition = QueuePartition::Pinned;
			session.pin_key = pin_key;
		}
		self.remove_from_all_lists(id);
		self.pinned.push(id.clone());
		self.reindex_partition(QueuePartition::Pinned);
	}

	/// Moves a session from `Pinned` to `Live`, re-anchoring with the provided
	/// timestamp.
	pub fn unpin(&mut self, id: &SessionId, now_ms: u64) {
		if let Some(session) = self.items.get_mut(id) {
			session.partition = QueuePartition::Live;
			session.last_recall_at_ms = now_ms;
			session.pin_key = None;
		}
		self.remove_from_all_lists(id);
		self.live.push(id.clone());
		self.reindex_partition(QueuePartition::Live);
		self.reindex_partition(QueuePartition::Pinned);
	}

	/// Moves a session into `Deferred`, returning at `until_ms` when one is
	/// known.
	///
	/// A deferral with no return time sorts after every dated one, which is
	/// what `soonest return first` means for a session that names no time
	/// (§5.2). Recording an arbitrary one instead would show a due deferral
	/// the operator never asked for.
	pub fn defer(&mut self, id: &SessionId, until_ms: Option<u64>) {
		if let Some(session) = self.items.get_mut(id) {
			session.partition = QueuePartition::Deferred;
			session.defer_until_ms = until_ms;
		}
		self.remove_from_all_lists(id);
		self.deferred.push(id.clone());
		self.reindex_partition(QueuePartition::Deferred);
	}

	/// Moves a session into `Parked` recorded with the current timestamp.
	pub fn park(&mut self, id: &SessionId, now_ms: u64) {
		if let Some(session) = self.items.get_mut(id) {
			session.partition = QueuePartition::Parked;
			session.parked_at_ms = Some(now_ms);
		}
		self.remove_from_all_lists(id);
		self.parked.push(id.clone());
		self.reindex_partition(QueuePartition::Parked);
	}

	fn remove_from_all_lists(&mut self, id: &SessionId) {
		self.pinned.retain(|x| x != id);
		self.live.retain(|x| x != id);
		self.deferred.retain(|x| x != id);
		self.parked.retain(|x| x != id);
	}
}
