//! Projection from protocol store domains onto overlay view models (§5.8,
//! §5.9).
//!
//! Synchronizes host settings, themes, keybindings, providers, authentication,
//! file trees, and search results onto active `Overlay::Settings` and
//! `Overlay::Palette` state.

use veyyon_desktop_model::{Capability, CapabilityStatus, FileKind, Store};
use veyyon_desktop_surface::{
	AgentsState, AutoswarmState, Intent, Overlay, PaletteItem, PaletteItemKind, PaletteMode,
	PaletteState, SettingsState, ShareState, ShellState,
	cards::line_age,
	navigation::SurfaceRoute,
	palette::{HostCommands, PaletteMeta, commands::command_items, host_commands},
};

use super::menu::{command_declined, unavailable};

/// Whether the palette already lists exactly the host rows in `listed`.
///
/// The rows a command list holds outlive one projection, so rebuilding them
/// on every store change would re-rank the whole catalogue for a frame that
/// changed nothing about it. A row that runs a host command is the one the
/// window did not author, which is how they are told apart from the native
/// rows they sit beside.
fn holds(state: &PaletteState, listed: &[PaletteItem]) -> bool {
	let held = state.items().iter().filter(|item| {
		matches!(&item.kind, PaletteItemKind::Command { intent }
			if matches!(**intent, Intent::RunCommand(_)))
	});
	held.eq(listed.iter())
}

/// Projects domain store views onto active overlay state fields. `now_ms` is
/// the frame's clock, which states how long ago a prompt was submitted.
pub fn project_overlay(store: &Store, now_ms: u64, state: &mut ShellState) {
	project_commands(store, state);
	project_autoswarm_console(store, state);
	match &mut state.overlay {
		Some(Overlay::Settings(settings_state)) => {
			project_settings_domains(store, settings_state);
		},
		Some(Overlay::Palette(palette_state)) => {
			project_palette_domains(store, &state.commands, now_ms, palette_state);
		},
		Some(Overlay::Agents(agents_state)) => project_agents_domains(store, agents_state),
		Some(Overlay::Share(share_state)) => project_share_domains(store, share_state),
		Some(Overlay::Autoswarm(_) | Overlay::History(_)) | None => {},
	}
}

/// Opens the console the host states is open, and closes it when the host
/// states none.
///
/// The console is the host's surface rather than the window's: the command
/// that opened it is waiting on it, so a window that opened one of its own
/// would draw a console no command is behind, and one that kept the overlay
/// after the command returned would draw a setup nothing reads. A console
/// that arrives while another overlay is open replaces it, because the
/// operator's own command is what asked for it.
fn project_autoswarm_console(store: &Store, state: &mut ShellState) {
	let console = store
		.persisted
		.shell
		.active_session
		.as_ref()
		.and_then(|session| store.domains.autoswarm.get(session));
	match console {
		Some(console) => {
			if let Some(open) = state.overlay.as_mut().and_then(Overlay::as_autoswarm_mut) {
				open.console = Some(console.clone());
				return;
			}
			let mut opened = AutoswarmState::new();
			opened.console = Some(console.clone());
			state.overlay = Some(Overlay::Autoswarm(Box::new(opened)));
		},
		None => {
			if state
				.overlay
				.as_ref()
				.is_some_and(|overlay| overlay.as_autoswarm().is_some())
			{
				state.overlay = None;
			}
		},
	}
}

/// Files the host's catalogue on the state, as the rows a command surface
/// lists and the spellings that take a message after them.
///
/// Kept whether or not a surface is open: the catalogue arrives with a host
/// event and a palette is opened by a keystroke, so composing the rows only
/// while one is open leaves the surface listing the window's own rows until
/// the next unrelated event (§5.8).
///
/// §5.13: a command whose capability the host declined is not listed rather
/// than listed and refused, so the rows are pruned here, where the store
/// states what the host offers.
fn project_commands(store: &Store, state: &mut ShellState) {
	let native = command_items();
	let titles: Vec<&str> = native.iter().map(|item| item.title.as_str()).collect();
	let mut listed = host_commands(&store.domains.commands, &titles);
	listed.rows.retain(|item| {
		item
			.capability
			.is_none_or(|capability| !unavailable(store, capability))
	});
	state.commands = listed;
}

/// Populates the agent dashboard from the roster and the traffic the host
/// sends. Each is replaced whole: the host states the whole roster and the
/// whole stream every time, so an agent that left is gone rather than drawn
/// from the last frame that held it.
fn project_agents_domains(store: &Store, state: &mut AgentsState) {
	state.agents.clone_from(&store.domains.agents);
	state.agent_comms.clone_from(&store.domains.agent_comms);
}

/// Populates share overlay state from the host's share domain snapshot.
fn project_share_domains(store: &Store, state: &mut ShareState) {
	state.share.clone_from(&store.domains.share);
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
	if let Some(profiles) = &store.domains.profiles {
		state.profiles = Some(profiles.clone());
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

/// Populates palette items from file tree, search result and prompt history
/// domains. `now_ms` is the window's clock, which states how long ago a
/// prompt was submitted.
fn project_palette_domains(
	store: &Store,
	commands: &HostCommands,
	now_ms: u64,
	state: &mut PaletteState,
) {
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
		// Rows are the prompts the host reported, for the empty query as much
		// as for a typed one: the mode opens on the most recent prompts, and
		// what is typed narrows them. A host that reported none leaves the
		// rows empty rather than keeping a previous query's answer drawn.
		PaletteMode::PromptHistory => {
			if let Some(found) = &store.domains.prompt_history {
				let items = found
					.entries
					.iter()
					.enumerate()
					.map(|(idx, entry)| {
						PaletteItem::prompt(
							idx as u64 + 4000,
							entry.prompt.clone(),
							line_age(now_ms, entry.submitted_at_ms),
						)
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
		// The commands the host lists are rows beside the window's own, so a
		// command this workspace installed is reachable from the same list.
		// They are rebuilt only when the host's catalogue changes, because
		// ranking a whole command list is the expensive part of the surface
		// and the projection runs on every store change.
		PaletteMode::Commands => {
			let is_root = matches!(state.route(), None | Some(SurfaceRoute::Commands));
			if is_root {
				state.notice = match store.capabilities.get(Capability::AgentCommands) {
					CapabilityStatus::Unavailable { reason } => Some(reason.clone()),
					_ => None,
				};
			}
			// A group under the command surface lists the pages beneath it,
			// which the route put there; only the surface itself lists what
			// the host can run.
			if is_root && !holds(state, &commands.rows) {
				let mut items = command_items();
				items.extend(commands.rows.iter().cloned());
				state.set_items(items);
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
		PaletteItemKind::Composer { command } => command
			.capability()
			.is_none_or(|capability| !unavailable(store, capability)),
		// A row that carries a verb is gated on that verb, from the one
		// definition the menu bar's entries are gated on. That is what
		// resolves the drawer here without restating its two tenants: a row
		// with no verb of its own states a capability instead.
		_ => match &item.meta {
			Some(PaletteMeta::Chord(command)) => !command_declined(store, *command),
			_ => item
				.capability
				.is_none_or(|capability| !unavailable(store, capability)),
		},
	});
}
