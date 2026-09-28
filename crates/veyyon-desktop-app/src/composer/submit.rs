//! What send does in each phase of a turn, the prompt in flight and the
//! prompt the host refused.
//!
//! Send starts a turn when the session is idle and steers or queues behind a
//! running one. A decision the session waits on takes the primary control
//! over: a question takes the draft as its answer, a plan takes it as the
//! change to make, an approval and an empty plan answer from the button only,
//! so a stray Enter never approves a call. A draft starting with a command the
//! host lists runs that command; `/steer <text>` and `/queue <text>` steer or
//! queue the text whatever the queue mode.

use gpui::{App, Context};
use veyyon_desktop_model::{HostAction, QueueMode, RequestId, SessionId, SurfaceId};

use super::{
	Composer,
	attach::{self, Attachment},
	primary::{Primary, directed},
};
use crate::state::{Answer, Decision};

/// A prompt the composer sent: the request that carries it, the control
/// that sent it and what the draft held.
pub(super) struct Sent {
	request:     RequestId,
	surface:     SurfaceId,
	text:        String,
	attachments: Vec<Attachment>,
}

/// The prompt in flight and the prompt the host refused.
#[derive(Default)]
pub(super) struct Refused {
	in_flight: Option<Sent>,
	refused:   Option<Sent>,
}

impl Refused {
	/// The text of the prompt the host refused.
	pub(super) fn text(&self) -> Option<&str> {
		self.refused.as_ref().map(|sent| sent.text.as_str())
	}
}

impl Composer {
	/// What the primary control does for the draft and the session's state.
	pub(super) fn primary(&self, cx: &App) -> Primary {
		let Some(session) = &self.session else {
			return Primary::Send;
		};
		let app = self.app.read(cx);
		let has_text = !self.text(cx).trim().is_empty();
		match app.decisions(session).first() {
			Some(Decision::Question(_)) => return Primary::Answer,
			Some(Decision::Approval(_)) => return Primary::Approve,
			Some(Decision::Plan(_)) => {
				return if has_text {
					Primary::Refine
				} else {
					Primary::Accept
				};
			},
			Some(Decision::Dialog(_)) | None => {},
		}
		if !self.running {
			return Primary::Send;
		}
		if !has_text {
			return Primary::Stop;
		}
		match app.effective_queue_mode(self.queue_mode) {
			QueueMode::Steer => Primary::Steer,
			QueueMode::Queue => Primary::Queue,
		}
	}

	/// Enter in the editor, or `composer::Submit`: sends what the draft holds.
	/// An approval or an empty plan answer waits for its button.
	pub(super) fn submit(&mut self, cx: &mut Context<Self>) {
		match self.primary(cx) {
			Primary::Stop | Primary::Approve | Primary::Accept => {},
			primary => self.press(primary, cx),
		}
	}

	/// The primary control was pressed while it did `primary`.
	pub(super) fn press(&mut self, primary: Primary, cx: &mut Context<Self>) {
		let Some(session) = self.session.clone() else {
			return;
		};
		let draft = self.text(cx).trim().to_owned();
		let (primary, text) = match directed(&draft) {
			Some((directed, text))
				if matches!(primary, Primary::Send | Primary::Steer | Primary::Queue) =>
			{
				(directed, text.to_owned())
			},
			_ => (primary, draft.clone()),
		};
		match primary {
			Primary::Stop => self.stop(cx),
			Primary::Send => self.send(session, text, cx),
			Primary::Steer if !text.is_empty() => {
				let surface = SurfaceId::ComposerSteerButton(session.clone());
				self.send_text(HostAction::Steer { session, text }, surface, draft, cx);
			},
			Primary::Queue if !text.is_empty() => {
				let surface = SurfaceId::ComposerQueueButton(session.clone());
				self.send_text(HostAction::FollowUp { session, text }, surface, draft, cx);
			},
			Primary::Answer | Primary::Refine if !text.is_empty() => {
				self.answer_with_draft(session, text, cx);
			},
			Primary::Approve => {
				self.answer_oldest(
					session,
					Answer::Approval { approved: true, for_session: false },
					cx,
				);
			},
			Primary::Accept => self.answer_oldest(
				session,
				Answer::Plan { accepted: true, feedback: String::new() },
				cx,
			),
			Primary::Steer | Primary::Queue | Primary::Answer | Primary::Refine => {},
		}
	}

	/// Starts a turn with the draft and the tray, or runs the command the
	/// draft names.
	fn send(&mut self, session: SessionId, text: String, cx: &mut Context<Self>) {
		if text.is_empty() && self.attachments.is_empty() {
			return;
		}
		if self.attachments.is_empty() && self.names_command(&text, cx) {
			let surface = SurfaceId::ComposerSendButton(session.clone());
			self.send_text(HostAction::RunCommand { session, text: text.clone() }, surface, text, cx);
			return;
		}
		let model = self
			.app
			.read(cx)
			.store()
			.domains
			.models
			.as_ref()
			.and_then(|models| {
				let current = models.current.as_ref()?;
				models
					.models
					.iter()
					.find(|model| model.provider == current.provider && model.id == current.id)
					.cloned()
			});
		if let Some(reason) = attach::submission_rejection(&self.attachments, model.as_ref()) {
			self.notice = Some(reason.into());
			cx.notify();
			return;
		}
		let attachments = std::mem::take(&mut self.attachments);
		let submissions = attachments
			.iter()
			.enumerate()
			.map(|(position, attachment)| attachment.submission(position))
			.collect();
		let request = self
			.app
			.update(cx, |app, cx| app.submit_prompt(session.clone(), text.clone(), submissions, cx));
		let surface = SurfaceId::ComposerSendButton(session);
		self.sent(Sent { request, surface, text, attachments }, cx);
	}

