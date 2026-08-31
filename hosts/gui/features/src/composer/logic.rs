//! Composer decisions that do not need a window.

use veyyon_gui_core::{
	Store, UiCommand,
	model::{CommandState, SessionId, SessionRuntimeView, SubmissionMode, TurnState},
	navigation::{AttachmentState, Draft},
};

/// Set once when the long-lived editor is built.
pub const PLACEHOLDER: &str = "Write a message";

#[derive(Debug, Clone, Copy)]
pub struct GateContext<'a> {
	pub connected:         bool,
	pub provider_error:    Option<&'a str>,
	pub invalid_reason:    Option<&'a str>,
	pub max_characters:    Option<usize>,
	pub max_attachments:   Option<usize>,
	pub required_decision: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Blocked<'a> {
	NoSession,
	Disconnected,
	RequiredDecision(&'a str),
	Provider(&'a str),
	Uploading,
	UploadFailed(&'a str),
	NeedsReattach(&'a str),
	AttachmentRefused(String),
	Invalid(&'a str),
	Oversize { characters: usize, maximum: usize },
	TooManyAttachments { attachments: usize, maximum: usize },
	Empty,
}

impl Blocked<'_> {
	pub fn message(&self) -> String {
		match self {
			Self::NoSession => "Select or create a conversation before sending".to_owned(),
			Self::Disconnected => "Reconnect before sending; the draft is retained".to_owned(),
			Self::RequiredDecision(reason)
			| Self::Provider(reason)
			| Self::UploadFailed(reason)
			| Self::NeedsReattach(reason)
			| Self::Invalid(reason) => (*reason).to_owned(),
			Self::AttachmentRefused(reason) => reason.clone(),
			Self::Uploading => "Wait for every attachment upload to finish".to_owned(),
			Self::Oversize { characters, maximum } => {
				format!("Draft has {characters} characters; the active provider allows {maximum}")
			},
			Self::TooManyAttachments { attachments, maximum } => {
				format!("Draft has {attachments} attachments; the active provider allows {maximum}")
			},
			Self::Empty => "Write a message or attach context before sending".to_owned(),
		}
	}
}

pub fn selected_draft(store: &Store) -> Option<(&SessionId, &Draft)> {
	let session = store.frontend.selected_session.as_ref()?;
	Some((session, store.frontend.drafts.get(session)?))
}

pub fn active_runtime(store: &Store) -> Option<&SessionRuntimeView> {
	let selected = store.frontend.selected_session.as_ref()?;
	let runtime = &store.replica.runtime.readable()?.value;
	(&runtime.session == selected).then_some(runtime)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrimaryAction {
	Send,
	Steer,
	FollowUp,
	Abort,
}

impl PrimaryAction {
	pub fn label(self) -> &'static str {
		match self {
			Self::Send => "Send",
			Self::Steer => "Steer",
			Self::FollowUp => "Follow up",
			Self::Abort => "Abort",
		}
	}

	pub fn command(self, session: &SessionId) -> UiCommand {
		match self {
			Self::Send => UiCommand::SubmitPrompt { session: session.clone() },
			Self::Steer => UiCommand::Steer { session: session.clone() },
			Self::FollowUp => UiCommand::FollowUp { session: session.clone() },
			Self::Abort => UiCommand::AbortTurn { session: session.clone() },
		}
	}
}

/// The primary control is a projection of confirmed runtime state. Draft text,
/// focus, hover, and optimistic queue counts cannot change its meaning.
pub fn primary_action(runtime: Option<&SessionRuntimeView>) -> PrimaryAction {
	let Some(runtime) = runtime else {
		return PrimaryAction::Send;
	};
	match &runtime.turn {
		TurnState::Idle => PrimaryAction::Send,
		TurnState::Aborting | TurnState::Retrying { .. } | TurnState::Compacting { .. } => {
			PrimaryAction::Abort
		},
		TurnState::Running { .. } => match runtime.queue.active_submission {
			SubmissionMode::Prompt => PrimaryAction::Abort,
			SubmissionMode::Steer => PrimaryAction::Steer,
			SubmissionMode::FollowUp => PrimaryAction::FollowUp,
		},
	}
}

pub fn submission_pending(draft: Option<&Draft>) -> bool {
	draft.is_some_and(|draft| matches!(&draft.submission, CommandState::Pending { .. }))
}

/// Return the first exact reason the primary action cannot run. Draft content
/// is never mutated by this decision, including invalid or oversized content.
pub fn blocked<'a>(draft: Option<&'a Draft>, context: GateContext<'a>) -> Option<Blocked<'a>> {
	let draft = match draft {
		Some(draft) => draft,
		None => return Some(Blocked::NoSession),
	};
	if let Some(reason) = context.required_decision {
		return Some(Blocked::RequiredDecision(reason));
	}
	if !context.connected {
		return Some(Blocked::Disconnected);
	}
	if let Some(reason) = context.provider_error {
		return Some(Blocked::Provider(reason));
	}
	for attachment in &draft.attachments {
		match &attachment.state {
			AttachmentState::Uploading { .. } => return Some(Blocked::Uploading),
			AttachmentState::Failed { message, .. } => {
				return Some(Blocked::UploadFailed(message));
			},
			AttachmentState::NeedsReattach { reason } => {
				return Some(Blocked::NeedsReattach(reason));
			},
			AttachmentState::Refused { reason } => {
				return Some(Blocked::AttachmentRefused(reason.reason_text()));
			},
			AttachmentState::Selected | AttachmentState::Ready => {},
		}
	}
	if let Some(maximum) = context.max_attachments
		&& draft.attachments.len() > maximum
	{
		return Some(Blocked::TooManyAttachments { attachments: draft.attachments.len(), maximum });
	}
	if let Some(reason) = context.invalid_reason {
		return Some(Blocked::Invalid(reason));
	}
	let characters = draft.text.chars().count();
	if let Some(maximum) = context.max_characters
		&& characters > maximum
	{
		return Some(Blocked::Oversize { characters, maximum });
	}
	if draft.text.trim().is_empty() && draft.attachments.is_empty() {
		return Some(Blocked::Empty);
	}
	None
}

pub fn context_fraction(runtime: Option<&SessionRuntimeView>) -> Option<(f32, String)> {
	let usage = runtime?.context.as_ref()?;
	let window = usage.context_window?;
	if window == 0 {
		return None;
	}
	let filled = (usage.tokens as f32 / window as f32).clamp(0.0, 1.0);
	Some((filled, format!("{} / {} tokens", usage.tokens, window)))
}
