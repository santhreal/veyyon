//! A dialog of questions answered together: one tab per question, the
//! options picked on each, a written answer and a note, and the answers the
//! host reads once every question has one.

use gpui::{App, Context, Entity, Subscription, Window, prelude::*};
use veyyon_desktop_model::{DialogInteraction, DialogQuestion};
use veyyon_desktop_ui::{
	editor::{Editor, EditorEvent, EditorMode},
	overlays::{Tab, Tabs, TabsEvent},
};

use super::{
	InteractionDock,
	card::{Control, Owned},
	countdown::Countdown,
};
use crate::state::{Answer, DialogAnswer};

/// What one question of the dialog holds.
pub(super) struct QuestionState {
	/// The indices picked, ascending; at most one unless the question is
	/// `multi`.
	pub(super) selected: Vec<u32>,
	/// The answer written in place of or beside the options.
	pub(super) custom:   Entity<Editor>,
	/// A remark sent with the answer.
	pub(super) note:     Entity<Editor>,
}

/// What a dialog's card holds while it is shown.
pub(super) struct DialogState {
	pub(super) tabs:      Entity<Tabs>,
	pub(super) questions: Vec<QuestionState>,
	pub(super) countdown: Option<Entity<Countdown>>,
	_subscriptions:       Vec<Subscription>,
}

/// The tab a question is listed under: its `header`, or else the question.
pub(super) fn tab_label(question: &DialogQuestion) -> String {
	question
		.header
		.clone()
		.unwrap_or_else(|| question.question.clone())
}

/// The options `question` opens with: its preselected indices that name an
/// option, ascending, at most one unless it is `multi`.
fn opening(question: &DialogQuestion) -> Vec<u32> {
	let count = question.options.len();
	let mut picked: Vec<u32> = question
		.preselected
		.iter()
		.copied()
		.filter(|&index| usize::try_from(index).is_ok_and(|index| index < count))
		.collect();
	picked.sort_unstable();
	picked.dedup();
	if !question.multi {
		picked.truncate(1);
	}
	picked
}

/// The option the cursor opens on for `question`: its first preselected
/// option, else its recommended one, else the first; none on a question
/// without options.
pub(super) fn opening_cursor(question: &DialogQuestion) -> Option<usize> {
	let count = question.options.len();
	let marked = opening(question)
		.first()
		.copied()
		.or(question.recommended)
		.and_then(|index| usize::try_from(index).ok())
		.filter(|&index| index < count);
	marked.or_else(|| (count > 0).then_some(0))
}

/// A one-line field showing `placeholder` while empty.
fn field(placeholder: &'static str, window: &mut Window, cx: &mut App) -> Entity<Editor> {
	cx.new(|cx| {
		let mut editor = Editor::new(EditorMode::SingleLine, window, cx);
		editor.set_placeholder(placeholder, cx);
		editor
	})
}

impl DialogState {
	/// The card state for `dialog`, on its first question.
	pub(super) fn new(
		dialog: &DialogInteraction,
		window: &mut Window,
		cx: &mut Context<InteractionDock>,
	) -> Self {
		let labels = dialog
			.questions
			.iter()
			.map(|question| Tab::new(tab_label(question)))
			.collect();
		let tabs = cx.new(|cx| Tabs::new(labels, 0, cx));
		let mut subscriptions = vec![cx.subscribe(&tabs, |dock, _, event: &TabsEvent, cx| {
			if let TabsEvent::Selected(tab) = *event {
				dock.tab_selected(tab, cx);
			}
		})];
		let mut questions = Vec::with_capacity(dialog.questions.len());
		for question in &dialog.questions {
			let custom = field("Write another answer", window, cx);
			let note = field("Add a note (optional)", window, cx);
			for editor in [&custom, &note] {
				subscriptions.push(cx.subscribe_in(
					editor,
					window,
					|dock, _, event: &EditorEvent, window, cx| {
						Self::on_field_event(dock, *event, window, cx);
					},
				));
			}
			questions.push(QuestionState { selected: opening(question), custom, note });
		}
		let countdown = dialog
			.expires_at_ms
			.map(|at| cx.new(|cx| Countdown::new(at, cx)));
		Self { tabs, questions, countdown, _subscriptions: subscriptions }
	}

	/// A field of the dialog changed or was submitted.
	fn on_field_event(
		dock: &mut InteractionDock,
		event: EditorEvent,
		window: &mut Window,
		cx: &mut Context<InteractionDock>,
	) {
		match event {
			EditorEvent::Changed => cx.notify(),
			EditorEvent::Submit => dock.advance_dialog(window, cx),
			EditorEvent::Escape => dock.dismiss(window, cx),
			EditorEvent::HistoryPrev
			| EditorEvent::HistoryNext
			| EditorEvent::Focused
			| EditorEvent::Blurred => {},
		}
	}

	/// The question on the selected tab.
	pub(super) fn tab(&self, cx: &App) -> usize {
		self.tabs.read(cx).selected()
	}

	/// Shows the question at `index`.
	pub(super) fn select(&self, index: usize, cx: &mut App) {
		self.tabs.update(cx, |tabs, cx| tabs.select(index, cx));
	}

