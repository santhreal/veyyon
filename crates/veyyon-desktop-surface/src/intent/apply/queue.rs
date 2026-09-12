//! What a queue intent changes in the session rail the window owns (§5.14).

use crate::model::ShellState;

/// The needle a filter is matched by, or `None` when the filter is empty.
fn needle(state: &ShellState) -> Option<String> {
	state
		.keymap
		.queue_filter
		.as_ref()
		.map(|filter| filter.trim().to_lowercase())
		.filter(|needle| !needle.is_empty())
}

/// Narrows the rail without changing the host-confirmed active session.
pub fn filter(state: &mut ShellState, filter: &str) {
	let trimmed = filter.trim();
	state.keymap.queue_filter = if trimmed.is_empty() {
		None
	} else {
		Some(filter.to_string())
	};
}

/// Resolves keyboard movement to a request target without changing acknowledged
/// state.
pub fn selection_target(state: &ShellState, delta: i32) -> Option<u64> {
	if delta == 0 {
		return None;
	}
	let needle = needle(state);
	let listed: Vec<u64> = state
		.sections
		.iter()
		.flat_map(|(_, rows)| rows.iter())
		.filter(|row| {
			needle.as_ref().is_none_or(|needle| {
				row.title.to_lowercase().contains(needle)
					|| row.subtitle.to_lowercase().contains(needle)
			})
		})
		.map(|row| row.id)
		.collect();
	let last = listed.len().checked_sub(1)?;
	let current = listed.iter().position(|&id| id == state.current_id);
	let stepped = match current {
		Some(current) if delta < 0 => current.saturating_sub(delta.unsigned_abs() as usize),
		Some(current) => current.saturating_add(delta as usize).min(last),
		None if delta < 0 => last,
		None => 0,
	};
	let next = listed[stepped];
	(next != state.current_id).then_some(next)
}

/// Closes one panel tab, or parks the session when it is the last one.
pub fn close_tab_or_park(state: &mut ShellState) {
	if state.panel.tabs.len() <= 1 {
		state.keymap.parked_session = Some(state.current_id);
		return;
	}
	let closing = state
		.panel
		.tabs
		.iter()
		.position(|&tab| tab == state.panel.active_tab)
		.unwrap_or(0);
	state.panel.tabs.remove(closing);
	let next = closing.min(state.panel.tabs.len().saturating_sub(1));
	if let Some(&tab) = state.panel.tabs.get(next) {
		state.panel.active_tab = tab;
	}
}
