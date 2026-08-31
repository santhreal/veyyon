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
				self.frontend.drafts.entry(session).or_default().selection = Some((anchor, head));
			},
			UiCommand::AddAttachment { session, kind } => match self.next_attachment_id() {
				Ok(id) => {
					let mut item = LocalAttachment::new(id, kind);
					if let Some(reason) = self.evaluate_attachment_refusal(&session, &item) {
						item.state = AttachmentState::Refused { reason };
					}
					self
						.frontend
						.drafts
						.entry(session)
						.or_default()
						.attachments
						.push(item);
				},
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
				let item_clone = self
					.frontend
					.drafts
					.get(&session)
					.and_then(|draft| draft.attachments.iter().find(|item| item.id == attachment))
					.cloned();
				if let Some(item_clone) = item_clone {
					let refusal = self.evaluate_attachment_refusal(&session, &item_clone);
					if let Some(item) = self.frontend.drafts.get_mut(&session).and_then(|draft| {
						draft
							.attachments
							.iter_mut()
							.find(|item| item.id == attachment)
					}) {
						if let Some(reason) = refusal {
							item.state = AttachmentState::Refused { reason };
						} else {
							item.state = AttachmentState::Selected;
						}
					}
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
					Ok(id) => {
						let mut item =
							LocalAttachment::new(id, AttachmentKind::TerminalSelection { terminal, text });
						if let Some(reason) = self.evaluate_attachment_refusal(&session, &item) {
							item.state = AttachmentState::Refused { reason };
						}
						self
							.frontend
							.drafts
							.entry(session)
							.or_default()
							.attachments
							.push(item);
					},
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

impl Store {
	pub fn evaluate_attachment_refusal(
		&self,
		session: &SessionId,
		attachment: &LocalAttachment,
	) -> Option<AttachmentRefusalReason> {
		let runtime = self.session_runtime(session)?;
		let constraints = &runtime.prompt_constraints;

		if let Some(max) = constraints.max_attachments
			&& let Some(draft) = self.frontend.drafts.get(session)
		{
			let current_count = draft
				.attachments
				.iter()
				.filter(|item| item.id != attachment.id)
				.count();
			if current_count >= max {
				return Some(AttachmentRefusalReason::TooManyAttachments {
					count: current_count + 1,
					max,
				});
			}
		}

		let active_model = runtime.model.as_ref().and_then(|mid| {
			self.replica.models.readable().and_then(|catalog| {
				catalog
					.value
					.models
					.readable()
					.and_then(|models| models.iter().find(|m| &m.id == mid))
			})
		});

		if let Some(model) = active_model {
			if let Availability::Unavailable { reason } = &model.availability {
				return Some(AttachmentRefusalReason::ModelUnavailable { reason: reason.clone() });
			}

			if attachment.is_image()
				&& !model.input_modalities.is_empty()
				&& !model.input_modalities.iter().any(|m| m == "image")
			{
				return Some(AttachmentRefusalReason::UnsupportedModality {
					modality: "image".to_owned(),
				});
			}

			if let Some(max_bytes) = model.max_attachment_bytes {
				let size = attachment.size();
				if size > max_bytes {
					return Some(AttachmentRefusalReason::SizeExceeded { size_bytes: size, max_bytes });
				}
			}
		}

		if let Some(max_bytes) = constraints.max_attachment_bytes {
			let size = attachment.size();
			if size > max_bytes {
				return Some(AttachmentRefusalReason::SizeExceeded { size_bytes: size, max_bytes });
			}
		}

		if !constraints.allowed_modalities.is_empty()
			&& attachment.is_image()
			&& !constraints.allowed_modalities.iter().any(|m| m == "image")
		{
			return Some(AttachmentRefusalReason::UnsupportedModality {
				modality: "image".to_owned(),
			});
		}
		None
	}

	pub fn session_runtime(&self, session: &SessionId) -> Option<&SessionRuntimeView> {
		let runtime = &self.replica.runtime.readable()?.value;
		if &runtime.session == session {
			Some(runtime)
		} else {
			None
		}
	}
}
