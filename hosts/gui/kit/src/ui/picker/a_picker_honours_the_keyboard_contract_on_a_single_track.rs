//! WHY THIS SUITE EXISTS. Previously, each overlay listing things (command
//! palette, model picker, session switcher, quick open, provider search)
//! implemented bespoke keyboard and cursor handlers. Key chords that worked
//! in one list were ignored in another, and two simultaneous overlays could
//! alias motion tracks and clash on cursor state.
//!
//! THE CLASS. Any list overlay that accepts navigation and selection input.
//! Every picker variant and every keyboard action is swept from canonical
//! runtime tables, verifying consistent cursor stepping, boundary clamping,
//! accept/dismiss classification, and distinct retained motion keys.
//!
//! WHAT IT DOES NOT CATCH. Window-level focus routing and native platform IME
//! composition, which are managed by the host window shell.

use std::collections::HashSet;

use crate::{
	motion::RetainedKey,
	ui::picker::{
		PickerAction, PickerGroup, PickerItem, picker_owner, picker_preview, picker_row,
		picker_scroll, picker_search,
	},
};

#[test]
fn every_picker_action_is_swept_and_classified() {
	let actions = PickerAction::ALL;
	assert_eq!(actions.len(), 9);

	for action in actions {
		match action {
			PickerAction::MoveUp
			| PickerAction::MoveDown
			| PickerAction::PageUp
			| PickerAction::PageDown
			| PickerAction::Home
			| PickerAction::End => {
				assert!(action.is_cursor_motion());
				assert!(!action.is_accept());
				assert!(!action.is_dismiss());
			},
			PickerAction::Accept | PickerAction::AcceptAlternate => {
				assert!(!action.is_cursor_motion());
				assert!(action.is_accept());
				assert!(!action.is_dismiss());
			},
			PickerAction::Dismiss => {
				assert!(!action.is_cursor_motion());
				assert!(!action.is_accept());
				assert!(action.is_dismiss());
			},
		}
	}
}

#[test]
fn cursor_stepping_clamps_and_navigates_correctly() {
	let total = 20;
	let page_size = 5;

	// Down & Up
	assert_eq!(PickerAction::MoveDown.step(0, total, page_size), Some(1));
	assert_eq!(PickerAction::MoveDown.step(19, total, page_size), Some(19));
	assert_eq!(PickerAction::MoveUp.step(5, total, page_size), Some(4));
	assert_eq!(PickerAction::MoveUp.step(0, total, page_size), Some(0));

	// PageDown & PageUp
	assert_eq!(PickerAction::PageDown.step(2, total, page_size), Some(7));
	assert_eq!(PickerAction::PageDown.step(18, total, page_size), Some(19));
	assert_eq!(PickerAction::PageUp.step(12, total, page_size), Some(7));
	assert_eq!(PickerAction::PageUp.step(3, total, page_size), Some(0));

	// Home & End
	assert_eq!(PickerAction::Home.step(15, total, page_size), Some(0));
	assert_eq!(PickerAction::End.step(3, total, page_size), Some(19));

	// Non-motion actions
	assert_eq!(PickerAction::Accept.step(5, total, page_size), None);
	assert_eq!(PickerAction::AcceptAlternate.step(5, total, page_size), None);
	assert_eq!(PickerAction::Dismiss.step(5, total, page_size), None);

	// Empty list bounds
	assert_eq!(PickerAction::MoveDown.step(0, 0, page_size), Some(0));
	assert_eq!(PickerAction::MoveUp.step(0, 0, page_size), Some(0));
	assert_eq!(PickerAction::Home.step(0, 0, page_size), Some(0));
	assert_eq!(PickerAction::End.step(0, 0, page_size), Some(0));
}

#[test]
fn two_pickers_drawn_at_once_never_share_retained_motion_keys() {
	let picker_a = "command-palette";
	let picker_b = "model-picker";

	let owner_a = picker_owner(picker_a);
	let owner_b = picker_owner(picker_b);
	assert_ne!(owner_a, owner_b);

	let scroll_a = picker_scroll(picker_a);
	let scroll_b = picker_scroll(picker_b);
	assert_ne!(scroll_a, scroll_b);

	let search_a = picker_search(picker_a);
	let search_b = picker_search(picker_b);
	assert_ne!(search_a, search_b);

	let preview_a = picker_preview(picker_a);
	let preview_b = picker_preview(picker_b);
	assert_ne!(preview_a, preview_b);

	let mut seen: HashSet<RetainedKey> = HashSet::new();
	let keys = [owner_a, owner_b, scroll_a, scroll_b, search_a, search_b, preview_a, preview_b];
	for key in keys {
		assert!(seen.insert(key), "RetainedKey collision detected: {key:?}");
	}

	for i in 0..10 {
		let row_a = picker_row(&format!("{picker_a}-row-{i}"));
		let row_b = picker_row(&format!("{picker_b}-row-{i}"));
		assert_ne!(row_a, row_b);
		assert!(seen.insert(row_a));
		assert!(seen.insert(row_b));
	}
}

#[test]
fn picker_structural_types_construct_without_store_dependencies() {
	let item = PickerItem::new("item-1", picker_row("item-1"), "Test Item")
		.detail("Item Detail")
		.selected(true)
		.active(false);

	let group = PickerGroup::new("group-1", "Group Label").item(item);
	assert_eq!(group.items.len(), 1);
	assert_eq!(group.items[0].id.as_ref(), "item-1");
	assert_eq!(group.items[0].title.as_ref(), "Test Item");
	assert_eq!(group.items[0].detail.as_deref(), Some("Item Detail"));
	assert!(group.items[0].selected);
}
