//! Projection from protocol store domains onto overlay view models (§5.8,
//! §5.9).
//!
//! Synchronizes host settings, themes, keybindings, providers, authentication,
//! file trees, and search results onto active `Overlay::Settings` and
//! `Overlay::Palette` state.

use veyyon_desktop_model::{FileKind, Store};
use veyyon_desktop_surface::{
	Overlay, PaletteItem, PaletteMode, PaletteState, SettingsState, ShellState,
};

/// Projects domain store views onto active overlay state fields.
pub fn project_overlay(store: &Store, state: &mut ShellState) {
	match &mut state.overlay {
		Some(Overlay::Settings(settings_state)) => {
			project_settings_domains(store, settings_state);
		},
		Some(Overlay::Palette(palette_state)) => {
			project_palette_domains(store, palette_state);
		},
		None => {},
	}
}

/// Populates settings overlay categories from host domain snapshots.
fn project_settings_domains(store: &Store, state: &mut SettingsState) {
	if let Some(settings) = &store.domains.settings {
		state.settings = settings.clone();
	}
	if let Some(themes) = &store.domains.themes {
		state.themes = Some(themes.clone());
	}
	if !store.domains.keybindings.is_empty() {
		state.keybindings.clone_from(&store.domains.keybindings);
	}
	if !store.domains.providers.is_empty() {
		state.providers.clone_from(&store.domains.providers);
	}
	if let Some(auth_flow) = &store.domains.auth_flow {
		state.auth_flow = Some(auth_flow.clone());
	}
	if !store.domains.mcp.is_empty() {
		state.mcp.clone_from(&store.domains.mcp);
	}
	if !store.domains.agents.is_empty() {
		state.extensions.clone_from(&store.domains.agents);
	}
	if let Some(diagnostics) = &store.domains.diagnostics {
		state.diagnostics = Some(diagnostics.clone());
	}
	if let Some(active_session) = &store.persisted.shell.active_session {
		if let Some(usage) = store.domains.usage.get(active_session) {
			state.usage = Some(usage.clone());
		}
		if let Some(ctx) = store.domains.context.get(active_session) {
			state.context = Some(ctx.clone());
		}
	}
}

/// Populates palette items from file tree and search result domains.
fn project_palette_domains(store: &Store, state: &mut PaletteState) {
	match state.mode {
		PaletteMode::Files => {
			if let Some(tree) = &store.domains.file_tree {
				let mut items = Vec::new();
				for (idx, entry) in tree.entries.iter().enumerate() {
					if entry.kind == FileKind::File {
						items.push(PaletteItem::file(idx as u64 + 1000, entry.path.clone()));
					}
				}
				if !items.is_empty() {
					state.items = items;
				}
			}
		},
		PaletteMode::ContentSearch => {
			if let Some(search) = &store.domains.search {
				let mut items = Vec::new();
				for (idx, path) in search.paths.iter().enumerate() {
					items.push(PaletteItem::file(idx as u64 + 2000, path.clone()));
				}
				state.items = items;
			}
		},
		PaletteMode::Browse => {
			if let Some(tree) = &store.domains.file_tree {
				let mut items = Vec::new();
				for (idx, entry) in tree.entries.iter().enumerate() {
					if entry.kind == FileKind::Directory {
						items.push(PaletteItem::directory(idx as u64 + 3000, entry.path.clone()));
					}
				}
				if !items.is_empty() {
					state.items = items;
				}
			}
		},
		PaletteMode::Commands | PaletteMode::Sessions | PaletteMode::Models => {},
	}
}
