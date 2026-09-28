//! The dock's actions and what they send: 1–9 pick, Enter confirms the
//! choice the keyboard is on, Esc folds the card, the arrows move between
//! choices and a dialog's questions.
//!
//! Each action is registered twice from one table, as the composer's are: on
//! the dock's element and on the App through
//! [`route`](crate::composer::route), so the palette reaches the dock of the
//! active window wherever focus is.

use gpui::{App, Context, Div, KeyDownEvent, Stateful, Window, prelude::*};
use veyyon_desktop_model::{GoalControl, HostAction, HostActionKind, SurfaceId};
use veyyon_desktop_ui::editor;

use super::{
	InteractionDock,
	card::{Act, Control, Owned},
};
use crate::{
	actions::{composer, dock as act},
	composer::route::{self, OnElement, Registry},
	state::Answer,
	workspace::{FocusSlot, focus_slot},
};

/// Every dock action and what it does.
fn table<R: Registry<InteractionDock>>(registry: R) -> R {
	registry
		.add::<act::Confirm>(|this, _, window, cx| this.confirm(window, cx))
		.add::<act::Dismiss>(|this, _, window, cx| this.dismiss(window, cx))
		.add::<act::ApproveForSession>(|this, _, _, cx| this.answer_approval(true, true, cx))
		.add::<act::Deny>(|this, _, _, cx| this.answer_approval(false, false, cx))
		.add::<act::Pick1>(|this, _, window, cx| this.pick(0, window, cx))
		.add::<act::Pick2>(|this, _, window, cx| this.pick(1, window, cx))
		.add::<act::Pick3>(|this, _, window, cx| this.pick(2, window, cx))
		.add::<act::Pick4>(|this, _, window, cx| this.pick(3, window, cx))
		.add::<act::Pick5>(|this, _, window, cx| this.pick(4, window, cx))
		.add::<act::Pick6>(|this, _, window, cx| this.pick(5, window, cx))
		.add::<act::Pick7>(|this, _, window, cx| this.pick(6, window, cx))
		.add::<act::Pick8>(|this, _, window, cx| this.pick(7, window, cx))
		.add::<act::Pick9>(|this, _, window, cx| this.pick(8, window, cx))
		.add::<act::ChatInstead>(|this, _, window, cx| this.chat_instead(window, cx))
		.add::<act::PauseGoal>(|this, _, _, cx| this.control_goal(GoalControl::Pause, cx))
		.add::<act::ResumeGoal>(|this, _, _, cx| this.control_goal(GoalControl::Resume, cx))
		.add::<act::DropGoal>(|this, _, _, cx| this.control_goal(GoalControl::Drop, cx))
}

/// Routes every dock action dispatched outside a dock to the dock of the
/// active window. Registers once per App.
pub fn init(cx: &mut App) {
	if let Some(registry) = route::installer::<InteractionDock>(cx) {
		table(registry);
	}
}

impl InteractionDock {
	/// The dock's element with every action and the arrow keys.
	pub(super) fn listen(element: Stateful<Div>, cx: &mut Context<Self>) -> Stateful<Div> {
		let element = element.on_key_down(cx.listener(Self::on_key_down));
		table(OnElement { element, cx }).element
	}

	/// The arrows move the keyboard between choices, and Left and Right
	/// between a dialog's questions, while no field of the dock is written in.
	fn on_key_down(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
		let keystroke = &event.keystroke;
		if keystroke.modifiers.modified() || in_editor(window) {
			return;
		}
		let key = keystroke.key.as_str();
		if let ("left" | "right", Some((asked, state))) = (key, self.shown_dialog()) {
			let count = asked.questions.len();
			let tab = state.tab(cx);
			let next = if key == "right" {
				(tab + 1) % count
			} else {
				(tab + count - 1) % count
			};
			state.select(next, cx);
			cx.stop_propagation();
			return;
		}
		let forward = match key {
			"down" | "right" => true,
			"up" | "left" => false,
			_ => return,
		};
		self.move_cursor(forward, cx);
		cx.stop_propagation();
	}

	/// Moves the keyboard to the next or the previous choice, wrapping, or
	/// onto the first or the last from none.
	fn move_cursor(&mut self, forward: bool, cx: &mut Context<Self>) {
		let count = self.choice_count(cx);
		let Some(shown) = self.shown.as_mut().filter(|_| count > 0) else {
			return;
		};
		let next = match (shown.cursor, forward) {
			(None, true) => 0,
			(None, false) => count - 1,
			(Some(at), true) => (at + 1) % count,
			(Some(at), false) => (at + count - 1) % count,
		};
		shown.cursor = Some(next);
		cx.notify();
	}

