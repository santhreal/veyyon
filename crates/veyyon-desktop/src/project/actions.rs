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
			_ => Vec::new(),
		},
		Intent::OpenOverlay(_) | Intent::CloseOverlay | Intent::PaletteMove(_) => Vec::new(),
		Intent::PaletteQuery(query) => vec![HostAction::SearchFiles { query: query.clone() }],
		Intent::PaletteRun => Vec::new(),
		Intent::PaletteAscend => vec![HostAction::LoadFileTree { root: None }],
		Intent::SettingChanged { key, value } => {
			vec![HostAction::SetSetting { key: key.clone(), value: value.clone() }]
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
		Intent::DeferSession(row) => {
			if let Some(session) = index.session_of(*row) {
				store.sessions.defer(session, 0);
			}
			Vec::new()
		},
		Intent::ParkSession(row) => {
			if let Some(session) = index.session_of(*row) {
				store.sessions.park(session, 0);
			}
			Vec::new()
		},
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
		Intent::SetDiffMode(_) | Intent::ToggleTreeNode(_) | Intent::ExpandContext { .. } => {
			Vec::new()
		},
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
