//! What an intent changes in the settings sheet the window is drawing (§5.10).
//!
//! A row draws the value the operator just set, so the field, the switch and
//! the keybinding field do not snap back while the host writes the change.
//! Everything else the sheet lists is the host's and arrives as a section.

use serde_json::Value;

use crate::{model::ShellState, overlay::Overlay};

/// Draws a setting at the value that was set.
pub fn setting_changed(state: &mut ShellState, key: &str, value: &Value) {
	if let Some(Overlay::Settings(settings)) = &mut state.overlay
		&& let Some(entry) = settings.settings.get_mut(key)
	{
		entry.value = value.clone();
	}
}

/// Draws a setting at the default it ships with.
pub fn reset_setting(state: &mut ShellState, key: &str) {
	if let Some(Overlay::Settings(settings)) = &mut state.overlay
		&& let Some(entry) = settings.settings.get_mut(key)
	{
		entry.value = entry.default.clone();
	}
}

/// Draws a keymap action bound to `keys`, and states the binding as the
/// operator's own.
pub fn keybinding_changed(state: &mut ShellState, action: &str, keys: &[String]) {
	if let Some(Overlay::Settings(settings)) = &mut state.overlay
		&& let Some(binding) = settings
			.keybindings
			.iter_mut()
			.find(|binding| binding.action == *action)
	{
		binding.keys = keys.to_vec();
		"user".clone_into(&mut binding.source);
	}
}

/// Draws the theme list settled on `theme` for the ground it applies to.
pub fn select_theme(state: &mut ShellState, theme: &str, dark: bool) {
	if let Some(Overlay::Settings(settings)) = &mut state.overlay
		&& let Some(themes) = &mut settings.themes
	{
		let ground = if dark {
			&mut themes.dark
		} else {
			&mut themes.light
		};
		ground.clear();
		ground.push_str(theme);
	}
}

/// Adds or drops one item from what a new profile is seeded with.
pub fn toggle_profile_copy(state: &mut ShellState, key: &str) {
	if let Some(Overlay::Settings(settings)) = &mut state.overlay
		&& !settings.profile_copy_off.remove(key)
	{
		settings.profile_copy_off.insert(key.to_string());
	}
}

/// States that the sheet is being read again from disk.
pub fn reload_settings(state: &mut ShellState) {
	if let Some(Overlay::Settings(settings)) = &mut state.overlay {
		settings.reloading = true;
	}
}

/// Draws one MCP server switched on or off.
pub fn set_mcp_enabled(state: &mut ShellState, server: &str, enabled: bool) {
	if let Some(Overlay::Settings(settings)) = &mut state.overlay
		&& let Some(view) = settings.mcp.iter_mut().find(|view| view.name == *server)
	{
		view.enabled = enabled;
	}
}
