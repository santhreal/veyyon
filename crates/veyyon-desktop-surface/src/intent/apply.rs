//! Execution and local state application for operator intents (§4.1, §5.14).

use crate::{
	attach::ConnectionPhase, composer::TurnPhase, controls::Availability, intent::Intent,
	model::ShellState, overlay::Overlay,
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
		Intent::SelectTab(index) => {
			if let Some(&tab) = state.panel.tabs.get(*index) {
				state.panel.active_tab = tab;
				state.keymap.panel_collapsed = false;
			}
		},
		Intent::SetDrawer { open } => state.drawer_open = *open,
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
		Intent::Send { .. } | Intent::Steer(_) | Intent::Queue(_) | Intent::AbortTurn => {},
		Intent::SetQueueMode(mode) => {
			state.composer.queue_mode = *mode;
			if let TurnPhase::Running { queue_mode } = &mut state.turn {
				*queue_mode = *mode;
			}
		},
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
		// palette and dispatches what the row stands for; a directory row is
		// a step of navigation and is the one the shell finishes alone.
		Intent::PaletteRun => {
			if let Some(Overlay::Palette(palette)) = &mut state.overlay
				&& let Some(crate::palette::PaletteItemKind::Directory { path }) =
					palette.selected_item().map(|item| item.kind.clone())
			{
				palette.descend(path);
			}
		},
		Intent::PaletteAscend => {
			if let Some(Overlay::Palette(palette)) = &mut state.overlay {
				palette.ascend();
			}
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
		Intent::SelectTheme(theme) => {
			if let Some(Overlay::Settings(settings)) = &mut state.overlay
				&& let Some(themes) = &mut settings.themes
			{
				themes.current.clone_from(theme);
			}
		},
		Intent::ReloadSettings => {
			if let Some(Overlay::Settings(settings)) = &mut state.overlay {
				settings.reloading = true;
			}
		},
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
			}
		},
		Intent::ClearTerminal => {
			for row in &mut state.drawer.grid_rows {
				for cell in row {
					cell.reset();
				}
			}
		},
		Intent::TerminalInput(_)
		| Intent::ResizeTerminal { .. }
		| Intent::RestartTerminal
		| Intent::ProcessStop(_)
		| Intent::ProcessRestart(_)
		| Intent::ProcessSignal(_) => {},
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
		Intent::DeleteSession(_) | Intent::BranchSession(_) => {},
		Intent::FilterQueue(filter) => {
			let trimmed = filter.trim();
			state.keymap.queue_filter = if trimmed.is_empty() {
				None
			} else {
				Some(filter.clone())
			};
			if let Some(q) = &state.keymap.queue_filter {
				let needle = q.trim().to_lowercase();
				let current_matches =
					state
						.sections
						.iter()
						.flat_map(|(_, rows)| rows.iter())
						.any(|r| {
							let matches_needle = r.title.to_lowercase().contains(&needle)
								|| r.subtitle.to_lowercase().contains(&needle);
							r.id == state.current_id && matches_needle
						});
				if !current_matches
					&& let Some(first) = state
						.sections
						.iter()
						.flat_map(|(_, rows)| rows.iter())
						.find(|r| {
							r.title.to_lowercase().contains(&needle)
								|| r.subtitle.to_lowercase().contains(&needle)
						}) {
					state.current_id = first.id;
					state.title = first.title.clone();
				}
			}
		},
		Intent::NewSession => {
			state.current_id = 0;
			state.title = "new session".to_string();
			state.keymap.queue_filter = None;
		},
		Intent::CloseTabOrPark => {
			if state.panel.tabs.len() > 1 {
				let current_pos = state
					.panel
					.tabs
					.iter()
					.position(|&t| t == state.panel.active_tab)
					.unwrap_or(0);
				state.panel.tabs.remove(current_pos);
				let new_pos = current_pos.min(state.panel.tabs.len().saturating_sub(1));
				if let Some(&tab) = state.panel.tabs.get(new_pos) {
					state.panel.active_tab = tab;
				}
			} else {
				state.keymap.parked_session = Some(state.current_id);
			}
		},
		Intent::MoveQueueSelection(delta) => {
			state.keymap.selection_delta = *delta;
			let needle = state
				.keymap
				.queue_filter
				.as_ref()
				.map(|q| q.trim().to_lowercase())
				.filter(|s| !s.is_empty());
			let matching_rows: Vec<u64> = state
				.sections
				.iter()
				.flat_map(|(_, rows)| rows.iter())
				.filter(|r| {
					if let Some(needle) = &needle {
						r.title.to_lowercase().contains(needle)
							|| r.subtitle.to_lowercase().contains(needle)
					} else {
						true
					}
				})
				.map(|r| r.id)
				.collect();
			if !matching_rows.is_empty() {
				let current_idx = matching_rows
					.iter()
					.position(|&id| id == state.current_id)
					.unwrap_or(0);
				let next_idx =
					((current_idx as i64 + *delta as i64).max(0) as usize).min(matching_rows.len() - 1);
				let next_id = matching_rows[next_idx];
				state.current_id = next_id;
				if let Some(title) = state.row(next_id).map(|r| r.title.clone()) {
					state.title = title;
				}
			}
		},
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
		Intent::OpenFile(path) => {
			state.keymap.panel_collapsed = false;
			state.panel.active_tab = crate::right_panel::PanelTab::File;
			state.panel.tree.selected_path = Some(path.clone());
		},
		Intent::OpenUsage => {
			state.keymap.panel_collapsed = false;
			state.panel.active_tab = crate::right_panel::PanelTab::Usage;
			// The turn footer can be clicked before the host has listed the tab.
			// Adding it here keeps the click answerable; a host that reports
			// usage unavailable drops it again on the next projection.
			if !state
				.panel
				.tabs
				.contains(&crate::right_panel::PanelTab::Usage)
			{
				state.panel.tabs.push(crate::right_panel::PanelTab::Usage);
			}
		},
		Intent::ToggleTreeNode(path) => {
			if state.panel.tree.expanded_paths.contains(path) {
				state.panel.tree.expanded_paths.remove(path);
			} else {
				state.panel.tree.expanded_paths.insert(path.clone());
			}
			for row in &mut state.panel.tree.rows {
				if row.path == *path {
					row.is_expanded = !row.is_expanded;
				}
			}
		},
		Intent::ExpandContext { file, row } => {
			if let Some(diff_file) = state.panel.diff.get_mut(*file)
				&& let Some(crate::right_panel::DiffRow::Collapsed { hidden, before_line, after_line }) =
					diff_file.rows.get(*row).cloned()
			{
				let mut expanded_rows = Vec::with_capacity(hidden);
				for i in 0..hidden {
					expanded_rows.push(crate::right_panel::DiffRow::Context {
						old_line: before_line + 1 + i,
						new_line: after_line + 1 + i,
						text:     String::new(),
					});
				}
				diff_file.rows.splice(*row..=*row, expanded_rows);
			}
		},
		// The host owns both: it regenerates the card's view for the new
		// disclosure state, and it resolves a target against the workspace.
		Intent::SetToolViewExpanded { .. } => {},
		Intent::OpenToolTarget(target) => {
			if let crate::tool_view::ToolViewTarget::File { path, .. } = target {
				state.keymap.panel_collapsed = false;
				state.panel.active_tab = crate::right_panel::PanelTab::File;
				state.panel.tree.selected_path = Some(path.clone());
			}
		},
		Intent::SelectChangeScope(_) => {
			state.keymap.panel_collapsed = false;
			state.panel.active_tab = crate::right_panel::PanelTab::Diff;
		},
	}
}
