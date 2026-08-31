//! Long-lived retained identity registry for task rows, phases, and controls.

use std::{cell::RefCell, collections::BTreeMap};

use veyyon_gui_core::model::TaskId;
use veyyon_gui_kit::motion::{OwnerNamespace, RetainedKey};

const FIRST_DYNAMIC_OWNER: u64 = 256;

#[derive(Debug)]
pub struct TasksState {
	tasks:  BTreeMap<TaskId, RetainedKey>,
	owners: BTreeMap<String, RetainedKey>,
	next:   u64,
}

impl Default for TasksState {
	fn default() -> Self {
		Self { tasks: BTreeMap::new(), owners: BTreeMap::new(), next: FIRST_DYNAMIC_OWNER }
	}
}

impl TasksState {
	pub fn task_owner(&mut self, id: &TaskId) -> RetainedKey {
		if let Some(owner) = self.tasks.get(id) {
			return *owner;
		}
		let owner = RetainedKey::scoped(OwnerNamespace::Agents, self.next, 0).unwrap_or_else(|| {
			RetainedKey::semantic(OwnerNamespace::Agents, (self.next & 0x00ff_ffff) as u32)
		});
		self.next = self.next.saturating_add(1);
		self.tasks.insert(id.clone(), owner);
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

	pub fn control_owner(&mut self, task: &TaskId, slot: u8) -> RetainedKey {
		let base = self.task_owner(task);
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
	static REGISTRY: RefCell<TasksState> = RefCell::new(TasksState::default());
}

pub fn with_state<R>(f: impl FnOnce(&mut TasksState) -> R) -> R {
	REGISTRY.with(|cell| f(&mut cell.borrow_mut()))
}

pub fn task_owner(id: &TaskId) -> RetainedKey {
	with_state(|state| state.task_owner(id))
}

pub fn owner(key: &str) -> RetainedKey {
	with_state(|state| state.owner(key))
}

pub fn control_owner(task: &TaskId, slot: u8) -> RetainedKey {
	with_state(|state| state.control_owner(task, slot))
}
