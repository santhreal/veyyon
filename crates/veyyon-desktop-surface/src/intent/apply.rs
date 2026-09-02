//! Execution and local state application for operator intents (§4.1, §5.14).

use crate::{
	attach::ConnectionPhase,
	composer::{QueueMode, TurnPhase},
	controls::Availability,
	intent::Intent,
	model::ShellState,
	overlay::Overlay,
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
		Intent::Send { .. } => {
			state.turn = TurnPhase::Running { queue_mode: state.composer.queue_mode };
			state.composer.attachments.clear();
		},
		Intent::Steer(_) => {
			state.turn = TurnPhase::Running { queue_mode: QueueMode::Steer };
		},
		Intent::Queue(_) => {
			state.turn = TurnPhase::Running { queue_mode: QueueMode::Queue };
		},
		Intent::AbortTurn => {
			state.turn = TurnPhase::Idle;
		},
		Intent::SetQueueMode(mode) => {
			state.composer.queue_mode = *mode;
			if let TurnPhase::Running { queue_mode } = &mut state.turn {
				*queue_mode = *mode;
			}
		},
		// The model and the level are the host's to confirm: it answers
		// with a Models snapshot, which the projection draws. Until then the
		// control shows what was asked for, so a click is seen to land.
		Intent::SelectModel(choice) => {
			if let Some(model) = &mut state.composer.model {
				model.current = Some(choice.clone());
			}
		},
		Intent::SetThinking(level) => {
			if let Some(thinking) = &mut state.composer.thinking {
				thinking.level.clone_from(&level.level);
			}
		},
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
				&& let Some(entry) = settings.settings.get_mut(key) {
					entry.value = value.clone();
				}
		},
		Intent::ResetSetting(key) => {
			if let Some(Overlay::Settings(settings)) = &mut state.overlay
				&& let Some(entry) = settings.settings.get_mut(key) {
					entry.value = entry.default.clone();
				}
		},
		Intent::SelectTheme(theme) => {
			if let Some(Overlay::Settings(settings)) = &mut state.overlay
				&& let Some(themes) = &mut settings.themes {
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
				&& let Some(view) = settings.mcp.iter_mut().find(|view| view.name == *server) {
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
		Intent::DeferSession(id) => {
			state.keymap.deferred_session = Some(*id);
		},
		Intent::ParkSession(id) => {
			state.keymap.parked_session = Some(*id);
		},
		Intent::FilterQueue(filter) => {
			state.keymap.queue_filter = if filter.is_empty() {
				None
			} else {
				Some(filter.clone())
			};
		},
		Intent::NewSession => {
			state.current_id = 0;
			state.title = "new session".to_string();
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
			let all_rows: Vec<u64> = state
				.sections
				.iter()
				.flat_map(|(_, rows)| rows.iter().map(|r| r.id))
				.collect();
			if !all_rows.is_empty() {
				let current_idx = all_rows
					.iter()
					.position(|&id| id == state.current_id)
					.unwrap_or(0);
				let next_idx =
					((current_idx as i64 + *delta as i64).max(0) as usize).min(all_rows.len() - 1);
				let next_id = all_rows[next_idx];
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
			state.keymap.focused_turn = Some(
				state
					.keymap
					.focused_turn
					.map_or(0, |t| (t as i64 + *delta as i64).max(0) as usize),
			);
		},
		Intent::ToggleBlock => {
			state.keymap.focused_block_collapsed = !state.keymap.focused_block_collapsed;
		},
		Intent::ToggleQueue => {
			state.keymap.queue_collapsed = !state.keymap.queue_collapsed;
		},
		Intent::TogglePanel => {
			state.keymap.panel_collapsed = !state.keymap.panel_collapsed;
		},
		Intent::SetDiffMode(mode) => {
			state.panel.diff_mode = *mode;
		},
		Intent::OpenFile(path) => {
			state.panel.active_tab = crate::right_panel::PanelTab::File;
			state.panel.tree.selected_path = Some(path.clone());
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
				&& let Some(crate::right_panel::DiffRow::Collapsed {
					hidden,
					before_line,
					after_line,
				}) = diff_file.rows.get(*row).cloned()
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
		Intent::SelectChangeScope(_) => {},
	}
}
