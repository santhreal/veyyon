//! WHY THIS SUITE EXISTS.
//!
//! A settings page has two failure modes that no compiler catches. A control at
//! its limit that still looks pressable, so a reader presses it and the store
//! clamps the value away with nothing said; and a page reachable from the model
//! but missing from the nav, so a chord or a palette row opens a page nothing
//! leads back to.
//!
//! The nav is swept over `SettingsPage::ALL` and the keyboard page over the key
//! table, so a page or a context added anywhere turns this red rather than
//! quietly rendering a gap.
//!
//! WHAT IT DOES NOT CATCH. Whether a control changes what it claims to change,
//! which is the command table's own suite, and how the page reads at a narrow
//! width.

use veyyon_gui_core::{
	command::Command,
	keys::{self, Context},
	store::{
		model::{Appearance, FONT_MAX, FONT_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX, SettingsPage, Store},
		moves,
	},
};

use super::{
	keyboard,
	logic::{appearances, nav, sidebar_at_default, sidebar_width, text_size},
};

fn store() -> Store {
	Store::opened_in("veyyon", "/repo/veyyon")
}

#[test]
fn every_page_the_model_has_is_in_the_nav_exactly_once() {
	// The sweep: a page added to `ALL` and forgotten here would be reachable by
	// chord and unreachable by pointer.
	for open in SettingsPage::ALL {
		let nav = nav(open);
		assert_eq!(nav.len(), SettingsPage::ALL.len());
		let pages: Vec<SettingsPage> = nav.iter().map(|entry| entry.page).collect();
		assert_eq!(pages, SettingsPage::ALL.to_vec());
		let selected: Vec<SettingsPage> = nav
			.iter()
			.filter(|entry| entry.selected)
			.map(|entry| entry.page)
			.collect();
		assert_eq!(selected, vec![open], "exactly the page on screen is lit");
	}
}

#[test]
fn every_nav_row_opens_the_page_it_names() {
	for open in SettingsPage::ALL {
		for entry in nav(open) {
			assert_eq!(entry.command, Command::OpenSettings(entry.page));
			assert!(!entry.what.is_empty(), "{:?} has no words", entry.page);
		}
	}
}

#[test]
fn the_stepper_is_live_at_neither_end_and_live_in_between() {
	// The defect: a stepper that can be pressed at the maximum, clamping in the
	// store, so the number does not move and nothing says why.
	let mut store = store();
	store.settings.font_size = FONT_MIN;
	let (_, can_shrink, can_grow) = text_size(&store.settings);
	assert!(!can_shrink && can_grow, "at the smallest size, only growing is offered");

	store.settings.font_size = FONT_MAX;
	let (_, can_shrink, can_grow) = text_size(&store.settings);
	assert!(can_shrink && !can_grow, "at the largest size, only shrinking is offered");

	store.settings.font_size = (FONT_MIN + FONT_MAX) / 2.0;
	let (_, can_shrink, can_grow) = text_size(&store.settings);
	assert!(can_shrink && can_grow);
}

#[test]
fn the_stepper_agrees_with_the_command_that_moves_it() {
	// Both ends, driven through the real command rather than by setting the
	// field: a limit computed from different bounds than the store clamps with
	// is the same defect one step removed.
	let mut store = store();
	for _ in 0..40 {
		Command::StepTextSize { up: false }.run(&mut store);
	}
	let (_, can_shrink, _) = text_size(&store.settings);
	assert!(!can_shrink, "the store stopped shrinking and the control did not");

	for _ in 0..40 {
		Command::StepTextSize { up: true }.run(&mut store);
	}
	let (_, _, can_grow) = text_size(&store.settings);
	assert!(!can_grow, "the store stopped growing and the control did not");
}

#[test]
fn a_size_is_printed_without_a_trailing_zero() {
	// A settings page that says "14.0 px" reads as a machine's output.
	let mut store = store();
	store.settings.font_size = 14.0;
	assert_eq!(text_size(&store.settings).0, "14");
	store.settings.font_size = 13.5;
	assert_eq!(text_size(&store.settings).0, "13.5");
}

#[test]
fn the_appearance_control_lights_the_one_in_force_and_switches_to_the_other() {
	let mut store = store();
	for chosen in [Appearance::Dark, Appearance::Light] {
		store.settings.appearance = chosen;
		let rows = appearances(&store.settings);
		assert_eq!(rows.len(), 2, "two appearances, both always offered");
		let lit: Vec<Appearance> = rows
			.iter()
			.filter(|(_, _, _, on, _)| *on)
			.map(|(a, ..)| *a)
			.collect();
		assert_eq!(lit, vec![chosen]);
		for (appearance, what, _, _, command) in rows {
			assert_eq!(command, Command::SetAppearance(appearance));
			assert!(!what.is_empty());
		}
	}
}

#[test]
fn the_reset_is_spent_only_while_the_list_is_at_the_width_it_opens_at() {
	let mut store = store();
	assert!(sidebar_at_default(&store.settings), "the window opens at the default");
	assert_eq!(sidebar_width(&store.settings), format!("{} px", SIDEBAR_DEFAULT.round() as i32));

	moves::set_sidebar_width(&mut store, SIDEBAR_MAX);
	assert!(!sidebar_at_default(&store.settings), "dragged: the reset does something");

	moves::reset_sidebar_width(&mut store);
	assert!(sidebar_at_default(&store.settings), "reset: the reset does nothing again");
}

#[test]
fn every_listed_chord_reaches_the_keyboard_page_under_a_heading() {
	// The sweep over the key table. A context added to core without words here
	// fails to compile in `heading`; a row that ends up in no group fails here.
	let groups = keyboard::groups();
	let listed: usize = keys::listed_rows().len();
	let drawn: usize = groups.iter().map(|(_, rows)| rows.len()).sum();
	assert_eq!(drawn, listed, "a documented chord is not on the page");
	for (heading, rows) in &groups {
		assert!(!heading.is_empty(), "a group with no heading");
		assert!(!rows.is_empty(), "a heading with no rows under it");
		for row in rows {
			assert_eq!(keyboard::heading(row.context), *heading, "a row is under the wrong heading");
			assert!(!row.command.what().is_empty());
		}
	}
}

#[test]
fn no_two_groups_on_the_keyboard_page_share_a_heading() {
	// Two runs of rows under one word reads as a page that lost track of itself.
	let groups = keyboard::groups();
	let mut headings: Vec<&str> = groups.iter().map(|(heading, _)| *heading).collect();
	headings.sort_unstable();
	let count = headings.len();
	headings.dedup();
	assert_eq!(headings.len(), count);
}

#[test]
fn every_context_the_table_uses_is_named_in_words_a_reader_knows() {
	// Derived from the table rather than from a list of contexts, so a row moved
	// into a context nothing names shows up.
	for context in keys::table().into_iter().map(|row| row.context) {
		let heading = keyboard::heading(context);
		assert!(!heading.is_empty());
		assert!(
			!heading.contains("Editor") && !heading.contains("||"),
			"{heading:?} is a predicate, not a heading"
		);
	}
	// And the four contexts are named distinctly, since two of them sharing
	// words would merge two groups on the page.
	let mut names = [Context::Everywhere, Context::Shell, Context::Composer, Context::Palette]
		.map(keyboard::heading);
	names.sort_unstable();
	let count = names.len();
	let mut unique = names.to_vec();
	unique.dedup();
	assert_eq!(unique.len(), count);
}
