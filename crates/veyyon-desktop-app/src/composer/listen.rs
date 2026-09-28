//! The composer's actions: the table every binding, palette row and control
//! reaches, and the requests the ones that go to the host send.
//!
//! Each action is registered twice from one table: on the composer's own
//! element, so a key pressed in the editor handles it at once, and on the
//! App through [`route`](super::route), so the palette or a key pressed in
//! another region reaches the composer of the active window.

use gpui::{
	App, ClipboardEntry, Context, Div, ExternalPaths, PathPromptOptions, Stateful, prelude::*,
};
use veyyon_desktop_model::{
	HostAction, HostActionKind, QueueMode, SessionId, SettableMode, SurfaceId,
};
use veyyon_desktop_ui::editor::actions as keys;

use super::{
	Composer, attach,
	route::{self, OnElement, Registry},
};
use crate::actions::composer as act;

/// Every composer action and what it does.
fn table<R: Registry<Composer>>(registry: R) -> R {
	registry
		.add::<act::Submit>(|this, _, _, cx| this.submit(cx))
		.add::<act::Stop>(|this, _, _, cx| this.stop(cx))
		.add::<act::BackgroundCommand>(|this, _, _, cx| this.background_command(cx))
		.add::<act::ToggleQueueMode>(|this, _, _, cx| this.toggle_queue_mode(cx))
		.add::<act::TakeBackQueued>(|this, _, _, cx| this.take_back_queued(cx))
		.add::<act::OpenModelPicker>(|this, _, window, cx| this.open_models(window, cx))
		.add::<act::OpenThinkingPicker>(|this, _, window, cx| this.open_thinking(window, cx))
		.add::<act::CycleThinkingLevel>(|this, _, _, cx| this.cycle_thinking(cx))
		.add::<act::SetModePlan>(|this, _, _, cx| this.set_mode(SettableMode::Plan, cx))
		.add::<act::SetModeVibe>(|this, _, _, cx| this.set_mode(SettableMode::Vibe, cx))
		.add::<act::SetModeLoop>(|this, _, _, cx| this.set_mode(SettableMode::Loop, cx))
		.add::<act::ClearMode>(|this, _, _, cx| this.set_mode(SettableMode::None, cx))
		.add::<act::SetGoalFromDraft>(|this, _, _, cx| this.set_goal_from_draft(cx))
		.add::<act::ReviewPlan>(|this, _, _, cx| this.review_plan(cx))
		.add::<act::ToggleDictation>(|this, _, _, cx| this.toggle_dictation(cx))
		.add::<act::CancelDictation>(|this, _, _, cx| this.cancel_dictation(cx))
		.add::<act::AttachFiles>(|_, _, _, cx| Composer::attach_files(cx))
		.add::<act::ToggleFast>(|this, _, _, cx| this.toggle_fast(cx))
		.add::<act::AcceptCompletion>(|this, _, _, cx| {
			if !this.accept_completion(None, cx) {
				cx.propagate();
			}
		})
		.add::<act::SearchHistory>(|this, _, window, cx| this.search_history(window, cx))
		.add::<act::InsertText>(|this, action, window, cx| this.insert_text(&action.text, window, cx))
}

/// Routes every composer action dispatched outside a composer to the
/// composer of the active window. Registers once per App.
pub fn init(cx: &mut App) {
	if let Some(registry) = route::installer::<Composer>(cx) {
		table(registry);
	}
}

impl Composer {
	/// The composer's element with every action and the keys the completion
	/// list takes before the editor sees them.
	pub(super) fn listen(element: Stateful<Div>, cx: &mut Context<Self>) -> Stateful<Div> {
		let element = element
			.capture_action(cx.listener(|this, _: &keys::MoveUp, _, cx| {
				if this.move_highlight(false, cx) {
					cx.stop_propagation();
				}
			}))
			.capture_action(cx.listener(|this, _: &keys::MoveDown, _, cx| {
				if this.move_highlight(true, cx) {
					cx.stop_propagation();
				}
			}))
			.capture_action(cx.listener(|this, _: &keys::Enter, _, cx| {
				if this.accept_completion(None, cx) {
					cx.stop_propagation();
				}
			}))
			.capture_action(cx.listener(|this, _: &keys::Escape, _, cx| {
				if this.close_completion(cx) {
					cx.stop_propagation();
				}
			}))
			.capture_action(cx.listener(|this, _: &keys::Paste, _, cx| {
				if this.paste_image(cx) {
					cx.stop_propagation();
				}
			}))
			.on_drop(cx.listener(|this, paths: &ExternalPaths, _, cx| {
				this.attach_paths(paths.paths().to_vec(), false, cx);
			}));
		table(OnElement { element, cx }).element
	}

