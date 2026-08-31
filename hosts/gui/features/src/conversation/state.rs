//! Long-lived session-list identity and bounded collection reconciliation.

use gpui::ScrollHandle;
use veyyon_gui_core::model::{SessionId, SessionSummary};
use veyyon_gui_kit::motion::{
	CollectionItem, CollectionPlan, OwnerNamespace, RetainedKey, control, owner,
};

use super::logic::HISTORY_PAGE_ROWS;

/// What a conversation row is, in the namespace's table of names.
const ROW: &str = "session";

/// A control drawn against one conversation row, and the offset inside that
/// row's block it animates on. The sidebar row and the toolbar draw against the
/// same row, so they share one slot space.
///
/// One variant per control, so a new control cannot reuse another's track and
/// cannot silently exceed the block: `ControlSlot` is matched exhaustively in
/// `every_control_a_conversation_draws_animates_on_its_own_track`, which fails
/// to build until a new variant is listed there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum ControlSlot {
	/// Pin, on the sidebar row.
	Pin       = 1,
	/// Delete, on the sidebar row.
	RowDelete = 2,
	Rename    = 3,
	Branch    = 4,
	Export    = 5,
	Compact   = 6,
	Handoff   = 7,
	Delete    = 8,
}

impl ControlSlot {
	pub const ALL: [ControlSlot; 8] = [
		ControlSlot::Pin,
		ControlSlot::RowDelete,
		ControlSlot::Rename,
		ControlSlot::Branch,
		ControlSlot::Export,
		ControlSlot::Compact,
		ControlSlot::Handoff,
		ControlSlot::Delete,
	];

	/// The offset inside the row's block.
	pub const fn offset(self) -> u64 {
		self as u64
	}
}

pub struct SessionShelfState {
	pub scroll:      ScrollHandle,
	items:           Vec<CollectionItem>,
	history_visible: usize,
	plan:            CollectionPlan,
}

impl Default for SessionShelfState {
	fn default() -> Self {
		Self {
			scroll:          ScrollHandle::new(),
			items:           Vec::new(),
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
		let mut next = Vec::with_capacity(sessions.len());
		for (position, session) in sessions.iter().enumerate() {
			next.push(CollectionItem {
				owner:    Self::owner(&session.id),
				position: position as f32,
				selected: selected == Some(&session.id),
			});
		}
		self.plan = CollectionPlan::reconcile(&self.items, &next);
		self.items = next;
		&self.plan
	}

	/// The track this conversation's row animates on.
	pub fn owner(session: &SessionId) -> RetainedKey {
		owner(OwnerNamespace::Conversation, ROW, session.as_str())
	}

	/// The track this conversation's `slot` control animates on, inside the
	/// row's own block.
	pub fn control_owner(session: &SessionId, slot: ControlSlot) -> RetainedKey {
		control(OwnerNamespace::Conversation, ROW, session.as_str(), slot.offset() as u8)
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
