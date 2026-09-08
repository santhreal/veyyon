//! From what the operator asked to what the host is sent.

use veyyon_desktop_model::{AttachmentSubmission, HostAction, Store, TerminalStatus};
use veyyon_desktop_surface::{Attachment, AttachmentSource, Intent};

use super::{SessionIndex, cards::take_interaction};

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
		// The host accepts the two modes by their capitalised names and rejects
		// any other spelling with INVALID_ARGUMENTS.
		Intent::SetQueueMode(mode) => active.map_or_else(Vec::new, |session| {
			let mode_str = match mode {
				veyyon_desktop_surface::QueueMode::Steer => "Steer",
				veyyon_desktop_surface::QueueMode::Queue => "Queue",
			};
			vec![HostAction::SetQueueMode { session, mode: mode_str.to_string() }]
		}),
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
		Intent::RetryControl(id) => match id {
			veyyon_desktop_model::SurfaceId::ConnectionRetryButton
			| veyyon_desktop_model::SurfaceId::ConnectionAttachButton => {
				vec![HostAction::RetryConnection]
			},
			veyyon_desktop_model::SurfaceId::ProviderAuthRetryButton(provider) => {
				vec![HostAction::RetryAuthFlow { provider: provider.clone() }]
			},
			veyyon_desktop_model::SurfaceId::ProviderAuthStartButton(provider) => {
				vec![HostAction::StartProviderAuth { provider: provider.clone() }]
			},
			veyyon_desktop_model::SurfaceId::ProviderAuthCancelButton(provider) => {
				vec![HostAction::CancelAuthFlow { provider: provider.clone() }]
			},
			veyyon_desktop_model::SurfaceId::DiagnosticRefreshButton => {
				vec![HostAction::RefreshDiagnostics]
			},
			veyyon_desktop_model::SurfaceId::UsageRefreshButton => {
				vec![HostAction::GetUsage { session: active }]
			},
			veyyon_desktop_model::SurfaceId::ContextBreakdownRefreshButton => active
				.map_or_else(Vec::new, |session| vec![HostAction::GetContextBreakdown { session }]),
			veyyon_desktop_model::SurfaceId::DiagnosticRetrySourceButton(source) => {
				vec![HostAction::RetryDiagnosticSource { source: source.clone() }]
			},
			veyyon_desktop_model::SurfaceId::AgentReviveButton(agent) => {
				vec![HostAction::ReviveAgent { agent_id: agent.clone() }]
			},
			veyyon_desktop_model::SurfaceId::TaskCancelButton(task_id) => {
				vec![HostAction::CancelTask { task_id: task_id.clone() }]
			},
			_ => Vec::new(),
		},
		Intent::Navigate(crate_route) => {
			use veyyon_desktop_surface::{SettingsPage, navigation::SurfaceRoute};
			match crate_route {
				SurfaceRoute::Page(SettingsPage::General) => vec![HostAction::LoadSettings],
				SurfaceRoute::Page(SettingsPage::Themes) => vec![HostAction::LoadThemes],
				SurfaceRoute::Page(SettingsPage::Keybindings) => vec![HostAction::LoadKeybindings],
				SurfaceRoute::Page(SettingsPage::Providers) => vec![HostAction::RefreshProviders],
				SurfaceRoute::Page(SettingsPage::Mcp) => vec![HostAction::RefreshMcp],
				SurfaceRoute::Page(SettingsPage::Diagnostics) => vec![HostAction::RefreshDiagnostics],
				SurfaceRoute::Page(SettingsPage::Usage) => {
					vec![HostAction::GetUsage { session: active }]
				},
				SurfaceRoute::Page(SettingsPage::ContextBreakdown) => active
					.map_or_else(Vec::new, |session| vec![HostAction::GetContextBreakdown { session }]),
				SurfaceRoute::Page(SettingsPage::Extensions | SettingsPage::Authentication)
				| SurfaceRoute::Commands
				| SurfaceRoute::Account
				| SurfaceRoute::Settings => Vec::new(),
			}
		},
		Intent::OpenOverlay(_) | Intent::CloseOverlay | Intent::PaletteMove(_) => Vec::new(),
		Intent::PaletteQuery(query) => vec![HostAction::SearchFiles { query: query.clone() }],
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
		Intent::TerminalInput(data) => {
			let active_term = store
				.domains
				.terminals
				.iter()
				.rev()
				.find(|t| t.status == TerminalStatus::Running)
				.or_else(|| store.domains.terminals.last());
			active_term.map_or_else(Vec::new, |term| {
				vec![HostAction::WriteTerminal {
					terminal_id: term.id.clone(),
					data:        data.clone(),
				}]
			})
		},
		Intent::ResizeTerminal { cols, rows } => {
			let active_term = store
				.domains
				.terminals
				.iter()
				.rev()
				.find(|t| t.status == TerminalStatus::Running)
				.or_else(|| store.domains.terminals.last());
			active_term.map_or_else(Vec::new, |term| {
				vec![HostAction::ResizeTerminal {
					terminal_id: term.id.clone(),
					cols:        *cols,
					rows:        *rows,
				}]
			})
		},
		Intent::ClearTerminal => {
			let active_term = store
				.domains
				.terminals
				.iter()
				.rev()
				.find(|t| t.status == TerminalStatus::Running)
				.or_else(|| store.domains.terminals.last());
			active_term.map_or_else(Vec::new, |term| {
				vec![HostAction::ClearTerminal { terminal_id: term.id.clone() }]
			})
		},
		Intent::RestartTerminal => {
			let active_term = store
				.domains
				.terminals
				.iter()
				.rev()
				.find(|t| t.status == TerminalStatus::Running)
				.or_else(|| store.domains.terminals.last());
			active_term.map_or_else(Vec::new, |term| {
				vec![HostAction::RestartTerminal { terminal_id: term.id.clone() }]
			})
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
		Intent::PinSession(row) => {
			if let Some(session) = index.session_of(*row) {
				store.sessions.pin(session, None);
			}
			Vec::new()
		},
		Intent::UnpinSession(row) => {
			if let Some(session) = index.session_of(*row) {
				store.sessions.unpin(session, crate::current_timestamp_ms());
			}
			Vec::new()
		},
		// `Parked` orders by when a session was put away, so an epoch timestamp
		// collapses that ordering onto the id. The rail's defer names no return
		// time, and records none rather than inventing one.
		Intent::DeferSession(row) => {
			if let Some(session) = index.session_of(*row) {
				store.sessions.defer(session, None);
			}
			Vec::new()
		},
		Intent::ParkSession(row) => {
			if let Some(session) = index.session_of(*row) {
				store.sessions.park(session, crate::current_timestamp_ms());
			}
			Vec::new()
		},
		Intent::UnparkSession(row) => {
			if let Some(session) = index.session_of(*row) {
				store
					.sessions
					.unpark(session, crate::current_timestamp_ms());
			}
			Vec::new()
		},
		Intent::RecallSession(row) => {
			if let Some(session) = index.session_of(*row) {
				store
					.sessions
					.recall(session, crate::current_timestamp_ms());
			}
			Vec::new()
		},
		Intent::DeleteSession(row) => index.session_of(*row).map_or_else(Vec::new, |session| {
			vec![HostAction::DeleteSession { session: session.clone() }]
		}),
		Intent::BranchSession(row) => index.session_of(*row).map_or_else(Vec::new, |session| {
			vec![HostAction::BranchSession { session: session.clone(), entry: None }]
		}),
		Intent::OpenFile(path) => vec![HostAction::ReadFile { path: path.clone() }],
		Intent::SelectChangeScope(scope) => vec![
			HostAction::SelectChangeScope {
				scope: match scope {
					veyyon_desktop_model::ChangeScope::WorkingTree => "working_tree".to_string(),
					veyyon_desktop_model::ChangeScope::Staged => "staged".to_string(),
				},
			},
			HostAction::RefreshChanges,
		],
		Intent::SetPanel { open: true } => {
			let mut actions = Vec::new();
			if matches!(
				store
					.capabilities
					.get(veyyon_desktop_model::Capability::Changes),
				veyyon_desktop_model::CapabilityStatus::Available
			) {
				actions.push(HostAction::RefreshChanges);
			}
			if store.domains.file_tree.is_none()
				&& matches!(
					store
						.capabilities
						.get(veyyon_desktop_model::Capability::Files),
					veyyon_desktop_model::CapabilityStatus::Available
				) {
				actions.push(HostAction::LoadFileTree { root: None });
			}
			actions
		},
		Intent::SetPanel { open: false }
		| Intent::SetDiffMode(_)
		| Intent::ToggleTreeNode(_)
		| Intent::ExpandContext { .. } => Vec::new(),
		_ => Vec::new(),
	}
}

/// The wire form of one attachment. The id is the attachment's place in the
/// prompt and where it came from, so two chips that carry the same bytes are
/// still two attachments and a duplicate id never reaches the host.
fn submission_of((position, attachment): (usize, &Attachment)) -> AttachmentSubmission {
	let origin = match &attachment.source {
		AttachmentSource::Path(path) => path.display().to_string(),
		AttachmentSource::Clipboard(ordinal) => format!("clipboard:{ordinal}"),
	};
	AttachmentSubmission {
		id:         format!("{position}:{origin}"),
		name:       attachment.name.clone(),
		media_type: attachment.media.as_str().to_owned(),
		data:       attachment.payload.bytes().to_vec(),
	}
}
