//! Execution and local state application for operator intents (§4.1, §5.14).

mod panel;
mod queue;

use crate::{
	attach::ConnectionPhase, composer::TurnPhase, controls::Availability, intent::Intent,
	model::ShellState, overlay::Overlay, palette::PaletteMode,
};

/// Applies the part of an intent that the local shell owns.
pub fn apply_intent(intent: &Intent, state: &mut ShellState) {
	match intent {
		Intent::SelectSession(id) => {
			state.current_id = *id;
			if let Some(title) = state.row(*id).map(|row| row.title.clone()) {
				state.title = title;
			}
		},
		Intent::SelectTab(tab) => {
			if state.panel.tabs.contains(tab) {
				state.panel.active_tab = *tab;
				state.keymap.panel_collapsed = false;
			}
		},
		// §5.13: the drawer opens only where the host offers a terminal or a
		// supervised process. Closing it always lands, so a drawer left open by
		// a host that offered one closes when the next one does not.
		Intent::SetDrawer { open } => state.drawer_open = *open && state.drawer.offered,
		Intent::Approval { card, .. } | Intent::Answer { card, .. } | Intent::Plan { card, .. } => {
			if state.cards.get(*card).is_some() {
				state.cards.remove(*card);
			}
		},
		Intent::Reply { card, .. } => {
			if state.cards.get(*card).is_some() {
				state.cards.remove(*card);
			}
		},
		// Turn state and attachments change on host acknowledgement, not on a request attempt.
		Intent::Send { .. }
		| Intent::Steer(_)
		| Intent::Queue(_)
		| Intent::AbortTurn
		| Intent::DequeueQueuedPrompt => {},
		// The clipboard is the platform's, not the shell's: the write happens
		// where the intent is dispatched, and no state changes here.
		Intent::CopyText(_) => {},
		Intent::SetQueueMode(mode) => {
			state.composer.queue_mode = *mode;
			if let TurnPhase::Running { queue_mode } = &mut state.turn {
				*queue_mode = *mode;
			}
		},
		// The mode is the session's and the host records it; the chip changes
		// when the header comes back, so a refused request leaves no mode
		// drawn that the agent is not in.
		Intent::SetPlanMode { .. } => {},
		// Selection remains host-confirmed; a failed request cannot replace the displayed value.
		Intent::SelectModel(_) | Intent::SetThinking(_) => {},
		Intent::Attach(attachment) => state.composer.attach(attachment.clone()),
		Intent::RemoveAttachment(index) => state.composer.detach(*index),
		Intent::RetryConnection => {
			state.connection = ConnectionPhase::Connecting { attempt: 1 };
		},
		Intent::StartProviderAuth(provider) => {
			state.connection = ConnectionPhase::NeedsSecret { provider: provider.clone() };
		},
		Intent::SubmitAuthSecret { .. } => {
			state.connection = ConnectionPhase::Connecting { attempt: 1 };
		},
		Intent::OpenAuthUrl(url) => {
			state.connection =
				ConnectionPhase::AwaitingExternalUrl { provider: String::new(), url: url.clone() };
		},
		Intent::CancelAuthFlow => {
			state.connection = ConnectionPhase::Detached;
		},
		Intent::RetryAuthFlow => {
			state.connection = ConnectionPhase::Connecting { attempt: 1 };
		},
		Intent::RetryControl(id) => {
			state.controls.clear_error(id);
			state
				.controls
				.set_availability(id.clone(), Availability::Pending);
		},
		Intent::DismissError(id) => {
			state.controls.clear_error(id);
		},
		Intent::OpenOverlay(overlay) => {
			state.overlay = Some(overlay.as_ref().clone());
		},
		Intent::Navigate(route) => {
			let mut destination = route.overlay();
			if let (Some(Overlay::Settings(current)), Overlay::Settings(next)) =
				(&state.overlay, &mut destination)
			{
				let page = next.page;
				next.clone_from(current);
				next.page = page;
				next.route = Some(*route);
			}
			state.overlay = Some(destination);
		},
		Intent::CloseOverlay => {
			state.overlay = None;
		},
		Intent::PaletteQuery(query) => {
			if let Some(Overlay::Palette(palette)) = &mut state.overlay {
				palette.set_query(query.clone());
			}
		},
		Intent::PaletteMove(delta) => {
			if let Some(Overlay::Palette(palette)) = &mut state.overlay {
				palette.move_selection(*delta);
			}
		},
		// An action row is run by `Intents::dispatch`, which closes the
		// palette and dispatches what the row stands for; a directory row
		// stands for a listing, which the shell turns into `BrowseTo`.
		Intent::PaletteRun => {},
		// A listing opens the mode that draws it, since the command row that
		// asked for one is run from another mode's list and closes it.
		Intent::BrowseTo { path } => {
			state.palette_in(PaletteMode::Browse, |palette| palette.browse_to(path.clone()));
		},
		// A lookup's rows are the host's answer to one query, so emptying the
		// field drops them here rather than leaving them drawn until a frame
		// arrives: an empty query asks for no search, so no answer is on its
		// way to replace them (§5.8).
		Intent::FindFile(query) => {
			state.palette_in(PaletteMode::Files, |palette| {
				palette.set_query(query.clone());
				if query.is_empty() {
					palette.set_items(Vec::new());
				}
			});
		},
		Intent::FindText(query) => {
			state.palette_in(PaletteMode::ContentSearch, |palette| {
				palette.set_query(query.clone());
				if query.is_empty() {
					palette.set_items(Vec::new());
				}
			});
		},
		Intent::SettingChanged { key, value } => {
			if let Some(Overlay::Settings(settings)) = &mut state.overlay
				&& let Some(entry) = settings.settings.get_mut(key)
			{
				entry.value = value.clone();
			}
		},
		Intent::ResetSetting(key) => {
			if let Some(Overlay::Settings(settings)) = &mut state.overlay
				&& let Some(entry) = settings.settings.get_mut(key)
			{
				entry.value = entry.default.clone();
			}
		},
		Intent::KeybindingChanged { action, keys } => {
			if let Some(Overlay::Settings(settings)) = &mut state.overlay
				&& let Some(binding) = settings
					.keybindings
					.iter_mut()
					.find(|binding| binding.action == *action)
			{
				binding.keys.clone_from(keys);
				"user".clone_into(&mut binding.source);
			}
		},
		// The agents listing is the host's: a spawned task appears in it when
		// the host answers with it, never on the request that asked for it.
		Intent::SpawnTask(_) => {},
		Intent::SelectTheme(theme) => {
			if let Some(Overlay::Settings(settings)) = &mut state.overlay
				&& let Some(themes) = &mut settings.themes
			{
				themes.current.clone_from(theme);
			}
		},
		// The pointer resting on an appearance row draws that appearance, and
		// leaving the row draws the choice again. Only the name is recorded
		// here: the window re-installs the tokens when it sees the state
		// change, because an install needs the app context an apply has not
		// got.
		Intent::PreviewAppearance(appearance) => state.appearance.preview(appearance.as_deref()),
		Intent::SelectAppearance(appearance) => state.appearance.choose(appearance),
		Intent::ReloadSettings => {
			if let Some(Overlay::Settings(settings)) = &mut state.overlay {
				settings.reloading = true;
			}
		},
		// The card goes on the press that dismissed it. The queue the host's
		// model holds is cleared by the same intent, so the next projection
		// states the same stack this frame already drew.
		Intent::DismissNotice(key) => state.notices.retain(|notice| &notice.key != key),
		Intent::SetMcpEnabled { server, enabled } => {
			if let Some(Overlay::Settings(settings)) = &mut state.overlay
				&& let Some(view) = settings.mcp.iter_mut().find(|view| view.name == *server)
			{
				view.enabled = *enabled;
			}
		},
		// A refresh has nothing local to show until the host answers with the
		// snapshot the projection draws.
		Intent::RefreshDiagnostics | Intent::RetryDiagnosticSource(_) | Intent::RefreshUsage => {},
		Intent::SelectDrawerTab(index) => {
			if *index < state.drawer.tabs.len() {
				state.drawer.active_tab = *index;
				state.drawer.tab_chosen = true;
			}
		},
		// The tab moves as soon as it is clicked; the log lines it shows arrive
		// with the host's answer to the request this intent also sends.
		Intent::OpenProcessLogs(name) => {
			if let Some(index) = state.drawer.process_tab_index(name) {
				state.drawer.active_tab = index;
				state.drawer.tab_chosen = true;
			}
		},
		Intent::ClearTerminal => {
			for row in &mut state.drawer.grid_rows {
				for cell in row {
					cell.reset();
				}
			}
		},
		// The window measured the grid; the host is told the same size, and
		// what the drawer holds is what it was measured at, so the next
		// projection breaks the output at this width rather than the last.
		Intent::ResizeTerminal { cols, rows } => {
			state.drawer.grid_cells = (*cols, *rows);
		},
		Intent::TerminalInput(_)
		| Intent::RestartTerminal
		| Intent::CloseTerminal
		| Intent::NewTerminal
		| Intent::ClearOutput
		| Intent::CancelTool { .. }
		| Intent::ProcessStart { .. }
		| Intent::ProcessSend { .. }
		| Intent::ProcessStop(_)
		| Intent::ProcessRestart(_)
		| Intent::ProcessSignal { .. } => {},
		Intent::PinSession(id) => {
			state.keymap.pinned_session = Some(*id);
		},
		Intent::UnpinSession(id) => {
			if state.keymap.pinned_session == Some(*id) {
				state.keymap.pinned_session = None;
			}
		},
		Intent::DeferSession(id) => {
			state.keymap.deferred_session = Some(*id);
		},
		Intent::ParkSession(id) => {
			state.keymap.parked_session = Some(*id);
		},
		Intent::UnparkSession(id) => {
			if state.keymap.parked_session == Some(*id) {
				state.keymap.parked_session = None;
			}
		},
		Intent::RecallSession(id) => {
			if state.keymap.deferred_session == Some(*id) {
				state.keymap.deferred_session = None;
			}
		},
		Intent::RenameSession { session, title } => {
			if state.current_id == *session {
				state.title.clone_from(title);
			}
			if let Some(row) = state.row_mut(*session) {
				row.title.clone_from(title);
			}
		},
		Intent::DeleteSession(_)
		| Intent::BranchSession(_)
		| Intent::BranchTurn(_)
		| Intent::ExportSession(_)
		| Intent::CompactSession(_)
		| Intent::HandoffSession(_)
		| Intent::LoadTranscript(_) => {},
		Intent::FilterQueue(filter) => queue::filter(state, filter),
		Intent::NewSession => {
			state.current_id = 0;
			state.title = "new session".to_string();
			state.keymap.queue_filter = None;
		},
		Intent::CloseTabOrPark => queue::close_tab_or_park(state),
		Intent::MoveQueueSelection(delta) => queue::move_selection(state, *delta),
		Intent::ScrollTranscript(by) => {
			state.keymap.transcript_scroll = Some(*by);
		},
		Intent::FindInTranscript => {
			state.keymap.find_open = !state.keymap.find_open;
		},
		Intent::StepTurn(delta) => {
			// The cursor stays on a turn that exists. Stepping past the last one
			// used to park it outside the transcript, where the focused turn
			// names no model and `space` disclosed nothing.
			if let Some(last) = state.transcript.len().checked_sub(1) {
				let current = state.keymap.focused_turn.unwrap_or(0);
				let step = usize::try_from(delta.unsigned_abs()).unwrap_or(usize::MAX);
				let stepped = if *delta < 0 {
					current.saturating_sub(step)
				} else {
					current.saturating_add(step)
				};
				state.keymap.focused_turn = Some(stepped.min(last));
				state.keymap.pending_turn_focus = true;
			}
		},
		Intent::ToggleBlock => {
			state.keymap.focused_block_collapsed = !state.keymap.focused_block_collapsed;
		},
		Intent::ToggleQueue => {
			state.keymap.queue_collapsed = !state.keymap.queue_collapsed;
		},
		Intent::SetPanel { open } => {
			state.keymap.panel_collapsed = !*open;
		},
		Intent::SetDiffMode(mode) => {
			state.panel.diff_mode = *mode;
		},
		Intent::OpenFile(path) => panel::open_file(state, path),
		Intent::OpenUsage => panel::open_usage(state),
		Intent::ToggleTreeNode(path) => panel::toggle_tree_node(state, path),
		Intent::ExpandContext { file, row } => panel::expand_context(state, *file, *row),
		// The host owns both: it regenerates the card's view for the new
		// disclosure state, and it resolves a target against the workspace.
		Intent::SetToolViewExpanded { .. } => {},
		Intent::OpenToolTarget(target) => panel::open_tool_target(state, target),
		Intent::SelectChangeScope(_) => panel::select_change_scope(state),
		Intent::SetMenuSection(section) => match section {
			Some(section) => state.menu.toggle_section(*section),
			None => state.menu.close(),
		},
		Intent::MoveMenuHighlight(delta) => state.menu.move_highlight(*delta),
		Intent::MoveMenuSection(delta) => state.menu.move_section(*delta),
		// Both belong to the window and the process. The bar closes, because
		// a window that comes back has no menu open in it.
		Intent::CloseWindow | Intent::Quit => state.menu.close(),
	}
}