	/// Picks option `index` of question `question`: toggles it on a `multi`
	/// question, replaces the pick otherwise. Returns whether the question is
	/// single-choice and now answered, after which the card moves on.
	pub(super) fn pick(
		&mut self,
		dialog: &DialogInteraction,
		question: usize,
		index: usize,
	) -> bool {
		let (Some(asked), Some(state), Ok(option)) =
			(dialog.questions.get(question), self.questions.get_mut(question), u32::try_from(index))
		else {
			return false;
		};
		if index >= asked.options.len() {
			return false;
		}
		if asked.multi {
			match state.selected.binary_search(&option) {
				Ok(at) => {
					state.selected.remove(at);
				},
				Err(at) => state.selected.insert(at, option),
			}
			false
		} else {
			state.selected = vec![option];
			true
		}
	}

	/// The answers, one per question, or `None` while a question has neither
	/// a pick nor a written answer.
	pub(super) fn answers(&self, dialog: &DialogInteraction, cx: &App) -> Option<Vec<DialogAnswer>> {
		dialog
			.questions
			.iter()
			.zip(&self.questions)
			.map(|(asked, state)| {
				let custom_input = written(&state.custom, cx);
				if state.selected.is_empty() && custom_input.is_none() {
					return None;
				}
				Some(DialogAnswer {
					id: asked.id.clone(),
					selected: state.selected.clone(),
					custom_input,
					note: written(&state.note, cx),
				})
			})
			.collect()
	}

	/// Whether question `question` has a pick or a written answer.
	pub(super) fn is_answered(&self, question: usize, cx: &App) -> bool {
		self
			.questions
			.get(question)
			.is_some_and(|state| !state.selected.is_empty() || written(&state.custom, cx).is_some())
	}

	/// The first question after `from` without an answer, wrapping, or
	/// `None` when every question has one.
	pub(super) fn next_unanswered(&self, from: usize, cx: &App) -> Option<usize> {
		let count = self.questions.len();
		(1..=count)
			.map(|step| (from + step) % count)
			.find(|&at| !self.is_answered(at, cx))
	}
}

/// The trimmed text of `editor`, or `None` while it holds none.
fn written(editor: &Entity<Editor>, cx: &App) -> Option<String> {
	let text = editor.read(cx).text().trim();
	(!text.is_empty()).then(|| text.to_owned())
}

impl InteractionDock {
	/// The dialog shown and its card state.
	pub(super) fn shown_dialog(&self) -> Option<(&DialogInteraction, &DialogState)> {
		let shown = self.shown.as_ref()?;
		match (&shown.decision, &shown.dialog) {
			(Owned::Dialog(dialog), Some(state)) => Some((dialog, state)),
			_ => None,
		}
	}

	/// The dialog moved to the question on `tab`: the cursor opens on that
	/// question's first pick, or where the question opened.
	fn tab_selected(&mut self, tab: usize, cx: &mut Context<Self>) {
		if let Some(shown) = self.shown.as_mut()
			&& let (Owned::Dialog(dialog), Some(state)) = (&shown.decision, &shown.dialog)
		{
			let picked = state
				.questions
				.get(tab)
				.and_then(|question| question.selected.first())
				.and_then(|&index| usize::try_from(index).ok());
			shown.cursor = picked.or_else(|| dialog.questions.get(tab).and_then(opening_cursor));
		}
		cx.notify();
	}

	/// Picks option `index` of the question shown. A question that takes one
	/// option moves the dialog on to the next question without an answer.
	pub(super) fn pick_dialog_option(&mut self, index: usize, cx: &mut Context<Self>) {
		let Some(shown) = self.shown.as_mut() else {
			return;
		};
		let (Owned::Dialog(dialog), Some(state)) = (&shown.decision, &mut shown.dialog) else {
			return;
		};
		let tab = state.tab(cx);
		if dialog
			.questions
			.get(tab)
			.is_none_or(|question| index >= question.options.len())
		{
			return;
		}
		let advance = state.pick(dialog, tab, index);
		shown.cursor = Some(index);
		if advance && let Some(next) = state.next_unanswered(tab, cx) {
			state.select(next, cx);
		}
		cx.notify();
	}

	/// Enter on the dialog: picks the option the keyboard is on when it is
	/// not picked yet, else submits or moves on.
	pub(super) fn confirm_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		let Some((_, state)) = self.shown_dialog() else {
			return;
		};
		let tab = state.tab(cx);
		let cursor = self.shown.as_ref().and_then(|shown| shown.cursor);
		let unpicked = cursor.filter(|&index| {
			let picked = state.questions.get(tab).is_some_and(|question| {
				u32::try_from(index).is_ok_and(|index| question.selected.contains(&index))
			});
			!picked
		});
		match unpicked {
			Some(index) => self.pick_dialog_option(index, cx),
			None => self.advance_dialog(window, cx),
		}
	}

	/// Submits the dialog once every question has an answer, else shows the
	/// next question without one.
	pub(super) fn advance_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		let complete = self
			.shown_dialog()
			.is_some_and(|(dialog, state)| state.answers(dialog, cx).is_some());
		if complete {
			self.submit_dialog(window, cx);
		} else {
			self.next_question(window, cx);
		}
	}

	/// Shows the next question without an answer.
	pub(super) fn next_question(&self, _window: &mut Window, cx: &mut Context<Self>) {
		if let Some((_, state)) = self.shown_dialog()
			&& let Some(next) = state.next_unanswered(state.tab(cx), cx)
		{
			state.select(next, cx);
		}
	}

	/// Sends one answer per question.
	pub(super) fn submit_dialog(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
		let answers = self
			.shown_dialog()
			.and_then(|(dialog, state)| state.answers(dialog, cx));
		if let Some(answers) = answers {
			self.send(Answer::Dialog(answers), Control::Submit, cx);
		}
	}
}