	/// Whether `text` starts with a command the host lists, by name or alias.
	fn names_command(&self, text: &str, cx: &App) -> bool {
		let Some(rest) = text.strip_prefix('/') else {
			return false;
		};
		let word = rest.split_whitespace().next().unwrap_or_default();
		self
			.app
			.read(cx)
			.store()
			.domains
			.commands
			.iter()
			.any(|command| command.name == word || command.aliases.iter().any(|alias| alias == word))
	}

	/// Sends `action`, which carries the draft `text`, on behalf of `surface`.
	fn send_text(
		&mut self,
		action: HostAction,
		surface: SurfaceId,
		text: String,
		cx: &mut Context<Self>,
	) {
		let request = self
			.app
			.update(cx, |app, cx| app.dispatch(action, surface.clone(), cx));
		self.sent(Sent { request, surface, text, attachments: Vec::new() }, cx);
	}

	/// Answers the oldest decision with the draft: a question's free-text
	/// answer or a plan's change.
	fn answer_with_draft(&mut self, session: SessionId, text: String, cx: &mut Context<Self>) {
		let Some((id, surface, answer)) =
			self
				.app
				.read(cx)
				.decisions(&session)
				.first()
				.and_then(|decision| {
					let id = decision.id().clone();
					match decision {
						Decision::Question(_) => Some((
							id.clone(),
							SurfaceId::QuestionSubmitButton(session.clone(), id),
							Answer::Reply { text: text.clone() },
						)),
						Decision::Plan(_) => Some((
							id.clone(),
							SurfaceId::PlanRefineButton(session.clone(), id),
							Answer::Plan { accepted: false, feedback: text.clone() },
						)),
						Decision::Approval(_) | Decision::Dialog(_) => None,
					}
				})
		else {
			return;
		};
		let request = self.app.update(cx, |app, cx| {
			app.respond_to_interaction(session, &id, &answer, surface.clone(), cx)
		});
		self.sent(Sent { request, surface, text, attachments: Vec::new() }, cx);
	}

	/// Answers the oldest decision with `answer`, leaving the draft alone.
	fn answer_oldest(&self, session: SessionId, answer: Answer, cx: &mut Context<Self>) {
		let Some((id, surface)) = self
			.app
			.read(cx)
			.decisions(&session)
			.first()
			.map(|decision| {
				let id = decision.id().clone();
				let surface = match decision {
					Decision::Approval(_) => {
						SurfaceId::ApprovalApproveButton(session.clone(), id.clone())
					},
					Decision::Plan(_) => SurfaceId::PlanAcceptButton(session.clone(), id.clone()),
					Decision::Question(_) | Decision::Dialog(_) => {
						SurfaceId::QuestionSubmitButton(session.clone(), id.clone())
					},
				};
				(id, surface)
			})
		else {
			return;
		};
		self.app.update(cx, |app, cx| {
			app.respond_to_interaction(session, &id, &answer, surface, cx);
		});
	}

	/// Clears the draft after `sent` left, remembering it until the host
	/// answers.
	fn sent(&mut self, sent: Sent, cx: &mut Context<Self>) {
		self.recall.remember(&sent.text);
		self.refused.in_flight = Some(sent);
		self.notice = None;
		self.completion = None;
		self.set_text("", cx);
		cx.notify();
	}

	/// Stops the running turn.
	pub(super) fn stop(&self, cx: &mut Context<Self>) {
		if let Some(session) = self.session.clone() {
			self.app.update(cx, |app, cx| {
				app.abort_turn(session, cx);
			});
		}
	}

	/// The host answered `request`. A refused prompt goes back into an empty
	/// draft and is offered again.
	pub(super) fn request_finished(&mut self, request: RequestId, ok: bool, cx: &mut Context<Self>) {
		let ours = self
			.refused
			.in_flight
			.as_ref()
			.is_some_and(|sent| sent.request == request);
		if !ours {
			return;
		}
		let Some(sent) = self.refused.in_flight.take() else {
			return;
		};
		if ok {
			return;
		}
		if self.text(cx).trim().is_empty() {
			self.set_text(&sent.text, cx);
		}
		if self.attachments.is_empty() {
			self.attachments.clone_from(&sent.attachments);
		}
		self.refused.refused = Some(sent);
		cx.notify();
	}

	/// Sends the refused prompt again, clearing the draft it went back into.
	pub(super) fn retry_refused(&mut self, cx: &mut Context<Self>) {
		let Some(sent) = self.refused.refused.take() else {
			return;
		};
		let request = self
			.app
			.update(cx, |app, cx| app.retry_refused(&sent.surface, cx));
		let Some(request) = request else {
			cx.notify();
			return;
		};
		if self.text(cx).trim() == sent.text {
			self.set_text("", cx);
			self.attachments.clear();
		}
		self.refused.in_flight = Some(Sent { request, ..sent });
		cx.notify();
	}

	/// Forgets the refused prompt; the draft keeps what it went back into.
	pub(super) fn dismiss_refused(&mut self, cx: &mut Context<Self>) {
		if let Some(sent) = self.refused.refused.take() {
			self
				.app
				.update(cx, |app, _| app.forget_refused(&sent.surface));
			cx.notify();
		}
	}

	/// Forgets the prompts of the session the composer leaves.
	pub(super) fn forget_sent(&mut self) {
		self.refused = Refused::default();
	}
}
