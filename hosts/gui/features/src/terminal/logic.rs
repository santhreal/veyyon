//! Presentation decisions derived from terminal and connection replicas.

use veyyon_gui_core::model::{ConnectionState, TerminalPhase, TerminalRunView};
use veyyon_gui_kit::ui::Tone;

/// Connection treatment shared by every terminal lifecycle state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionPresentation<'a> {
	pub stale:         bool,
	pub accepts_input: bool,
	pub detail:        Option<&'a str>,
}

impl<'a> ConnectionPresentation<'a> {
	pub fn from_connection(connection: &'a ConnectionState) -> Self {
		match connection {
			ConnectionState::Connected { .. } => {
				Self { stale: false, accepts_input: true, detail: None }
			},
			ConnectionState::Reconnecting { message, .. } => Self {
				stale:         true,
				accepts_input: false,
				detail:        Some(message.as_str()),
			},
			ConnectionState::Fatal { message } => Self {
				stale:         true,
				accepts_input: false,
				detail:        Some(message.as_str()),
			},
			ConnectionState::Detached => Self {
				stale:         false,
				accepts_input: false,
				detail:        Some("Attach a host to use terminals"),
			},
			ConnectionState::Connecting { .. } | ConnectionState::Syncing { .. } => Self {
				stale:         false,
				accepts_input: false,
				detail:        Some("Terminal state is synchronizing"),
			},
		}
	}
}

/// Words, semantics, and available recovery for one terminal tab.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecyclePresentation<'a> {
	pub label:         &'static str,
	pub detail:        Option<&'a str>,
	pub tone:          Tone,
	pub accepts_input: bool,
	pub can_restart:   bool,
}

/// Derive terminal chrome without mutating the producer-owned replica.
pub fn lifecycle<'a>(
	terminal: &'a TerminalRunView,
	connection: &'a ConnectionState,
	command_error: Option<&'a str>,
) -> LifecyclePresentation<'a> {
	let transport = ConnectionPresentation::from_connection(connection);
	let (label, tone, phase_accepts_input, can_restart, phase_detail) = match &terminal.phase {
		TerminalPhase::Starting => ("Starting", Tone::Warn, false, false, None),
		TerminalPhase::Running => ("Running", Tone::Ok, true, false, None),
		TerminalPhase::Reconnecting { message, .. } => {
			("Reconnecting", Tone::Warn, false, true, Some(message.as_str()))
		},
		TerminalPhase::Exited => ("Exited", Tone::Muted, false, true, None),
		TerminalPhase::Error { message } => {
			("Error", Tone::Danger, false, true, Some(message.as_str()))
		},
	};
	let detail = command_error
		.or(terminal.error.as_deref())
		.or(phase_detail)
		.or(transport.detail);
	LifecyclePresentation {
		label,
		detail,
		tone,
		accepts_input: phase_accepts_input && transport.accepts_input,
		can_restart: can_restart && transport.accepts_input,
	}
}
