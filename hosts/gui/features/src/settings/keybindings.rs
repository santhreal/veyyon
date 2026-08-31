//! Search and conflict decisions for keybindings.

use veyyon_gui_core::model::{KeybindingConflict, KeybindingState, KeybindingView};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BindingRow<'a> {
	pub binding:  &'a KeybindingView,
	pub conflict: Option<&'a KeybindingConflict>,
}

pub fn rows<'a>(state: &'a KeybindingState, query: &str) -> Vec<BindingRow<'a>> {
	let query = query.trim().to_lowercase();
	state
		.effective
		.iter()
		.filter(|binding| {
			query.is_empty()
				|| binding.command.to_lowercase().contains(&query)
				|| binding.chord.to_lowercase().contains(&query)
				|| binding.source.to_lowercase().contains(&query)
		})
		.map(|binding| BindingRow {
			binding,
			conflict: state
				.conflicts
				.iter()
				.find(|conflict| conflict.chord == binding.chord),
		})
		.collect()
}

pub fn default_for<'a>(state: &'a KeybindingState, command: &str) -> Option<&'a KeybindingView> {
	state
		.definitions
		.iter()
		.find(|binding| binding.command == command)
}
