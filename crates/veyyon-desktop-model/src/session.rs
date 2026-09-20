//! Session record and partitioned queue index models.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::{connection::SessionId, event::SessionStatus};

pub mod enums;

pub use self::enums::*;

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
	pub path:              String,
	pub parent_path:       Option<String>,
}

impl Session {
	/// Anchor timestamp for `Live` partition ordering.
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
				self.live = self.forest_order_ids(&self.live);
			},
			QueuePartition::Pinned => {
				let items = &self.items;
				self.pinned.sort_by(|a, b| {
					let key_a = items.get(a).and_then(|s| s.pin_key.as_deref());
					let key_b = items.get(b).and_then(|s| s.pin_key.as_deref());
					key_a.cmp(&key_b).then_with(|| a.cmp(b))
				});
				self.pinned = self.forest_order_ids(&self.pinned);
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
				self.deferred = self.forest_order_ids(&self.deferred);
			},
			QueuePartition::Parked => {
				let items = &self.items;
				self.parked.sort_by(|a, b| {
					let parked_a = items.get(a).and_then(|s| s.parked_at_ms).unwrap_or(0);
					let parked_b = items.get(b).and_then(|s| s.parked_at_ms).unwrap_or(0);
					parked_b.cmp(&parked_a).then_with(|| a.cmp(b))
				});
				self.parked = self.forest_order_ids(&self.parked);
			},
		}
	}

	/// Orders sessions into a forest based on `parent_path`, preserving sibling
	/// sort.
	#[must_use]
	pub fn forest_order_ids(&self, ids: &[SessionId]) -> Vec<SessionId> {
		if ids.len() <= 1 {
			return ids.to_vec();
		}
		let mut path_to_idx = HashMap::with_capacity(ids.len());
		for (idx, id) in ids.iter().enumerate() {
			if let Some(s) = self.items.get(id)
				&& !s.path.is_empty()
			{
				path_to_idx.entry(s.path.as_str()).or_insert(idx);
			}
		}
		let mut parent_of = vec![None; ids.len()];
		for (idx, id) in ids.iter().enumerate() {
			let Some(s) = self.items.get(id) else {
				continue;
			};
			let Some(p) = &s.parent_path else { continue };
			if p.is_empty() {
				continue;
			}
			let Some(&p_idx) = path_to_idx.get(p.as_str()) else {
				continue;
			};
			if p_idx == idx {
				continue;
			}
			let (mut curr, mut cycle, mut visited) = (p_idx, false, HashSet::new());
			visited.insert(idx);
			while let Some(cs) = self.items.get(&ids[curr]) {
				if !visited.insert(curr) {
					cycle = true;
					break;
				}
				let Some(next_p) = &cs.parent_path else { break };
				let Some(&next_idx) = path_to_idx.get(next_p.as_str()) else {
					break;
				};
				curr = next_idx;
			}
			if !cycle {
				parent_of[idx] = Some(p_idx);
			}
		}
		let mut kids: HashMap<usize, Vec<usize>> = HashMap::new();
		let mut roots = Vec::new();
		for (idx, p) in parent_of.iter().enumerate() {
			match p {
				Some(parent) => kids.entry(*parent).or_default().push(idx),
				None => roots.push(idx),
			}
		}
		let mut out = Vec::with_capacity(ids.len());
		fn dfs(
			n: usize,
			kids: &HashMap<usize, Vec<usize>>,
			ids: &[SessionId],
			out: &mut Vec<SessionId>,
		) {
			out.push(ids[n].clone());
			if let Some(children) = kids.get(&n) {
				for &k in children {
					dfs(k, kids, ids, out);
				}
			}
		}
		for r in roots {
			dfs(r, &kids, ids, &mut out);
		}
		out
	}

	/// Moves session to `Live` from `Parked`, re-anchoring with `now_ms`.
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

	/// Moves session to `Live` from `Deferred`, re-anchoring with `now_ms`.
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

	/// Moves session into `Pinned` with optional sort key.
	pub fn pin(&mut self, id: &SessionId, pin_key: Option<String>) {
		if let Some(session) = self.items.get_mut(id) {
			session.partition = QueuePartition::Pinned;
			session.pin_key = pin_key;
		}
		self.remove_from_all_lists(id);
		self.pinned.push(id.clone());
		self.reindex_partition(QueuePartition::Pinned);
	}

	/// Moves session from `Pinned` to `Live`, re-anchoring with `now_ms`.
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

	/// Moves session into `Deferred`, returning at `until_ms` when known.
	pub fn defer(&mut self, id: &SessionId, until_ms: Option<u64>) {
		if let Some(session) = self.items.get_mut(id) {
			session.partition = QueuePartition::Deferred;
			session.defer_until_ms = until_ms;
		}
		self.remove_from_all_lists(id);
		self.deferred.push(id.clone());
		self.reindex_partition(QueuePartition::Deferred);
	}

	/// Moves session into `Parked` recorded with `now_ms`.
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
