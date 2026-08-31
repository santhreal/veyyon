//! Host session lifecycle, turn control, tool cancellation, and interactive
//! query mapping.

use crate::{
	command::UiCommand,
	host::HostAction,
	model::*,
	store::{CommandTarget, Completion, Store},
};

impl Store {
	pub(super) fn map_session_action(
		&mut self,
		command: &UiCommand,
	) -> Option<(HostAction, CommandTarget, Completion, Option<Capability>)> {
		match command {
			UiCommand::Attach { endpoint } => Some((
				HostAction::Attach { endpoint: endpoint.clone() },
				CommandTarget::Connection,
				Completion::None,
				None,
			)),
			UiCommand::Detach => {
				Some((HostAction::Detach, CommandTarget::Connection, Completion::None, None))
			},
			UiCommand::RetryConnection => {
				Some((HostAction::RetryConnection, CommandTarget::Connection, Completion::None, None))
			},
			UiCommand::RequestShutdown => Some((
				HostAction::Shutdown,
				CommandTarget::Lifecycle,
				Completion::None,
				Some(Capability::Lifecycle),
			)),
			UiCommand::LoadSessions => Some((
				HostAction::ListSessions,
				CommandTarget::Sessions,
				Completion::None,
				Some(Capability::Sessions),
			)),
			UiCommand::LoadTranscript { session, before } => Some((
				HostAction::LoadTranscript { session: session.clone(), before: before.clone() },
				CommandTarget::Transcript(session.clone()),
				Completion::None,
				Some(Capability::Transcript),
			)),
			UiCommand::RetryTranscript { session } => Some((
				HostAction::LoadTranscript { session: session.clone(), before: None },
				CommandTarget::Transcript(session.clone()),
				Completion::None,
				Some(Capability::Transcript),
			)),
			UiCommand::CreateSession { workspace, parent } => Some((
				HostAction::CreateSession { workspace: workspace.clone(), parent: parent.clone() },
				CommandTarget::Sessions,
				Completion::None,
				Some(Capability::Sessions),
			)),
			UiCommand::OpenSession(session) => {
				self.frontend.selected_session = Some(session.clone());
				Some((
					HostAction::OpenSession { session: session.clone() },
					CommandTarget::Session(session.clone()),
					Completion::None,
					Some(Capability::Sessions),
				))
			},
			UiCommand::RenameSession { session, name } => Some((
				HostAction::RenameSession { session: session.clone(), name: name.clone() },
				CommandTarget::Session(session.clone()),
				Completion::None,
				Some(Capability::Sessions),
			)),
			UiCommand::DeleteSession(session) => Some((
				HostAction::DeleteSession { session: session.clone() },
				CommandTarget::Session(session.clone()),
				Completion::None,
				Some(Capability::SessionDeletion),
			)),
			UiCommand::BranchSession { session, entry } => Some((
				HostAction::BranchSession { session: session.clone(), entry: entry.clone() },
				CommandTarget::Session(session.clone()),
				Completion::None,
				Some(Capability::Sessions),
			)),
			UiCommand::ExportSession { session, output_path } => Some((
				HostAction::ExportSession {
					session:     session.clone(),
					output_path: output_path.clone(),
				},
				CommandTarget::Session(session.clone()),
				Completion::None,
				Some(Capability::Sessions),
			)),
			UiCommand::CompactSession { session, instructions } => Some((
				HostAction::CompactSession {
					session:      session.clone(),
					instructions: instructions.clone(),
				},
				CommandTarget::Session(session.clone()),
				Completion::None,
				Some(Capability::Sessions),
			)),
			UiCommand::HandoffSession { session, instructions } => Some((
				HostAction::HandoffSession {
					session:      session.clone(),
					instructions: instructions.clone(),
				},
				CommandTarget::Session(session.clone()),
				Completion::None,
				Some(Capability::Sessions),
			)),
			UiCommand::AbortTurn { session } => Some((
				HostAction::AbortTurn { session: session.clone() },
				CommandTarget::Session(session.clone()),
				Completion::None,
				Some(Capability::TurnControl),
			)),
			UiCommand::SetQueueMode { session, steering, follow_up, interrupt } => Some((
				HostAction::SetQueueMode {
					session:   session.clone(),
					steering:  steering.clone(),
					follow_up: follow_up.clone(),
					interrupt: interrupt.clone(),
				},
				CommandTarget::Session(session.clone()),
				Completion::None,
				Some(Capability::TurnControl),
			)),
			UiCommand::CancelTool(tool) => Some((
				HostAction::CancelTool { tool: tool.clone() },
				CommandTarget::Tool(tool.clone()),
				Completion::None,
				Some(Capability::Tools),
			)),
			UiCommand::SubmitInteraction { interaction, response } => Some((
				HostAction::RespondToInteraction {
					interaction: interaction.clone(),
					response:    response.clone(),
				},
				CommandTarget::Interaction(interaction.clone()),
				Completion::CloseInteraction(interaction.clone()),
				Some(Capability::Questions),
			)),
			UiCommand::CancelInteraction { interaction, timed_out } => Some((
				HostAction::RespondToInteraction {
					interaction: interaction.clone(),
					response:    InteractionResponse::Cancel { timed_out: *timed_out },
				},
				CommandTarget::Interaction(interaction.clone()),
				Completion::CloseInteraction(interaction.clone()),
				Some(Capability::Questions),
			)),
			_ => None,
		}
	}
}
