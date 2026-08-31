//! Cursor arithmetic over the exact grouped rows the view draws.

use crate::{
	UiCommand,
	palette::types::{Group, Item},
};

pub fn item_count(groups: &[Group]) -> usize {
	groups.iter().map(|group| group.items.len()).sum()
}

/// Commands for the selected identity, or none when the result set changed.
///
/// The cursor is never clamped to a different row: if the selected identity
/// disappeared between events, Enter performs no action.
pub fn selected_commands(groups: &[Group], selected: usize) -> Option<&[UiCommand]> {
	groups
		.iter()
		.flat_map(|group| group.items.iter())
		.nth(selected)
		.map(|item| item.commands.as_slice())
}

pub fn selected_id(groups: &[Group], selected: usize) -> Option<&str> {
	groups
		.iter()
		.flat_map(|group| group.items.iter())
		.nth(selected)
		.map(|item| item.id.as_str())
}

pub fn selected_item(groups: &[Group], selected: usize) -> Option<&Item> {
	groups
		.iter()
		.flat_map(|group| group.items.iter())
		.nth(selected)
}

/// The selected row's child index in the scroll box, including group headings.
pub fn selected_child(groups: &[Group], selected: usize) -> usize {
	let mut item_index = 0;
	let mut child_index = 0;
	for group in groups {
		child_index += 1;
		for _ in &group.items {
			if item_index == selected {
				return child_index;
			}
			item_index += 1;
			child_index += 1;
		}
	}
	0
}

pub fn move_cursor(groups: &[Group], selected: usize, down: bool) -> usize {
	let count = item_count(groups);
	if count == 0 {
		return 0;
	}
	if down {
		selected.saturating_add(1).min(count - 1)
	} else {
		selected.saturating_sub(1).min(count - 1)
	}
}

pub fn page_cursor(groups: &[Group], selected: usize, down: bool, page_size: usize) -> usize {
	let count = item_count(groups);
	if count == 0 {
		return 0;
	}
	let step = page_size.max(1);
	if down {
		(selected + step).min(count - 1)
	} else {
		selected.saturating_sub(step)
	}
}

pub fn home_cursor(_groups: &[Group]) -> usize {
	0
}

pub fn end_cursor(groups: &[Group]) -> usize {
	let count = item_count(groups);
	count.saturating_sub(1)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn disappeared_identity_is_not_replaced_by_a_neighbor() {
		let groups = vec![Group { id: "empty", label: "Empty", items: Vec::new() }];
		assert_eq!(selected_commands(&groups, 0), None);
		assert_eq!(selected_id(&groups, 0), None);
		assert_eq!(selected_item(&groups, 0), None);
	}

	#[test]
	fn child_index_counts_every_heading() {
		let groups = vec![Group { id: "one", label: "One", items: Vec::new() }, Group {
			id:    "two",
			label: "Two",
			items: Vec::new(),
		}];
		assert_eq!(selected_child(&groups, 0), 0);
	}
}
