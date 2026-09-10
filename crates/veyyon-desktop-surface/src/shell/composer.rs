//! Turn submission through the same control availability as pointer activation.

use veyyon_desktop_kit::input::{Editor, EditorEvent, EditorMode};
use veyyon_desktop_model::{QueueMode, RequestId, SessionId};
use veyyon_gpui::{AppContext, Context, Entity};

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

	/// Returns the current composer text content.
	#[must_use]
	pub fn composer_text(&self) -> &str {
		&self.composer_cache
	}

	/// Returns true if the composer contains non-whitespace text characters.
	#[must_use]
	pub fn has_composer_text(&self) -> bool {
		!self.composer_cache.trim().is_empty()
	}

	/// Lazily creates and returns the composer editor entity.
	pub fn ensure_composer(&mut self, cx: &mut Context<Self>) -> Entity<Editor> {
		if let Some(ed) = &self.composer {
			return ed.clone();
		}

		let editor = cx.new(|cx| {
			Editor::new(EditorMode::Multiline { newline_on_enter: false }, cx)
				.placeholder("Ask, or describe a change")
				.max_visible_lines(8)
		});

		let sub = cx.subscribe(&editor, |this, ed, event: &EditorEvent, cx| match event {
			EditorEvent::Submit => this.submit_primary_turn_action(cx),
			EditorEvent::Escape => {
				if this
					.state
					.overlay
					.as_ref()
					.and_then(crate::Overlay::route)
					.is_some()
				{
					this.back_surface(cx);
					return;
				}
				if this.state.overlay.is_some() {
					this.close_palette(cx);
					return;
				}
				if !this.state.cards.is_empty() {
					this.state.cards.remove(0);
					cx.notify();
				}
			},
			EditorEvent::Changed => {
				this.composer_cache = ed.read(cx).text().to_string();
				this.update_slash_palette(cx);
				cx.notify();
			},
			EditorEvent::PasteMedia(item) => this.attach_clipboard(item, cx),
		});

		self.subscriptions.push(sub);
		self.composer.insert(editor).clone()
	}

	/// Sets the composer text content.
	pub fn set_composed(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
		let text = text.into();
		self.composer_cache.clone_from(&text);
		self
			.ensure_composer(cx)
			.update(cx, |editor, cx| editor.set_text(text, cx));
	}

	/// Submits the current draft, or runs the selected slash command when its
	/// menu is open.
	pub fn submit_primary_turn_action(&mut self, cx: &mut Context<Self>) {
		if self.state.overlay.is_some() {
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
			// A question that offers options is answered by one of them, from
			// the card's own rows or their digit keys, and the composer's
			// answer is unavailable for it. What reaches here is a free-text
			// question, whose answer is the draft.
			PrimaryAction::Answer if has_text && !self.state.cards.is_empty() => {
				Intent::Reply { card: 0, text }
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

	/// Selects the other running-turn mode, through the same availability the
	/// footer's own control reads: a host that accepts no background
	/// submission holds the toggle back rather than answering the chord with
	/// an action it refuses (§4.3, §5.13).
	pub fn toggle_queue_mode(&mut self, cx: &mut Context<Self>) {
		let other = match self.state.composer.queue_mode {
			QueueMode::Steer => QueueMode::Queue,
			QueueMode::Queue => QueueMode::Steer,
		};
		let intent = Intent::SetQueueMode(other);
		if self.composer_action_allowed(&intent) {
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

	/// Records the host's answer to a submitted draft, and answers the session
	/// whose draft the host took.
	///
	/// A prompt the host accepted is no longer unsent, so the caller clears the
	/// draft the window remembers for that session (§8.10). That session is the
	/// one the draft was submitted from, which is not always the one on screen:
	/// the operator moves on while the request is in flight, and a draft left
	/// behind under a session that has already sent it stands in the rail's
	/// `Unsent` section stating text nobody can retract.
	///
	/// The composer in front of the operator is cleared only while it is still
	/// the one that submitted and still holds the text that went. A refusal
	/// clears nothing: §5.4 retains the draft the host would not take.
	pub fn finish_submission(
		&mut self,
		request: RequestId,
		succeeded: bool,
		cx: &mut Context<Self>,
	) -> Option<u64> {
		if self
			.submitted
			.as_ref()
			.is_none_or(|draft| draft.request != request)
		{
			return None;
		}
		let draft = self.submitted.take()?;
		if !succeeded {
			return None;
		}
		if draft.session == self.state.current_id {
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
		Some(draft.session)
	}
}
