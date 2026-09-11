//! WHY: every verb the window has was reachable only from the palette or from
//! a chord. There was no menu bar at all, so an operator who did not know a
//! chord had one list to find everything in, and a verb nobody put in that
//! list was reachable by memory alone. A verb added to `Command` after this
//! suite exists must land in a menu or be refused a place on purpose.
//!
//! CLASS CLOSED: the reach of every member of `Command`, swept from
//! `Command::iter()` at run time rather than from a list written here. Each
//! variant is in exactly one menu section or in `MENU_OPT_OUT`, the opt-out
//! set is pinned by exact equality so a verb cannot be quietly excused, and
//! every entry a menu holds is required to build its gpui action with no
//! argument, which is what a menu item can dispatch: a one-press item has no
//! way to state an index, a delta or a scroll target. Adding a variant turns
//! this red until a decision is recorded for it, and moving a verb into the
//! opt-out list turns the equality assertion red.
//!
//! Section titles and entry labels are also pinned as non-empty and distinct,
//! since a bar whose words repeat cannot state which menu is open.
//!
//! GAPS: reachability is the table, not the drawing. That a press on a word
//! opens the menu, that the keyboard walks it, and that a declined entry is
//! inert are driven through the real view by
//! `the-menu-bar-takes-the-verb-the-keyboard-walked-to`. Whether the host's
//! refusals reach the bar at all is the projection's, swept by
//! `a-verb-the-host-declined-is-refused-in-the-menu-and-dropped-from-the-palette`.

use std::collections::{BTreeMap, BTreeSet};

use strum::IntoEnumIterator;
use veyyon_desktop_surface::{
	Command, MENU_OPT_OUT, MenuSectionId, build_action, is_in_a_menu, keymap::Keymap,
};

/// Every verb, from the enum rather than from a list written here.
fn every_command() -> Vec<Command> {
	Command::iter().collect()
}

#[test]
fn every_verb_is_in_a_menu_or_on_the_opt_out_list() {
	let opted_out: BTreeSet<&'static str> =
		MENU_OPT_OUT.iter().map(|command| command.name()).collect();
	for command in every_command() {
		let in_menu = is_in_a_menu(command);
		let excused = opted_out.contains(command.name());
		assert!(
			in_menu != excused,
			"{name} is {state}: a verb belongs to exactly one menu or to MENU_OPT_OUT",
			name = command.name(),
			state = if in_menu {
				"in a menu and excused from one"
			} else {
				"in no menu and not excused"
			},
		);
	}
}

#[test]
fn the_verbs_excused_from_the_menus_are_exactly_these() {
	let excused: Vec<&'static str> = MENU_OPT_OUT.iter().map(|command| command.name()).collect();
	assert_eq!(
		excused,
		vec![
			// Each reads an argument off the chord that invoked it.
			"FocusLive",
			"MoveSelection",
			"Scroll",
			"SelectOption",
			// Each is what a key already means where it is pressed.
			"Primary",
			"Newline",
			"SplitHalf",
			"Dismiss",
			// The way into the bar, with nothing to do from inside it.
			"OpenMenu",
		],
		"a verb excused from every menu is a decision, so it is recorded here by name"
	);
}

#[test]
fn no_verb_is_held_by_two_menus() {
	let mut holder: BTreeMap<&'static str, Vec<&'static str>> = BTreeMap::new();
	for section in MenuSectionId::iter() {
		for command in section.entries() {
			holder
				.entry(command.name())
				.or_default()
				.push(section.title());
		}
	}
	let doubled: Vec<(&&str, &Vec<&str>)> = holder
		.iter()
		.filter(|(_, sections)| sections.len() > 1)
		.collect();
	assert!(doubled.is_empty(), "a verb sits in one menu, these sit in several: {doubled:?}");
}

#[test]
fn every_menu_holds_verbs_under_a_word_of_its_own() {
	let mut titles: BTreeSet<&'static str> = BTreeSet::new();
	for section in MenuSectionId::iter() {
		assert!(!section.entries().is_empty(), "{} holds no verb", section.title());
		assert!(!section.title().is_empty(), "a menu with no word cannot be pressed");
		assert!(
			titles.insert(section.title()),
			"two menus are drawn as `{}`, so the bar cannot state which one is open",
			section.title()
		);
	}
}

#[test]
fn every_menu_entry_dispatches_with_no_argument() {
	for section in MenuSectionId::iter() {
		for command in section.entries() {
			let built = build_action(command.name(), None);
			assert!(
				built.is_ok(),
				"{title} holds `{name}`, which cannot be dispatched without an argument: a menu item \
				 is one press and carries none",
				title = section.title(),
				name = command.name(),
			);
		}
	}
}

#[test]
fn every_menu_entry_states_a_label_of_its_own() {
	let mut labels: BTreeSet<&'static str> = BTreeSet::new();
	for section in MenuSectionId::iter() {
		for command in section.entries() {
			assert!(!command.label().is_empty(), "{} draws no words", command.name());
			assert!(
				labels.insert(command.label()),
				"`{}` is drawn in two menu rows, so a press cannot be told from its neighbour",
				command.label()
			);
		}
	}
}

#[test]
fn the_window_closing_verbs_are_bound_and_are_not_the_tab_closing_one() {
	let keymap = Keymap::default();
	let chord_of = |wanted: Command| -> Option<String> {
		keymap
			.rows()
			.into_iter()
			.find(|row| row.command == wanted)
			.map(|row| row.chord)
	};
	let close_window = chord_of(Command::CloseWindow).expect("the window's close is bound");
	let quit = chord_of(Command::Quit).expect("quit is bound");
	let close_tab = chord_of(Command::CloseTabOrPark).expect("the tab's close is bound");
	assert_ne!(
		close_window, close_tab,
		"closing the window and closing a tab are different verbs and cannot share a chord"
	);
	assert_ne!(close_window, quit, "closing the window is not quitting");
}
