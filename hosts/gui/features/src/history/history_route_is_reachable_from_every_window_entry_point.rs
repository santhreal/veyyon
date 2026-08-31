//! WHY: A new surface route must not be stranded or only reachable via
//! programmatic state mutation. Every first-class navigation route in the
//! desktop application must be discoverable and reachable through all standard
//! entry points: the application menu bar, the command palette catalog, and the
//! keymap shortcuts table.
//!
//! This suite closes the class of orphaned or unreachable navigation routes by
//! sweeping the menu tree, the palette catalogue, and the central keymap
//! registry at run time, asserting that `Route::History` (and all first-class
//! routes) are registered in each.
//!
//! What it does not catch: platform-specific accessibility tree traversal.

use veyyon_gui_core::{
	Store, UiCommand,
	command::menu::{MenuEntry, menu_tree},
	keys::table as keymap_table,
	navigation::{PaletteMode, Route},
	palette::results as palette_results,
};

#[test]
fn test_history_route_is_reachable_from_all_entry_points() {
	let store = Store::detached();

	// 1. Menu tree must contain Navigate(Route::History)
	let mut menu_routes = Vec::new();
	for menu in menu_tree() {
		for entry in menu.entries {
			if let MenuEntry::Action { command: UiCommand::Navigate(route), .. } = entry {
				menu_routes.push(route);
			}
		}
	}
	assert!(
		menu_routes.contains(&Route::History),
		"Route::History must be present in the application menu bar"
	);

	// 2. Palette catalog must contain Navigate(Route::History)
	let palette = palette_results(&store, PaletteMode::Commands, "");
	let mut palette_routes = Vec::new();
	for group in palette.groups {
		for item in group.items {
			for command in item.commands {
				if let UiCommand::Navigate(route) = command {
					palette_routes.push(route);
				}
			}
		}
	}
	assert!(
		palette_routes.contains(&Route::History),
		"Route::History must be present in the command palette catalog"
	);

	// 3. Keymap table must contain a shortcut for Navigate(Route::History)
	let keymap = keymap_table();
	let history_key = keymap
		.iter()
		.find(|row| row.command == UiCommand::Navigate(Route::History));
	assert!(
		history_key.is_some(),
		"Route::History must have an assigned keybinding shortcut in keys table"
	);
	assert_eq!(history_key.unwrap().keys, "secondary-5");

	// 4. Assert every standard top-level route has complete entry point coverage
	let top_level_routes =
		[Route::Conversation, Route::Changes, Route::Files, Route::Agents, Route::History];

	for route in top_level_routes {
		assert!(menu_routes.contains(&route), "Route {route:?} missing from application menu");
		assert!(palette_routes.contains(&route), "Route {route:?} missing from palette catalog");
		assert!(
			keymap
				.iter()
				.any(|r| r.command == UiCommand::Navigate(route)),
			"Route {route:?} missing from keymap table"
		);
	}
}
