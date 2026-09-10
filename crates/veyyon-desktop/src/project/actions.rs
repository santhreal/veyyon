//! From what the operator asked to what the host is sent.

use veyyon_desktop_model::{HostAction, Store, TerminalStatus};
use veyyon_desktop_surface::Intent;

use super::{
	SessionIndex,
	cards::take_interaction,
	submission::submission_of,
	workspace_asks::{open_actions, tab_actions},
};

/// The host actions an intent asks for, in the order they are sent; empty
/// for one the shell finished alone or one that no longer has a target.
///
/// `store` is mutated only for a decision, whose pending interaction is taken
/// out so the next card's position still means the next card.
///
/// Opening a session also refreshes the changes the panel shows, since the
/// host reports them for the workspace and nothing else asks. Opening the
/// drawer attaches to the terminal that is running, replaying its scrollback,
/// or creates one when none is.
pub fn actions_for(intent: &Intent, index: &SessionIndex, store: &mut Store) -> Vec<HostAction> {
	let active = store.persisted.shell.active_session.clone();
	match intent {
		Intent::SelectSession(row) => index.session_of(*row).map_or_else(Vec::new, |session| {
			vec![HostAction::OpenSession { session: session.clone() }, HostAction::RefreshChanges]
		}),
		Intent::Send { text, attachments } => active.map_or_else(Vec::new, |session| {
			vec![HostAction::SubmitPrompt {
				session,
				text: text.clone(),
				attachments: attachments.iter().enumerate().map(submission_of).collect(),
			}]
		}),
		Intent::Steer(text) => active
			.map_or_else(Vec::new, |session| vec![HostAction::Steer { session, text: text.clone() }]),
		Intent::Queue(text) => active.map_or_else(Vec::new, |session| {
			vec![HostAction::FollowUp { session, text: text.clone() }]
		}),
		Intent::AbortTurn => {
			active.map_or_else(Vec::new, |session| vec![HostAction::AbortTurn { session }])
		},
		Intent::DequeueQueuedPrompt => {
			active.map_or_else(Vec::new, |session| vec![HostAction::DequeueQueuedPrompt { session }])
		},
		Intent::SetToolViewExpanded { call_id, expanded } => {
			active.map_or_else(Vec::new, |session| {
				vec![HostAction::SetToolViewExpanded {
					session,
					call_id: call_id.clone(),
					expanded: *expanded,
				}]
			})
		},
		Intent::OpenToolTarget(target) => match target {
			veyyon_desktop_surface::ToolViewTarget::Url(url) => {
				vec![HostAction::OpenExternal { path: url.clone() }]
			},
			veyyon_desktop_surface::ToolViewTarget::File { path, .. } => {
				vec![HostAction::ReadFile { path: path.clone() }]
			},
		},
		// The vocabulary crosses the wire as the type the window decodes it
		// with, so a spelling the host rejects cannot be written here.
		Intent::SetQueueMode(mode) => active
			.map_or_else(Vec::new, |session| vec![HostAction::SetQueueMode { session, mode: *mode }]),
		Intent::SelectModel(choice) => {
			vec![HostAction::SelectModel {
				provider: choice.provider.clone(),
				model:    choice.model.clone(),
			}]
		},
		Intent::SetThinking(level) => {
			vec![HostAction::SetThinkingLevel { level: level.level.clone() }]
		},
		Intent::Approval { card, .. }
		| Intent::Answer { card, .. }
		| Intent::Reply { card, .. }
		| Intent::Plan { card, .. } => {
			let Some(session) = active else {
				return Vec::new();
			};
			let Some(pending) = store.interactions.get_mut(&session) else {
				return Vec::new();
			};
			take_interaction(pending, *card, intent).map_or_else(Vec::new, |(id, response)| {
				vec![HostAction::RespondToInteraction { session, interaction_id: id.0, response }]
			})
		},
		Intent::SetDrawer { open: true } => {
			let running = store
				.domains
				.terminals
				.iter()
				.rev()
				.find(|terminal| terminal.status == TerminalStatus::Running);
			vec![match running {
				Some(terminal) => HostAction::AttachTerminal { terminal_id: terminal.id.clone() },
				None => HostAction::CreateTerminal { cwd: None, shell: None },
			}]
		},
		Intent::RetryConnection => vec![HostAction::RetryConnection],
		Intent::StartProviderAuth(provider) => {
			vec![HostAction::StartProviderAuth { provider: provider.clone() }]
		},
		Intent::SubmitAuthSecret { provider, secret } => {
			vec![HostAction::SubmitAuthSecret { provider: provider.clone(), secret: secret.clone() }]
		},
		Intent::OpenAuthUrl(url) => vec![HostAction::OpenAuthUrl { url: url.clone() }],
		Intent::CancelAuthFlow => {
			let provider = store
				.domains
				.auth_flow
				.as_ref()
				.map_or_else(String::new, |f| f.provider.clone());
			vec![HostAction::CancelAuthFlow { provider }]
		},
		Intent::RetryAuthFlow => {
			let provider = store
				.domains
				.auth_flow
				.as_ref()
				.map_or_else(String::new, |f| f.provider.clone());
			vec![HostAction::RetryAuthFlow { provider }]
		},
		Intent::RetryControl(id) => store
			.retries
			.take(id)
			.map_or_else(|| retry_control_actions(id, active), |refused| vec![refused]),
		Intent::Navigate(crate_route) => navigate_actions(*crate_route, active),
		Intent::OpenOverlay(_) | Intent::CloseOverlay | Intent::PaletteMove(_) => Vec::new(),
		// Ranking rows the window already holds asks the host for nothing; the
		// modes whose rows come from the host report their own intent.
		Intent::PaletteQuery(_) => Vec::new(),
		// An empty query opens the mode on the workspace tree, which is where
		// its rows come from until something is typed.
		Intent::FindFile(query) if query.is_empty() => {
			vec![HostAction::LoadFileTree { root: None }]
		},
		Intent::FindFile(query) => vec![HostAction::SearchFiles { query: query.clone() }],
		// Nothing is searched for until something is typed: there is no
		// listing of every line of the workspace to open the mode on.
		Intent::FindText(query) if query.is_empty() => Vec::new(),
		Intent::FindText(query) => vec![HostAction::SearchContent { query: query.clone() }],
		Intent::PaletteRun => Vec::new(),
		// The listing the operator asked for, which is what makes a descent
		// visible: the rows of Browse mode are the host's children of `path`.
		Intent::BrowseTo { path } => vec![HostAction::LoadFileTree { root: path.clone() }],
		Intent::SettingChanged { key, value } => {
			vec![HostAction::SetSetting { key: key.clone(), value: value.clone() }]
		},
		Intent::ResetSetting(key) => {
			vec![HostAction::ResetSetting { key: key.clone() }]
		},
		Intent::KeybindingChanged { action, keys } => {
			vec![HostAction::SetKeybinding { action: action.clone(), keys: keys.clone() }]
		},
		Intent::SpawnTask(task) => vec![HostAction::SpawnTask { task: task.clone() }],
		Intent::SelectTheme(theme) => vec![
			HostAction::SetSetting {
				key:   "theme".to_string(),
				value: serde_json::Value::String(theme.clone()),
			},
			HostAction::LoadThemes,
		],
		Intent::ReloadSettings => {
			vec![HostAction::LoadSettings, HostAction::LoadThemes, HostAction::LoadKeybindings]
		},
		Intent::SetMcpEnabled { server, enabled } => {
			vec![HostAction::SetMcpEnabled { server: server.clone(), enabled: *enabled }]
		},
		Intent::RefreshDiagnostics => vec![HostAction::RefreshDiagnostics],
		Intent::RetryDiagnosticSource(source) => {
			vec![HostAction::RetryDiagnosticSource { source: source.clone() }]
		},
		Intent::RefreshUsage | Intent::OpenUsage => {
			let mut actions = vec![HostAction::GetUsage { session: active.clone() }];
			if let Some(session) = active {
				actions.push(HostAction::GetContextBreakdown { session });
			}
			actions
		},
		Intent::TerminalInput(data) => active_terminal(store).map_or_else(Vec::new, |term| {
			vec![HostAction::WriteTerminal { terminal_id: term.id.clone(), data: data.clone() }]
		}),
		Intent::ResizeTerminal { cols, rows } => {
			active_terminal(store).map_or_else(Vec::new, |term| {
				vec![HostAction::ResizeTerminal {
					terminal_id: term.id.clone(),
					cols:        *cols,
					rows:        *rows,
				}]
			})
		},
		Intent::ClearTerminal => active_terminal(store).map_or_else(Vec::new, |term| {
			vec![HostAction::ClearTerminal { terminal_id: term.id.clone() }]
		}),
		Intent::RestartTerminal => active_terminal(store).map_or_else(Vec::new, |term| {
			vec![HostAction::RestartTerminal { terminal_id: term.id.clone() }]
		}),
		Intent::CloseTerminal => active_terminal(store).map_or_else(Vec::new, |term| {
			vec![HostAction::CloseTerminal { terminal_id: term.id.clone() }]
		}),
		Intent::ClearOutput => {
			active.map_or_else(Vec::new, |session| vec![HostAction::ClearOutput { session }])
		},
		Intent::CancelTool { call_id } => active.map_or_else(Vec::new, |session| {
			vec![HostAction::CancelTool { session, tool_call_id: call_id.clone() }]
		}),
		Intent::ProcessStart { command, args } => {
			vec![HostAction::ProcessStart { command: command.clone(), args: args.clone() }]
		},
		Intent::ProcessSend { process, data } => {
			vec![HostAction::ProcessSend { process_id: process.clone(), data: data.clone() }]
		},
		Intent::SelectDrawerTab(_) => Vec::new(),
		// Opening a process's output subscribes to it: `follow` keeps the
		// chunks arriving while the tab is the one on screen, which is the
		// only place they are drawn.
		Intent::OpenProcessLogs(name) => {
			vec![HostAction::ProcessLogs { process_id: name.clone(), follow: true }]
		},
		Intent::ProcessStop(name) => vec![HostAction::ProcessStop { process_id: name.clone() }],
		Intent::ProcessRestart(name) => vec![HostAction::ProcessRestart { process_id: name.clone() }],
		Intent::ProcessSignal(name) => vec![HostAction::ProcessSignal {
			process_id: name.clone(),
			signal:     "SIGTERM".to_string(),
		}],
		Intent::NewSession => vec![HostAction::CreateSession { workspace: None, title: None }],
		Intent::CloseTabOrPark => {
			active.map_or_else(Vec::new, |session| vec![HostAction::DeleteSession { session }])
		},
		Intent::PinSession(_)
		| Intent::UnpinSession(_)
		| Intent::DeferSession(_)
		| Intent::ParkSession(_)
		| Intent::UnparkSession(_)
		| Intent::RecallSession(_) => {
			mutate_partition(intent, index, store);
			Vec::new()
		},
		Intent::DeleteSession(row) => index.session_of(*row).map_or_else(Vec::new, |session| {
			vec![HostAction::DeleteSession { session: session.clone() }]
		}),
		Intent::BranchSession(row) => index.session_of(*row).map_or_else(Vec::new, |session| {
			vec![HostAction::BranchSession { session: session.clone(), entry: None }]
		}),
		Intent::RenameSession { session, title } => {
			index.session_of(*session).map_or_else(Vec::new, |s| {
				vec![HostAction::RenameSession { session: s.clone(), title: title.clone() }]
			})
		},
		Intent::ExportSession(row) => row
			.and_then(|r| index.session_of(r))
			.cloned()
			.or_else(|| active.clone())
			.map_or_else(Vec::new, |s| {
				vec![HostAction::ExportSession { session: s, format: "html".to_string() }]
			}),
		Intent::CompactSession(row) => row
			.and_then(|r| index.session_of(r))
			.cloned()
			.or_else(|| active.clone())
			.map_or_else(Vec::new, |s| vec![HostAction::CompactSession { session: s }]),
		Intent::HandoffSession(row) => row
			.and_then(|r| index.session_of(r))
			.cloned()
			.or_else(|| active.clone())
			.map_or_else(Vec::new, |s| {
				vec![HostAction::HandoffSession { session: s, target: String::new() }]
			}),
		Intent::LoadTranscript(row) => row
			.and_then(|r| index.session_of(r))
			.cloned()
			.or(active)
			.map_or_else(Vec::new, |s| vec![HostAction::LoadTranscript { session: s, before: None }]),
		Intent::OpenFile(path) => vec![HostAction::ReadFile { path: path.clone() }],
		Intent::SelectChangeScope(scope) => {
			vec![HostAction::SelectChangeScope { scope: *scope }, HostAction::RefreshChanges]
		},
		// The tab the operator moved to draws a domain the host answers only
		// when it is asked, and opening the panel is the same ask for the tab
		// it opens on.
		Intent::SelectTab(tab) => tab_actions(*tab, store, active),
		Intent::SetPanel { open: true } => open_actions(store),
		Intent::SetPanel { open: false }
		| Intent::SetDiffMode(_)
		| Intent::ToggleTreeNode(_)
		| Intent::ExpandContext { .. } => Vec::new(),
		_ => Vec::new(),
	}
}