	/// Sends the action `make` builds for the shown session.
	pub(super) fn send_for_session(
		&self,
		make: impl FnOnce(SessionId) -> (HostAction, SurfaceId),
		cx: &mut Context<Self>,
	) {
		let Some(session) = self.session.clone() else {
			return;
		};
		let (action, surface) = make(session);
		self.app.update(cx, |app, cx| {
			app.dispatch(action, surface, cx);
		});
	}

	/// Puts the session in `mode`, or out of its mode for `None`, while the
	/// host takes a mode.
	pub(super) fn set_mode(&self, mode: SettableMode, cx: &mut Context<Self>) {
		if self.refusal(HostActionKind::SetSessionMode, cx).is_some() {
			return;
		}
		self.send_for_session(
			|session| {
				(
					HostAction::SetSessionMode { session: session.clone(), mode },
					SurfaceId::ComposerPlanChip(session),
				)
			},
			cx,
		);
	}

	/// Raises the plan the agent last wrote for review.
	pub(super) fn review_plan(&self, cx: &mut Context<Self>) {
		self.send_for_session(
			|session| {
				(
					HostAction::ReviewPlan { session: session.clone() },
					SurfaceId::SessionPlanReviewButton(session),
				)
			},
			cx,
		);
	}

	/// Moves the command the turn waits on to a background job.
	pub(super) fn background_command(&self, cx: &mut Context<Self>) {
		self.send_for_session(
			|session| {
				(
					HostAction::BackgroundCommand { session: session.clone() },
					SurfaceId::ComposerBackgroundButton(session),
				)
			},
			cx,
		);
	}

	/// Takes the newest queued prompt back into the draft.
	pub(super) fn take_back_queued(&self, cx: &mut Context<Self>) {
		self.send_for_session(
			|session| {
				(
					HostAction::DequeueQueuedPrompt { session: session.clone() },
					SurfaceId::ComposerQueuedTakeBack(session),
				)
			},
			cx,
		);
	}

	/// Switches a prompt sent during a turn between steering and queueing.
	pub(super) fn toggle_queue_mode(&mut self, cx: &mut Context<Self>) {
		let mode = match self.queue_mode {
			QueueMode::Steer => QueueMode::Queue,
			QueueMode::Queue => QueueMode::Steer,
		};
		let mode = self.app.read(cx).effective_queue_mode(mode);
		if mode == self.queue_mode {
			return;
		}
		self.queue_mode = mode;
		self.save_draft(cx);
		self.send_for_session(
			|session| {
				(
					HostAction::SetQueueMode { session: session.clone(), mode },
					SurfaceId::ComposerQueueModeToggle(session),
				)
			},
			cx,
		);
		self.reshape(cx);
		cx.notify();
	}

	/// Starts a goal whose objective is the draft, and clears the draft; a
	/// draft the host takes no goal from is kept.
	pub(super) fn set_goal_from_draft(&mut self, cx: &mut Context<Self>) {
		let objective = self.text(cx).trim().to_owned();
		if objective.is_empty()
			|| self.session.is_none()
			|| self.refusal(HostActionKind::SetGoal, cx).is_some()
		{
			return;
		}
		self.send_for_session(
			|session| {
				let action =
					HostAction::SetGoal { session: session.clone(), objective, token_budget: None };
				(action, SurfaceId::ComposerGoalChip(session))
			},
			cx,
		);
		self.set_text("", cx);
	}

	/// Asks for files to attach and attaches the ones picked.
	pub(super) fn attach_files(cx: &Context<Self>) {
		let picked = cx.prompt_for_paths(PathPromptOptions {
			files:       true,
			directories: false,
			multiple:    true,
			prompt:      None,
		});
		cx.spawn(async move |this, cx| {
			let Ok(Ok(Some(paths))) = picked.await else {
				return;
			};
			let _ = this.update(cx, |this, cx| this.attach_paths(paths, false, cx));
		})
		.detach();
	}

	/// Attaches the image the clipboard holds; `false` when it holds none,
	/// which leaves the paste to the editor.
	fn paste_image(&mut self, cx: &mut Context<Self>) -> bool {
		let Some(item) = cx.read_from_clipboard() else {
			return false;
		};
		let Some(image) = item.entries().iter().find_map(|entry| match entry {
			ClipboardEntry::Image(image) => Some(image.clone()),
			_ => None,
		}) else {
			return false;
		};
		self.pasted += 1;
		let made = attach::from_clipboard(&image, self.pasted);
		self.admit_one(made, cx);
		true
	}
}
