//! Long-lived session-list identity and bounded collection reconciliation.

use std::collections::BTreeMap;

use gpui::ScrollHandle;
use veyyon_gui_core::model::{SessionId, SessionSummary};
use veyyon_gui_kit::motion::{CollectionItem, CollectionPlan, OwnerNamespace, RetainedKey};

use super::logic::HISTORY_PAGE_ROWS;

pub struct SessionShelfState {
	pub scroll:      ScrollHandle,
	keys:            BTreeMap<SessionId, RetainedKey>,
	items:           Vec<CollectionItem>,
	next_object:     u64,
	history_visible: usize,
	plan:            CollectionPlan,
}

impl Default for SessionShelfState {
	fn default() -> Self {
		Self {
			scroll:          ScrollHandle::new(),
			keys:            BTreeMap::new(),
			items:           Vec::new(),
			next_object:     1,
			history_visible: HISTORY_PAGE_ROWS,
			plan:            CollectionPlan::default(),
		}
	}
}

impl SessionShelfState {
	/// Reconcile only when a session snapshot/filter order changes, never from a
	/// frame render. The returned plan contains at most twelve moving rows.
	pub fn reconcile(
		&mut self,
		sessions: &[SessionSummary],
		selected: Option<&SessionId>,
	) -> &CollectionPlan {
		self
			.keys
			.retain(|id, _| sessions.iter().any(|session| session.id == *id));
		for session in sessions {
			if !self.keys.contains_key(&session.id) {
				let local = 0x2000u64.saturating_add(self.next_object.saturating_mul(16));
				let key = RetainedKey::scoped(OwnerNamespace::Conversation, local, 0)
					.unwrap_or_else(|| RetainedKey::semantic(OwnerNamespace::Conversation, 0));
				self.next_object = self.next_object.saturating_add(1);
				self.keys.insert(session.id.clone(), key);
			}
		}
		let mut next = Vec::with_capacity(sessions.len());
		for (position, session) in sessions.iter().enumerate() {
			let owner = self
				.keys
				.get(&session.id)
				.copied()
				.unwrap_or_else(|| RetainedKey::semantic(OwnerNamespace::Conversation, 0));
			next.push(CollectionItem {
				owner,
				position: position as f32,
				selected: selected == Some(&session.id),
			});
		}
		self.plan = CollectionPlan::reconcile(&self.items, &next);
		self.items = next;
		&self.plan
	}

	pub fn owner(&self, session: &SessionId) -> Option<RetainedKey> {
		self.keys.get(session).copied()
	}

	pub fn control_owner(&self, session: &SessionId, slot: u8) -> Option<RetainedKey> {
		let row = self.owner(session)?;
		Some(RetainedKey::new(row.object.saturating_add(u64::from(slot)), row.generation))
	}

	pub const fn history_visible(&self) -> usize {
		self.history_visible
	}

	pub fn show_more_history(&mut self) {
		self.history_visible = self.history_visible.saturating_add(HISTORY_PAGE_ROWS);
	}

	pub const fn collection_plan(&self) -> &CollectionPlan {
		&self.plan
	}
}
