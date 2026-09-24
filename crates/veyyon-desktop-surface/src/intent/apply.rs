//! Execution and local state application for operator intents (§4.1, §5.14).

mod overlay;
mod panel;
mod queue;
mod settings;

use crate::{
	attach::ConnectionPhase, composer::TurnPhase, controls::Availability, intent::Intent,
	model::ShellState, palette::PaletteMode,
};

/// Applies the part of an intent that the local shell owns.
pub fn apply_intent(intent: &Intent, state: &mut ShellState) {
	match intent {
		// A rejected load leaves the displayed title, focus and draft on the
		// confirmed session, so the open is the host's to acknowledge. The
		// cursor is dropped rather than moved to the requested row: it then
		// reads as the open session, which is the row the host has answered
		// for, and the arrows continue from whatever the acknowledgement
		// opened. Moving it here instead revealed the requested row while the
		// load was pending, which expands the partition holding it.
		Intent::SelectSession(_) => {
			state.keymap.queue_cursor = None;
		},
		Intent::OpenSession(_)
		| Intent::CloseSessionTab(_)
		| Intent::ReorderSessionTab { .. }
		| Intent::CreateSpace(_)
		| Intent::RenameSpace { .. }
		| Intent::SwitchSpace(_) => {},
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
		Intent::SetSessionMode { .. } => {},
		// Selection remains host-confirmed; a failed request cannot replace the displayed value.
		Intent::SelectModel { .. } | Intent::SetThinking(_) => {},
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
		Intent::Navigate(route) => overlay::navigate(state, *route),
		Intent::CloseOverlay => {
			state.overlay = None;
		},
		Intent::SetAgentsTab(tab) => overlay::agents_tab(state, *tab),
		Intent::ConfirmTermination(id) => overlay::confirm_termination(state, id.as_ref()),
		Intent::PaletteQuery(query) => overlay::palette_query(state, query),
		Intent::PaletteMove(delta) => overlay::palette_move(state, *delta),
		// An action row is run by `Intents::dispatch`, which closes the
		// palette and dispatches what the row stands for; a directory row
		// stands for a listing, which the shell turns into `BrowseTo`.
		Intent::PaletteRun => {},
		// A listing opens the mode that draws it, since the command row that
		// asked for one is run from another mode's list and closes it.
		Intent::BrowseTo { path } => overlay::browse_to(state, path.as_ref()),
		Intent::FindFile(query) => overlay::find_in(state, PaletteMode::Files, query),
		Intent::FindText(query) => overlay::find_in(state, PaletteMode::ContentSearch, query),
		Intent::FindPrompt(query) => overlay::find_in(state, PaletteMode::PromptHistory, query),
		// The recalled text reaches the composer through the shell, which owns
		// the editor; the palette it was picked from closes here.
		Intent::RecallPrompt(_) => state.overlay = None,
		Intent::FindSessions(query) => overlay::find_sessions(state, query),
		Intent::PreviewSession(session) => overlay::preview_session(state, session),
		Intent::ResumeHistory(_) => state.overlay = None,
		Intent::SettingChanged { key, value } => settings::setting_changed(state, key, value),
		Intent::ResetSetting(key) => settings::reset_setting(state, key),
		Intent::KeybindingChanged { action, keys } => {
			settings::keybinding_changed(state, action, keys);
		},
		// The agents listing is the host's: a spawned task appears in it when
		// the host answers with it, never on the request that asked for it.
		Intent::SpawnTask(_) => {},
		Intent::StartShare { .. }
		| Intent::StopShare
		| Intent::RefreshShare
		| Intent::JoinShare { .. }
		| Intent::LeaveShare => {},
		Intent::SelectTheme { id, dark } => settings::select_theme(state, id, *dark),
		// The pointer resting on an appearance row draws that appearance, and
		// leaving the row draws the choice again. Only the name is recorded
		// here: the window re-installs the tokens when it sees the state
		// change, because an install needs the app context an apply has not
		// got.
		Intent::PreviewAppearance(appearance) => state.appearance.preview(appearance.as_deref()),
		Intent::SelectAppearance(appearance) => state.appearance.choose(appearance),
		Intent::ReloadSettings => settings::reload_settings(state),
		// The card goes on the press that dismissed it. The queue the host's
		// model holds is cleared by the same intent, so the next projection
		// states the same stack this frame already drew.
		Intent::DismissNotice(key) => state.notices.retain(|notice| &notice.key != key),
		Intent::SetMcpEnabled { server, enabled } => {
			settings::set_mcp_enabled(state, server, *enabled);
		},
		Intent::ToggleProfileCopy(key) => settings::toggle_profile_copy(state, key),
		// What the page draws is the host's listing, so a create, a rename and
		// a delete change nothing here until the listing comes back with the
		// change in it. A row that changed on the press would state a profile
		// the store had refused to write.
		Intent::RefreshProfiles
		| Intent::CreateProfile { .. }
		| Intent::RenameProfile { .. }
		| Intent::DeleteProfile(_) => {},
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
		// A command runs at the host and changes nothing the window holds
		// until the host answers with what it did.
		Intent::DeleteSession(_)
		| Intent::BranchSession(_)
		| Intent::BranchTurn(_)
		| Intent::RetryTurn
		| Intent::RephraseReply
		| Intent::ReviewPlan
		| Intent::SetGoal { .. }
		| Intent::ControlGoal { .. }
		| Intent::PauseAgents
		| Intent::ResumeAgents
		| Intent::ExportSession(_)
		| Intent::CompactSession(_)
		| Intent::HandoffSession(_)
		| Intent::RunCommand(_)
		| Intent::LoadTranscript(_)
		| Intent::ToggleDictation
		| Intent::CancelDictation => {},
		Intent::ToggleGoalCard => crate::cards::toggle_goal_card(state),
		Intent::FilterQueue(filter) => queue::filter(state, filter),
		Intent::NewSession => {
			state.keymap.queue_filter = None;
		},
		Intent::CloseTab(tab) => queue::close_tab(state, *tab),
		Intent::CloseTabOrPark => queue::close_tab_or_park(state),
		Intent::MoveQueueSelection(delta) => queue::move_selection(state, *delta),
		// A fold changes which rows exist, and the rows are projected. The
		// window writes the fold where the projection reads it, so the frame
		// it produces is the frame the next host event produces too; folding
		// the drawn state here instead would come undone on that event.
		Intent::ToggleQueueParent(_) => {},
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
