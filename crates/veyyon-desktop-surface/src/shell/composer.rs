//! Turn submission through the same control availability as pointer activation.

use veyyon_desktop_model::{QueueMode, RequestId, SessionId};
use veyyon_gpui::Context;

use crate::{
	Intent, ShellView,
	composer::{PrimaryAction, primary_action},
	controls::availability_style,
};

pub(super) struct SubmittedDraft {
	request:     RequestId,
	session:     u64,
	text:        String,
	attachments: Vec<crate::composer::Attachment>,
}

impl ShellView {
	/// Uses the same request availability for keyboard, menu, and pointer
	/// actions.
	pub(super) fn composer_action_allowed(&self, intent: &Intent) -> bool {
		let session = SessionId::from(self.state.current_id.to_string());
		crate::composer::actions::request_surface(intent, &session).is_none_or(|id| {
			availability_style(&self.state.controls.availability(&id), &self.installed.set).2
		})
	}

	/// Submits the current draft, or runs the selected slash command when its
	/// menu is open.
	pub fn submit_primary_turn_action(&mut self, cx: &mut Context<Self>) {
		if self.palette_input.slash && self.state.overlay.is_some() {
			self.run_palette(cx);
			return;
		}
		let text = self.composer_cache.clone();
		let has_text = !text.trim().is_empty();
		let id = self
			.state
			.turn
			.primary_surface(has_text, &SessionId::from(self.state.current_id.to_string()));
		if !availability_style(&self.state.controls.availability(&id), &self.installed.set).2 {
			return;
		}
		let (primary, _) = primary_action(&self.state.turn, has_text);
		let intent = match primary {
			PrimaryAction::Send if has_text => {
				Intent::Send { text, attachments: self.state.composer.attachments.clone() }
			},
			PrimaryAction::Steer if has_text => Intent::Steer(text),
			PrimaryAction::Queue if has_text => Intent::Queue(text),
			PrimaryAction::Answer if !self.state.cards.is_empty() => {
				if has_text {
					Intent::Reply { card: 0, text }
				} else {
					Intent::Answer { card: 0, option: 0 }
				}
			},
			PrimaryAction::Approve if !self.state.cards.is_empty() => {
				Intent::Approval { card: 0, approved: true, standing: false }
			},
			PrimaryAction::Accept if !self.state.cards.is_empty() => {
				Intent::Plan { card: 0, accepted: true }
			},
			PrimaryAction::Refine if has_text && !self.state.cards.is_empty() => {
				Intent::Plan { card: 0, accepted: false }
			},
			_ => return,
		};
		self.clear_composer_notice();
		self.dispatch(intent, cx);
	}

	/// Sends the draft in the other running-turn mode without changing the
	/// persisted mode.
	pub fn submit_alternate_turn_action(&mut self, cx: &mut Context<Self>) {
		if !self.state.turn.is_running() || !self.has_composer_text() {
			return;
		}
		let session = SessionId::from(self.state.current_id.to_string());
		let (id, intent) = match self.state.composer.queue_mode {
			QueueMode::Steer => (
				veyyon_desktop_model::SurfaceId::ComposerQueueButton(session),
				Intent::Queue(self.composer_cache.clone()),
			),
			QueueMode::Queue => (
				veyyon_desktop_model::SurfaceId::ComposerSteerButton(session),
				Intent::Steer(self.composer_cache.clone()),
			),
		};
		if availability_style(&self.state.controls.availability(&id), &self.installed.set).2 {
			self.dispatch(intent, cx);
		}
	}

	/// Records the accepted transport request without consuming editable draft
	/// content.
	pub fn track_submission(&mut self, request: RequestId, intent: &Intent) {
		let (text, attachments) = match intent {
			Intent::Send { text, attachments } => (text.clone(), attachments.clone()),
			Intent::Steer(text) | Intent::Queue(text) => (text.clone(), Vec::new()),
			_ => return,
		};
		self.submitted =
			Some(SubmittedDraft { request, session: self.state.current_id, text, attachments });
	}

	/// Acknowledgement clears only the submitted draft, never subsequent edits
	/// or a different session.
	pub fn finish_submission(
		&mut self,
		request: RequestId,
		succeeded: bool,
		cx: &mut Context<Self>,
	) {
		if self
			.submitted
			.as_ref()
			.is_none_or(|draft| draft.request != request)
		{
			return;
		}
		let Some(draft) = self.submitted.take() else {
			return;
		};
		if !succeeded || draft.session != self.state.current_id {
			return;
		}
		if self.composer_cache == draft.text {
			self.set_composed(String::new(), cx);
		}
		self
			.state
			.composer
			.attachments
			.retain(|attachment| !draft.attachments.contains(attachment));
		cx.notify();
	}
}
