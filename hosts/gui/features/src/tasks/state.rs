//! Long-lived retained identity registry for task rows, phases, and controls.

use veyyon_gui_core::model::TaskId;
use veyyon_gui_kit::motion::{OwnerNamespace, RetainedKey, control, owner as kit_owner};

#[derive(Debug, Default, Clone, Copy)]
pub struct TasksState;

impl TasksState {
	pub fn task_owner(&self, id: &TaskId) -> RetainedKey {
		task_owner(id)
	}

	pub fn owner(&self, key: &str) -> RetainedKey {
		owner(key)
	}

	pub fn control_owner(&self, task: &TaskId, slot: u8) -> RetainedKey {
		control_owner(task, slot)
	}
}

pub fn with_state<R>(f: impl FnOnce(&mut TasksState) -> R) -> R {
	let mut state = TasksState;
	f(&mut state)
}

pub fn task_owner(id: &TaskId) -> RetainedKey {
	kit_owner(OwnerNamespace::Agents, "task", id.as_str())
}

pub fn owner(key: &str) -> RetainedKey {
	kit_owner(OwnerNamespace::Agents, "chrome", key)
}

pub fn control_owner(task: &TaskId, slot: u8) -> RetainedKey {
	control(OwnerNamespace::Agents, "task", task.as_str(), slot)
}