	/// How many choices the arrows move between on the shown card.
	fn choice_count(&self, cx: &App) -> usize {
		if let Some((dialog, state)) = self.shown_dialog() {
			return dialog
				.questions
				.get(state.tab(cx))
				.map_or(0, |question| question.options.len());
		}
		self
			.shown
			.as_ref()
			.map_or(0, |shown| shown.decision.choices().len())
	}

	/// Picks choice `index` of the shown card: sends it, or on a dialog picks
	/// the option of the question shown.
	pub(super) fn pick(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
		if self.shown_dialog().is_some() {
			self.pick_dialog_option(index, cx);
			return;
		}
		let Some(choice) = self
			.shown
			.as_ref()
			.and_then(|shown| shown.decision.choices().into_iter().nth(index))
		else {
			return;
		};
		if let Some(shown) = self.shown.as_mut() {
			shown.cursor = Some(index);
		}
		self.run(choice.act, window, cx);
	}

	/// Sends the choice the keyboard is on; a dialog answers its question or
	/// submits.
	pub(super) fn confirm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		if self.shown_dialog().is_some() {
			self.confirm_dialog(window, cx);
			return;
		}
		let Some(index) = self.shown.as_ref().and_then(|shown| shown.cursor) else {
			return;
		};
		self.pick(index, window, cx);
	}

	/// Folds the card to its one line and hands the keyboard to the composer.
	/// The decision stays waiting; a click on the line opens it again.
	pub(super) fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		let Some(shown) = self.shown.as_mut().filter(|shown| !shown.folded) else {
			return;
		};
		shown.folded = true;
		focus_slot(FocusSlot::Composer, window, cx);
		cx.notify();
	}

	/// Opens the folded card and takes the keyboard for it.
	pub(super) fn unfold(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		if let Some(shown) = self.shown.as_mut() {
			shown.folded = false;
			if shown.decision.takes_keys() {
				window.focus(&self.focus, cx);
			}
			cx.notify();
		}
	}

	/// Answers the shown approval.
	fn answer_approval(&mut self, approved: bool, for_session: bool, cx: &mut Context<Self>) {
		if !matches!(self.shown.as_ref().map(|shown| &shown.decision), Some(Owned::Approval(_))) {
			return;
		}
		let control = match (approved, for_session) {
			(true, false) => Control::Approve,
			(true, true) => Control::AlwaysAllow,
			(false, _) => Control::Decline,
		};
		self.send(Answer::Approval { approved, for_session }, control, cx);
	}

	/// Does what a choice does.
	pub(super) fn run(&mut self, act: Act, window: &mut Window, cx: &mut Context<Self>) {
		match act {
			Act::Send(answer, control) => self.send(answer, control, cx),
			Act::Composer => {
				focus_slot(FocusSlot::Composer, window, cx);
				window.dispatch_action(Box::new(composer::Submit), cx);
			},
		}
	}

	/// Sends `answer` to the shown decision from `control`, unless the host
	/// takes no answer now.
	pub(super) fn send(&mut self, answer: Answer, control: Control, cx: &mut Context<Self>) {
		let (Some(session), Some(id)) = (self.session.clone(), self.shown().cloned()) else {
			return;
		};
		if self
			.app
			.read(cx)
			.refusal(HostActionKind::RespondToInteraction)
			.is_some()
		{
			return;
		}
		let surface = control.surface(session.clone(), id.clone());
		let request = self
			.app
			.update(cx, |app, cx| app.respond_to_interaction(session, &id, &answer, surface, cx));
		self.answering = Some((request, id));
	}

	/// Discusses the shown dialog's questions in the conversation instead of
	/// answering them here.
	pub(super) fn chat_instead(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		if self.shown_dialog().is_some() {
			self.send(Answer::Chat, Control::Submit, cx);
			focus_slot(FocusSlot::Composer, window, cx);
		}
	}

	/// Pauses, resumes or drops the goal of the shown session, where its
	/// status allows `op`.
	pub(super) fn control_goal(&self, op: GoalControl, cx: &mut Context<Self>) {
		let Some(session) = self.session.clone() else {
			return;
		};
		let app = self.app.read(cx);
		let allowed = app
			.goal(&session)
			.is_some_and(|goal| goal.status.allowed_controls().contains(&op));
		if !allowed || app.refusal(HostActionKind::ControlGoal).is_some() {
			return;
		}
		let surface = SurfaceId::ComposerGoalChip(session.clone());
		self.app.update(cx, |app, cx| {
			app.dispatch(HostAction::ControlGoal { session, op }, surface, cx);
		});
	}
}

/// Whether the keyboard is in a text field.
fn in_editor(window: &Window) -> bool {
	window
		.context_stack()
		.iter()
		.any(|context| context.contains(editor::KEY_CONTEXT))
}
