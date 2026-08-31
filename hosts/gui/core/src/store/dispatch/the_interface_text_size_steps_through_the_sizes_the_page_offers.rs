//! WHY THIS SUITE EXISTS.
//!
//! The interface text size was reachable from one row of choices on the
//! appearance page and from nothing else: no chord, no menu item, no palette
//! row. A reader without a pointer could not change it, and a recorded scene
//! could not reach a second size at all, so nothing in the window was ever
//! proven at any size but the design default.
//!
//! THE CLASS. A preference with one route to it, and a stepper that leaves the
//! preference on a value the page it belongs to reports as no choice: an
//! increment off the list, a wrap from the largest back to the smallest, a step
//! that sticks because the stored value sits between two choices.
//!
//! The size space is read from `font_size::CHOICES_MILLI_PX` at run time, so a
//! size added to or removed from that list is swept with no edit here, and a
//! list that stops being sorted or stops holding the design default fails.
//!
//! WHAT IT DOES NOT CATCH. Whether a larger size is legible, which the theme
//! scale suite in kit owns, and whether the chord is bound in the running app,
//! which the app's keymap suite owns.

use crate::{
	UiCommand,
	navigation::font_size::{
		CHOICES_MILLI_PX, DEFAULT_MILLI_PX, MAX_MILLI_PX, MIN_MILLI_PX, stepped,
	},
	store::Store,
};

fn size_of(store: &Store) -> u16 {
	store.frontend.preferences.font_size_milli_px
}

fn step(store: &mut Store, larger: bool) -> u16 {
	store.dispatch(UiCommand::StepFontSize { larger });
	size_of(store)
}

#[test]
fn the_choices_are_sorted_hold_the_design_default_and_stay_inside_the_range() {
	assert!(CHOICES_MILLI_PX.len() >= 2, "a stepper needs somewhere to step");
	for pair in CHOICES_MILLI_PX.windows(2) {
		assert!(pair[0] < pair[1], "choices have to ascend: {pair:?} does not");
	}
	assert!(
		CHOICES_MILLI_PX.contains(&DEFAULT_MILLI_PX),
		"the design size has to be one of the choices, or the window as drawn is unreachable"
	);
	for choice in CHOICES_MILLI_PX {
		assert!(
			(MIN_MILLI_PX..=MAX_MILLI_PX).contains(&choice),
			"choice {choice} is outside the range the store clamps to"
		);
	}
}

#[test]
fn stepping_up_from_the_smallest_reaches_every_choice_in_order_and_stops_at_the_largest() {
	let mut store = Store::detached();
	store.dispatch(UiCommand::SetFontSize { milli_px: CHOICES_MILLI_PX[0] });
	let mut walked = vec![size_of(&store)];
	for _ in 0..CHOICES_MILLI_PX.len() {
		walked.push(step(&mut store, true));
	}
	let last = CHOICES_MILLI_PX[CHOICES_MILLI_PX.len() - 1];
	let mut expected = CHOICES_MILLI_PX.to_vec();
	expected.push(last);
	assert_eq!(
		walked, expected,
		"stepping up has to walk the choices in order and hold at the largest rather than wrap"
	);
}

#[test]
fn stepping_down_from_the_largest_reaches_every_choice_in_order_and_stops_at_the_smallest() {
	let mut store = Store::detached();
	let last = CHOICES_MILLI_PX[CHOICES_MILLI_PX.len() - 1];
	store.dispatch(UiCommand::SetFontSize { milli_px: last });
	let mut walked = vec![size_of(&store)];
	for _ in 0..CHOICES_MILLI_PX.len() {
		walked.push(step(&mut store, false));
	}
	let mut expected: Vec<u16> = CHOICES_MILLI_PX.iter().copied().rev().collect();
	expected.push(CHOICES_MILLI_PX[0]);
	assert_eq!(
		walked, expected,
		"stepping down has to walk the choices in reverse and hold at the smallest rather than wrap"
	);
}

#[test]
fn a_size_between_two_choices_steps_onto_the_list_rather_than_sticking() {
	for pair in CHOICES_MILLI_PX.windows(2) {
		let between = pair[0] + (pair[1] - pair[0]) / 2;
		if between == pair[0] {
			continue;
		}
		assert_eq!(
			stepped(between, true),
			pair[1],
			"{between} between {pair:?} has to step up to the choice above it"
		);
		assert_eq!(
			stepped(between, false),
			pair[0],
			"{between} between {pair:?} has to step down to the choice below it"
		);
	}
}

#[test]
fn a_size_outside_the_choices_steps_back_onto_the_list() {
	let smallest = CHOICES_MILLI_PX[0];
	let largest = CHOICES_MILLI_PX[CHOICES_MILLI_PX.len() - 1];
	assert_eq!(
		stepped(MIN_MILLI_PX, true),
		smallest,
		"a stored size under every choice steps up onto the smallest"
	);
	assert_eq!(
		stepped(MAX_MILLI_PX, false),
		largest,
		"a stored size over every choice steps down onto the largest"
	);
}

#[test]
fn every_step_stays_inside_the_range_the_store_clamps_to() {
	let mut store = Store::detached();
	for larger in [true, false] {
		for _ in 0..CHOICES_MILLI_PX.len() * 2 {
			let size = step(&mut store, larger);
			assert!(
				(MIN_MILLI_PX..=MAX_MILLI_PX).contains(&size),
				"a step left the size at {size}, outside the clamped range"
			);
		}
	}
}

#[test]
fn the_step_is_reachable_from_the_keyboard_the_menu_and_the_palette() {
	let mut store = Store::detached();
	store
		.frontend
		.overlays
		.push(crate::navigation::Overlay::CommandPalette {
			mode: crate::navigation::PaletteMode::Commands,
		});
	for larger in [true, false] {
		let wanted = UiCommand::StepFontSize { larger };
		assert!(
			crate::keys::table()
				.iter()
				.any(|row| row.command == wanted && row.listed),
			"a listed chord has to reach {wanted:?}"
		);
		assert!(
			crate::command::menu::menu_tree().iter().any(|menu| {
				menu.entries.iter().any(|entry| match entry {
					crate::command::menu::MenuEntry::Action { command, .. } => *command == wanted,
					_ => false,
				})
			}),
			"a menu item has to reach {wanted:?}"
		);
		assert!(
			crate::palette::results(&store, crate::navigation::PaletteMode::Commands, "")
				.groups
				.iter()
				.flat_map(|group| group.items.iter())
				.flat_map(|item| item.commands.iter())
				.any(|command| *command == wanted),
			"a palette row has to reach {wanted:?}"
		);
	}
}
