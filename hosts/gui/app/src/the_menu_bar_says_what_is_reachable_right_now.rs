//! WHY: a native menu bar is a snapshot. `set_menus` hands the platform a tree
//! with each item's enabled state already decided, and the platform never asks
//! again. The window installed it once at open and never reinstalled it, so
//! every item described the store as it was before the first frame arrived: a
//! detached window greys out Submit, and it stayed greyed out after a session
//! opened, for the rest of the process.
//!
//! The class is a menu that disagrees with the palette. Both read
//! `is_command_enabled`, so they cannot disagree about a command at one instant
//! — they disagree about WHEN. This suite pins the staleness check that decides
//! a reinstall, and pins that the app adds no action item core never declared,
//! which is the other way a menu lies: an item whose title says one verb and
//! whose action is another.
//!
//! Not covered: whether the platform draws what it was handed. That is inside
//! the OS, and nothing in this process can read it back.

use gpui::MenuItem;
use veyyon_gui_core::{
	Store, UiCommand,
	command::menu::{MenuEntry, is_command_enabled, menu_tree},
	host::{HostEvent, SnapshotSection},
	model::{Capability, CapabilityStatus, ConnectionState},
	navigation::{Overlay, PaletteMode},
};
use veyyon_gui_features::act::Do;

use crate::menus::{MenuEnablement, app_menus};

fn connected() -> Store {
	let mut store = Store::detached();
	store.apply(HostEvent::ConnectionChanged(ConnectionState::Connected {
		endpoint: "unix:/run/veyyon/gui-host.sock".to_owned(),
		protocol: 1,
	}));
	store.apply(HostEvent::Snapshot(SnapshotSection::Capabilities(
		Capability::ALL
			.iter()
			.map(|capability| (*capability, CapabilityStatus::Available))
			.collect(),
	)));
	store
}

/// Every action item in the built menu bar, as (title, command when it carries
/// one).
fn action_items(store: Option<&Store>) -> Vec<(String, Option<UiCommand>, bool)> {
	fn walk(items: &[MenuItem], out: &mut Vec<(String, Option<UiCommand>, bool)>) {
		for item in items {
			match item {
				MenuItem::Action { name, action, disabled, .. } => {
					let command = action
						.as_any()
						.downcast_ref::<Do>()
						.map(|verb| verb.0.clone());
					out.push((name.to_string(), command, *disabled));
				},
				MenuItem::Submenu(menu) => walk(&menu.items, out),
				MenuItem::Separator | MenuItem::SystemMenu(_) => {},
			}
		}
	}
	let menus = app_menus(store);
	let mut out = Vec::new();
	for menu in &menus {
		walk(&menu.items, &mut out);
	}
	out
}

#[test]
fn nothing_is_installed_until_the_first_check() {
	let mut enablement = MenuEnablement::of_the_menu_tree();
	assert!(
		enablement.went_stale(&Store::detached()),
		"a window with no menu bar installed reported one that was current"
	);
	assert!(
		!enablement.went_stale(&Store::detached()),
		"a store that did not move asked for a reinstall"
	);
}

#[test]
fn a_store_that_changes_what_is_reachable_asks_for_a_reinstall() {
	let mut enablement = MenuEnablement::of_the_menu_tree();
	let mut store = Store::detached();
	let _ = enablement.went_stale(&store);

	let detached = action_items(Some(&store));
	store.apply(HostEvent::ConnectionChanged(ConnectionState::Connected {
		endpoint: "unix:/run/veyyon/gui-host.sock".to_owned(),
		protocol: 1,
	}));
	store.apply(HostEvent::Snapshot(SnapshotSection::Capabilities(
		Capability::ALL
			.iter()
			.map(|capability| (*capability, CapabilityStatus::Available))
			.collect(),
	)));
	assert!(
		enablement.went_stale(&store),
		"attaching to an engine changed nothing the menu bar reports"
	);

	let attached = action_items(Some(&store));
	assert_ne!(
		detached, attached,
		"the menu bar drew the same items for a detached and an attached window"
	);
}

#[test]
fn the_menu_bar_reads_enablement_from_the_predicate_the_palette_reads() {
	let store = connected();
	for (title, command, disabled) in action_items(Some(&store)) {
		let Some(command) = command else {
			continue;
		};
		assert_eq!(
			!disabled,
			is_command_enabled(&command, &store),
			"{title} disagrees with the palette's answer for {command:?}"
		);
	}
}

#[test]
fn a_window_with_no_store_disables_nothing_it_cannot_answer_for() {
	// With no store the menu bar has no predicate to consult, so it must not
	// invent a refusal: an item is drawn reachable and the dispatch decides.
	for (title, command, disabled) in action_items(None) {
		if command.is_some() {
			assert!(!disabled, "{title} was greyed out by a window that has no store to ask");
		}
	}
}

#[test]
fn the_app_adds_no_verb_that_core_never_declared() {
	// An item wired to the wrong command is invisible from the outside: the
	// title reads Paste and the action copies. Every command-carrying item in
	// the bar has to come from `menu_tree`, under the title core gave it.
	let mut declared: Vec<(String, UiCommand)> = Vec::new();
	for menu in menu_tree() {
		for entry in menu.entries {
			if let MenuEntry::Action { title, command } = entry {
				declared.push((title.to_owned(), command));
			}
		}
	}

	let mut unexpected = Vec::new();
	for (title, command, _) in action_items(Some(&connected())) {
		let Some(command) = command else {
			continue;
		};
		if !declared
			.iter()
			.any(|(name, verb)| *name == title && *verb == command)
		{
			unexpected.push((title, command));
		}
	}
	assert_eq!(
		unexpected,
		Vec::new(),
		"the app bar names verbs core never declared under these titles"
	);
}

#[test]
fn an_overlay_opening_reaches_the_menu_bar() {
	// The window's state moving while it stays connected. Session verbs cannot
	// stand in for this: `RenameSession` and `DeleteSession` name a session id
	// and a title, so they are pinned opt-outs rather than menu items, and a
	// session arriving moves nothing the menu bar draws. What the menu does
	// carry that the window can move is the two overlay verbs, whose answer is
	// whether anything is open.
	let mut enablement = MenuEnablement::of_the_menu_tree();
	let mut store = connected();
	let _ = enablement.went_stale(&store);
	let closed = action_items(Some(&store));

	let _ = store
		.dispatch(UiCommand::OpenOverlay(Overlay::CommandPalette { mode: PaletteMode::Commands }));

	assert!(
		enablement.went_stale(&store),
		"an overlay opened and the menu bar still described a window with none"
	);
	let open = action_items(Some(&store));
	assert_ne!(closed, open, "the menu bar drew the same items before and after an overlay opened");
	let closer = |items: &[(String, Option<UiCommand>, bool)]| {
		items
			.iter()
			.find(|(_, command, _)| command.as_ref() == Some(&UiCommand::CloseTopOverlay))
			.map(|(_, _, disabled)| *disabled)
	};
	assert_eq!(closer(&closed), Some(true), "Close Overlay offered itself with nothing open");
	assert_eq!(closer(&open), Some(false), "Close Overlay stayed greyed out over an open overlay");

	let _ = store.dispatch(UiCommand::CloseTopOverlay);
	assert!(
		enablement.went_stale(&store),
		"the overlay closed and the menu bar still offered to close one"
	);
}
