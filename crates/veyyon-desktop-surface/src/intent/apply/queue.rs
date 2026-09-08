//! What a queue intent changes in the session rail the window owns (§5.14).

use crate::model::ShellState;

/// True when a row's title or subtitle contains the needle.
fn row_matches(state: &ShellState, id: u64, needle: &str) -> bool {
	state
		.sections
		.iter()
		.flat_map(|(_, rows)| rows.iter())
		.any(|row| {
			row.id == id
				&& (row.title.to_lowercase().contains(needle)
					|| row.subtitle.to_lowercase().contains(needle))
		})
}

/// The needle a filter is matched by, or `None` when the filter is empty.
fn needle(state: &ShellState) -> Option<String> {
	state
		.keymap
		.queue_filter
		.as_ref()
		.map(|filter| filter.trim().to_lowercase())
		.filter(|needle| !needle.is_empty())
}

/// Narrows the rail, and moves off a selection the filter no longer lists.
pub fn filter(state: &mut ShellState, filter: &str) {
	let trimmed = filter.trim();
	state.keymap.queue_filter = if trimmed.is_empty() {
		None
	} else {
		Some(filter.to_string())
	};
	let Some(needle) = needle(state) else {
		return;
	};
	if row_matches(state, state.current_id, &needle) {
		return;
	}
	let first = state
		.sections
		.iter()
		.flat_map(|(_, rows)| rows.iter())
		.find(|row| {
			row.title.to_lowercase().contains(&needle) || row.subtitle.to_lowercase().contains(&needle)
		})
		.map(|row| (row.id, row.title.clone()));
	if let Some((id, title)) = first {
		state.current_id = id;
		state.title = title;
	}
}

/// Steps the selection through the rows the filter lists, clamped to its ends.
pub fn move_selection(state: &mut ShellState, delta: i32) {
	state.keymap.selection_delta = delta;
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
	let Some(last) = listed.len().checked_sub(1) else {
		return;
	};
	let current = listed
		.iter()
		.position(|&id| id == state.current_id)
		.unwrap_or(0);
	let stepped = ((current as i64 + delta as i64).max(0) as usize).min(last);
	let next = listed[stepped];
	state.current_id = next;
	if let Some(title) = state.row(next).map(|row| row.title.clone()) {
		state.title = title;
	}
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
