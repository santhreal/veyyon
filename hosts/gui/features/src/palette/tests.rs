//! Palette projection contracts that do not require a window.

use veyyon_gui_core::{
	Store, UiCommand,
	navigation::{PaletteMode, Route, SettingsPage},
	palette::{SourceState, results},
};

#[test]
fn detached_dynamic_modes_do_not_fabricate_rows() {
	let store = Store::detached();
	for mode in [
		PaletteMode::QuickOpen,
		PaletteMode::Sessions,
		PaletteMode::Messages,
		PaletteMode::Files,
		PaletteMode::Models,
		PaletteMode::Providers,
		PaletteMode::Agents,
	] {
		let results = results(&store, mode, "");
		assert!(results.groups.is_empty(), "{mode:?} fabricated detached product data");
		assert!(matches!(results.state, SourceState::Loading | SourceState::Empty));
	}
}

#[test]
fn every_settings_destination_is_a_concrete_command() {
	let store = Store::detached();
	let results = results(&store, PaletteMode::Settings, "");
	let commands: Vec<_> = results
		.groups
		.iter()
		.flat_map(|group| &group.items)
		.flat_map(|item| &item.commands)
		.collect();
	for page in SettingsPage::ALL {
		assert!(commands.contains(&&UiCommand::Navigate(Route::Settings(page))));
	}
}

#[test]
fn filtering_never_leaves_an_invisible_group() {
	let store = Store::detached();
	let results = results(&store, PaletteMode::Commands, "not a command that exists");
	assert!(results.groups.is_empty());
	assert_eq!(results.state, SourceState::Empty);
}
