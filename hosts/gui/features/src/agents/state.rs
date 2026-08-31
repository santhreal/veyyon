//! Long-lived retained identity registry for agents, transcripts, and controls.

use veyyon_gui_core::model::AgentId;
use veyyon_gui_kit::motion::{OwnerNamespace, RetainedKey, control, owner as kit_owner};

/// A control drawn against one agent row, and the offset inside that row's
/// block it animates on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum ControlSlot {
	/// Expand / collapse toggle on an agent hierarchy row.
	Expand = 1,
	/// Send button on the agent chat composer.
	Chat   = 2,
	/// Kill button on the selected-agent detail panel.
	Kill   = 3,
	/// Revive button on the selected-agent detail panel.
	Revive = 4,
}

impl ControlSlot {
	pub const ALL: [ControlSlot; 4] =
		[ControlSlot::Expand, ControlSlot::Chat, ControlSlot::Kill, ControlSlot::Revive];

	/// The offset inside the row's block.
	pub const fn offset(self) -> u64 {
		self as u64
	}
}

#[derive(Debug, Default, Clone, Copy)]
pub struct AgentsState;

impl AgentsState {
	pub fn agent_owner(&self, id: &AgentId) -> RetainedKey {
		agent_owner(id)
	}

	pub fn owner(&self, key: &str) -> RetainedKey {
		owner(key)
	}

	pub fn control_owner(&self, agent: &AgentId, slot: ControlSlot) -> RetainedKey {
		control_owner(agent, slot)
	}
}

pub fn with_state<R>(f: impl FnOnce(&mut AgentsState) -> R) -> R {
	let mut state = AgentsState;
	f(&mut state)
}

pub fn agent_owner(id: &AgentId) -> RetainedKey {
	kit_owner(OwnerNamespace::Agents, "agent", id.as_str())
}

pub fn owner(key: &str) -> RetainedKey {
	kit_owner(OwnerNamespace::Agents, "chrome", key)
}

pub fn control_owner(agent: &AgentId, slot: ControlSlot) -> RetainedKey {
	control(OwnerNamespace::Agents, "agent", agent.as_str(), slot as u8)
}