/// What a control sends when its retry has no refused request to send again:
/// a control the operator reaches before anything failed on it, and one whose
/// error came from the transport rather than from a request the window sent.
/// A refused request is always preferred, because it carries the prompt, the
/// session and the attachments that no surface id states.
fn retry_control_actions(
	id: &veyyon_desktop_model::SurfaceId,
	active: Option<veyyon_desktop_model::SessionId>,
) -> Vec<HostAction> {
	use veyyon_desktop_model::SurfaceId;
	match id {
		SurfaceId::ConnectionRetryButton | SurfaceId::ConnectionAttachButton => {
			vec![HostAction::RetryConnection]
		},
		SurfaceId::ProviderAuthRetryButton(p) => {
			vec![HostAction::RetryAuthFlow { provider: p.clone() }]
		},
		SurfaceId::ProviderAuthStartButton(p) => {
			vec![HostAction::StartProviderAuth { provider: p.clone() }]
		},
		SurfaceId::ProviderAuthCancelButton(p) => {
			vec![HostAction::CancelAuthFlow { provider: p.clone() }]
		},
		SurfaceId::DiagnosticRefreshButton => vec![HostAction::RefreshDiagnostics],
		SurfaceId::UsageRefreshButton => vec![HostAction::GetUsage { session: active }],
		SurfaceId::ContextBreakdownRefreshButton => {
			active.map_or_else(Vec::new, |session| vec![HostAction::GetContextBreakdown { session }])
		},
		SurfaceId::DiagnosticRetrySourceButton(s) => {
			vec![HostAction::RetryDiagnosticSource { source: s.clone() }]
		},
		SurfaceId::AgentReviveButton(a) => vec![HostAction::ReviveAgent { agent_id: a.clone() }],
		SurfaceId::TaskCancelButton(t) => vec![HostAction::CancelTask { task_id: t.clone() }],
		_ => Vec::new(),
	}
}

