//! Draft editing, attachment staging, and prompt submission.

use super::toggle_set;
use crate::{
	command::UiCommand,
	host::HostAction,
	model::*,
	navigation::*,
	store::{CommandTarget, Completion, Effects, ShellEffect, Store},
};

impl Store {
	pub(super) fn dispatch_composer(&mut self, command: UiCommand, effects: &mut Effects) -> bool {
		match command {
			UiCommand::EditDraft { session, text } => {
				self.frontend.drafts.entry(session).or_default().text = text
			},
			UiCommand::SetDraftCaret { session, byte } => {
				self.frontend.drafts.entry(session).or_default().caret = byte
			},
			UiCommand::SetDraftSelection { session, anchor, head } => {
				self.frontend.drafts.entry(session).or_default().selection = Some((anchor, head))
			},
			UiCommand::AddAttachment { session, kind } => match self.next_attachment_id() {
				Ok(id) => self
					.frontend
					.drafts
					.entry(session)
					.or_default()
					.attachments
					.push(LocalAttachment { id, kind, state: AttachmentState::Selected }),
				Err(error) => effects
					.shell
					.push(ShellEffect::Notify { message: error.to_string() }),
			},
			UiCommand::RemoveAttachment { session, attachment } => {
				if let Some(draft) = self.frontend.drafts.get_mut(&session) {
					draft.attachments.retain(|item| item.id != attachment);
				}
			},
			UiCommand::RetryAttachment { session, attachment } => {
				if let Some(item) = self.frontend.drafts.get_mut(&session).and_then(|draft| {
					draft
						.attachments
						.iter_mut()
						.find(|item| item.id == attachment)
				}) {
					item.state = AttachmentState::Selected;
				}
			},
			UiCommand::ChooseFiles { session } => effects.shell.push(ShellEffect::ChooseAttachments {
				session,
				images_only: false,
				replace: None,
			}),
			UiCommand::ChooseImages { session } => effects
				.shell
				.push(ShellEffect::ChooseAttachments { session, images_only: true, replace: None }),
			UiCommand::ReattachAttachment { session, attachment } => {
				effects.shell.push(ShellEffect::ChooseAttachments {
					session,
					images_only: false,
					replace: Some(attachment),
				})
			},
			UiCommand::EditAgentChatDraft { agent, text } => {
				self.frontend.agent_chat_drafts.insert(agent, text);
			},
			UiCommand::SelectInteractionOption { interaction, index } => {
				self
					.frontend
					.interaction_drafts
					.entry(interaction)
					.or_default()
					.selected = Some(index)
			},
			UiCommand::ToggleInteractionOption { interaction, index } => toggle_set(
				&mut self
					.frontend
					.interaction_drafts
					.entry(interaction)
					.or_default()
					.checked,
				index,
			),
			UiCommand::EditInteractionText { interaction, text } => {
				self
					.frontend
					.interaction_drafts
					.entry(interaction)
					.or_default()
					.text = text
			},
			UiCommand::EditInteractionNote { interaction, note } => {
				self
					.frontend
					.interaction_drafts
					.entry(interaction)
					.or_default()
					.note = note
			},
			UiCommand::AddTerminalSelection { session, terminal, text } => {
				match self.next_attachment_id() {
					Ok(id) => self
						.frontend
						.drafts
						.entry(session)
						.or_default()
						.attachments
						.push(LocalAttachment {
							id,
							kind: AttachmentKind::TerminalSelection { terminal, text },
							state: AttachmentState::Selected,
						}),
					Err(error) => effects
						.shell
						.push(ShellEffect::Notify { message: error.to_string() }),
				}
			},
			UiCommand::SubmitPrompt { ref session }
			| UiCommand::Steer { ref session }
			| UiCommand::FollowUp { ref session } => {
				let session = session.clone();
				self.dispatch_submission(command, session, effects);
			},
			_ => return false,
		}
		true
	}

	fn dispatch_submission(
		&mut self,
		command: UiCommand,
		session: SessionId,
		effects: &mut Effects,
	) {
		let draft = self
			.frontend
			.drafts
			.get(&session)
			.cloned()
			.unwrap_or_default();
		let attachments = draft.submission_attachments();
		let action = match command {
			UiCommand::SubmitPrompt { .. } => {
				HostAction::SubmitPrompt { session: session.clone(), text: draft.text, attachments }
			},
			UiCommand::Steer { .. } => {
				HostAction::Steer { session: session.clone(), text: draft.text }
			},
			UiCommand::FollowUp { .. } => {
				HostAction::FollowUp { session: session.clone(), text: draft.text }
			},
			_ => return,
		};
		let target = CommandTarget::Draft(session.clone());
		self.emit_checked(
			action,
			target.clone(),
			Completion::ClearDraft(session.clone()),
			Some(Capability::TurnControl),
			effects,
		);
		let submission = self.command_state(&target);
		// The text leaves the draft when the request is on its way and not
		// before: a submission the boundary refused emitted nothing, so the
		// field keeps what was typed rather than swallowing it. The acknowledged
		// path clears the same draft again through `Completion::ClearDraft`,
		// which is why this only has to be right about the refusal.
		let sent = matches!(submission, CommandState::Pending { .. });
		if let Some(draft) = self.frontend.drafts.get_mut(&session) {
			draft.submission = submission;
			if sent {
				draft.text.clear();
				draft.caret = 0;
				draft.selection = None;
				draft.attachments.clear();
			}
		}
	}
}
