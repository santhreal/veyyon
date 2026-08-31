//! Long-lived retained identity registry for agents, transcripts, and controls.

use std::{cell::RefCell, collections::BTreeMap};

use veyyon_gui_core::model::AgentId;
use veyyon_gui_kit::motion::{OwnerNamespace, RetainedKey};

const FIRST_DYNAMIC_OWNER: u64 = 256;

#[derive(Debug)]
pub struct AgentsState {
	agents: BTreeMap<AgentId, RetainedKey>,
	owners: BTreeMap<String, RetainedKey>,
	next:   u64,
}

impl Default for AgentsState {
	fn default() -> Self {
		Self { agents: BTreeMap::new(), owners: BTreeMap::new(), next: FIRST_DYNAMIC_OWNER }
	}
}

impl AgentsState {
	pub fn agent_owner(&mut self, id: &AgentId) -> RetainedKey {
		if let Some(owner) = self.agents.get(id) {
			return *owner;
		}
		let owner = RetainedKey::scoped(OwnerNamespace::Agents, self.next, 0).unwrap_or_else(|| {
			RetainedKey::semantic(OwnerNamespace::Agents, (self.next & 0x00ff_ffff) as u32)
		});
		self.next = self.next.saturating_add(1);
		self.agents.insert(id.clone(), owner);
		owner
	}

	pub fn owner(&mut self, key: &str) -> RetainedKey {
		if let Some(owner) = self.owners.get(key) {
			return *owner;
		}
		let owner = RetainedKey::scoped(OwnerNamespace::Agents, self.next, 0).unwrap_or_else(|| {
			RetainedKey::semantic(OwnerNamespace::Agents, (self.next & 0x00ff_ffff) as u32)
		});
		self.next = self.next.saturating_add(1);
		self.owners.insert(key.to_owned(), owner);
		owner
	}

	pub fn control_owner(&mut self, agent: &AgentId, slot: u8) -> RetainedKey {
		let base = self.agent_owner(agent);
		RetainedKey::new(
			base
				.object
				.saturating_mul(16)
				.saturating_add(u64::from(slot)),
			base.generation,
		)
	}
}

thread_local! {
	static REGISTRY: RefCell<AgentsState> = RefCell::new(AgentsState::default());
}

pub fn with_state<R>(f: impl FnOnce(&mut AgentsState) -> R) -> R {
	REGISTRY.with(|cell| f(&mut cell.borrow_mut()))
}

pub fn agent_owner(id: &AgentId) -> RetainedKey {
	with_state(|state| state.agent_owner(id))
}

pub fn owner(key: &str) -> RetainedKey {
	with_state(|state| state.owner(key))
}

pub fn control_owner(agent: &AgentId, slot: u8) -> RetainedKey {
	with_state(|state| state.control_owner(agent, slot))
}