fn navigate_actions(
	route: veyyon_desktop_surface::navigation::SurfaceRoute,
	active: Option<veyyon_desktop_model::SessionId>,
) -> Vec<HostAction> {
	use veyyon_desktop_surface::{SettingsPage, navigation::SurfaceRoute};
	match route {
		SurfaceRoute::Page(SettingsPage::General) => vec![HostAction::LoadSettings],
		SurfaceRoute::Page(SettingsPage::Themes) => vec![HostAction::LoadThemes],
		SurfaceRoute::Page(SettingsPage::Keybindings) => vec![HostAction::LoadKeybindings],
		SurfaceRoute::Page(SettingsPage::Providers) => vec![HostAction::RefreshProviders],
		SurfaceRoute::Page(SettingsPage::Mcp) => vec![HostAction::RefreshMcp],
		SurfaceRoute::Page(SettingsPage::Diagnostics) => vec![HostAction::RefreshDiagnostics],
		SurfaceRoute::Page(SettingsPage::Usage) => vec![HostAction::GetUsage { session: active }],
		SurfaceRoute::Page(SettingsPage::ContextBreakdown) => {
			active.map_or_else(Vec::new, |session| vec![HostAction::GetContextBreakdown { session }])
		},
		SurfaceRoute::Page(SettingsPage::Extensions | SettingsPage::Authentication)
		| SurfaceRoute::Commands
		| SurfaceRoute::Account
		| SurfaceRoute::Settings => Vec::new(),
	}
}

fn mutate_partition(intent: &Intent, index: &SessionIndex, store: &mut Store) {
	let now = crate::current_timestamp_ms();
	let (session, op) = match intent {
		Intent::PinSession(r) => (index.session_of(*r), 0),
		Intent::UnpinSession(r) => (index.session_of(*r), 1),
		Intent::DeferSession(r) => (index.session_of(*r), 2),
		Intent::ParkSession(r) => (index.session_of(*r), 3),
		Intent::UnparkSession(r) => (index.session_of(*r), 4),
		Intent::RecallSession(r) => (index.session_of(*r), 5),
		_ => return,
	};
	if let Some(s) = session {
		match op {
			0 => store.sessions.pin(s, None),
			1 => store.sessions.unpin(s, now),
			2 => store.sessions.defer(s, None),
			3 => store.sessions.park(s, now),
			4 => store.sessions.unpark(s, now),
			_ => store.sessions.recall(s, now),
		}
	}
}

fn active_terminal(store: &Store) -> Option<&veyyon_desktop_model::TerminalView> {
	store
		.domains
		.terminals
		.iter()
		.rev()
		.find(|t| t.status == TerminalStatus::Running)
		.or_else(|| store.domains.terminals.last())
}
