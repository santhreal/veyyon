//! Projection from protocol store domains onto overlay view models (§5.8,
//! §5.9).
//!
//! Synchronizes host settings, themes, keybindings, providers, authentication,
//! file trees, and search results onto active `Overlay::Settings` and
//! `Overlay::Palette` state.

use veyyon_desktop_model::{Capability, CapabilityStatus, FileKind, Store};
use veyyon_desktop_surface::{
	Intent, Overlay, PaletteItem, PaletteItemKind, PaletteMode, PaletteState, SettingsState,
	ShellState, navigation::SurfaceRoute,
};

use super::drawer::drawer_offered;

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

/// Whether the host stated it does not carry the capability, as against not
/// having said yet (§4.3): an unattached host holds nothing back.
const fn unavailable(store: &Store, capability: Capability) -> bool {
	matches!(store.capabilities.get(capability), CapabilityStatus::Unavailable { .. })
}

/// Populates palette items from file tree and search result domains.
fn project_palette_domains(store: &Store, state: &mut PaletteState) {
	match state.mode {
		// What was typed is answered by the host's search, and the workspace
		// tree is what the mode opened on: rows follow the query, so a lookup
		// that matches nothing states that rather than leaving the tree drawn.
		PaletteMode::Files => {
			let items: Option<Vec<PaletteItem>> = if state.query().is_empty() {
				store.domains.file_tree.as_ref().map(|tree| {
					tree
						.entries
						.iter()
						.enumerate()
						.filter(|(_, entry)| entry.kind == FileKind::File)
						.map(|(idx, entry)| PaletteItem::file(idx as u64 + 1000, entry.path.clone()))
						.collect()
				})
			} else {
				store.domains.search.as_ref().map(|search| {
					search
						.paths
						.iter()
						.enumerate()
						.map(|(idx, path)| PaletteItem::file(idx as u64 + 1000, path.clone()))
						.collect()
				})
			};
			if let Some(items) = items {
				state.set_items(items);
			}
		},
		// Rows are the lines the host reported for what was typed. Nothing is
		// listed for the empty query, since no listing of every line of the
		// workspace exists to open the mode on, and a stale match set from a
		// previous query is not what the empty field states.
		PaletteMode::ContentSearch => {
			if state.query().is_empty() {
				state.set_items(Vec::new());
			} else if let Some(found) = &store.domains.content_matches {
				let items = found
					.matches
					.iter()
					.enumerate()
					.map(|(idx, m)| {
						PaletteItem::content_match(idx as u64 + 2000, m.path.clone(), m.line, &m.preview)
					})
					.collect();
				state.set_items(items);
			}
		},
		// The host was asked for one directory's listing, so the rows are its
		// immediate children: a deeper entry belongs to a row the operator has
		// not opened yet, and listing it flattens the walk into one dump of
		// the tree. A directory with no subdirectory lists nothing rather than
		// keeping the rows of the one above it.
		PaletteMode::Browse => {
			if let Some(tree) = &store.domains.file_tree {
				let items = tree
					.entries
					.iter()
					.enumerate()
					.filter(|(_, entry)| entry.kind == FileKind::Directory && entry.depth == 0)
					.map(|(idx, entry)| PaletteItem::directory(idx as u64 + 3000, entry.path.clone()))
					.collect();
				state.set_items(items);
			}
		},
		// Native navigation does not invoke the host's separate agent-command API,
		// but reflects its availability notice on the root command surface when unavailable.
		PaletteMode::Commands => {
			let is_root = matches!(state.route(), None | Some(SurfaceRoute::Commands));
			if is_root {
				state.notice = match store.capabilities.get(Capability::AgentCommands) {
					CapabilityStatus::Unavailable { reason } => Some(reason.clone()),
					_ => None,
				};
			}
			// §5.13: a command whose action the host declines is a surface the
			// host does not offer, so it is not listed rather than listed and
			// refused. A row states the capability it rides on, and the two
			// exceptions are resolved below: the drawer has two tenants, and a
			// composer command answers for itself.
		},
		PaletteMode::Sessions | PaletteMode::Models => {},
	}
	// The filter runs on every projection and over every mode, so a row
	// follows its capability while the palette stays open: a host that
	// withdraws the workspace leaves no file, directory or match row behind.
	state.retain_items(|item| match &item.kind {
		PaletteItemKind::Command { intent }
			if matches!(**intent, Intent::SetDrawer { open: true }) =>
		{
			drawer_offered(&store.capabilities)
		},
		PaletteItemKind::Composer { command } => command
			.capability()
			.is_none_or(|capability| !unavailable(store, capability)),
		_ => item
			.capability
			.is_none_or(|capability| !unavailable(store, capability)),
	});
}
