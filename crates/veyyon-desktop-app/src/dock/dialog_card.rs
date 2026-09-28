//! How a dialog's card is drawn: a tab per question, the question and its
//! options with the focused option's preview beside them, the written answer
//! and the note, the time left, and submit or chat instead.

use gpui::{AnyElement, App, Context, Entity, SharedString, Window, div, prelude::*};
use veyyon_desktop_model::{DialogInteraction, DialogQuestion};
use veyyon_desktop_ui::{
	controls::{Button, ButtonSize, ButtonVariant},
	editor::Editor,
	theme::{ActiveTheme, TypeStyled, radius, space, text},
};

use super::{
	InteractionDock,
	dialog::{DialogState, QuestionState},
	row::{Marker, OptionRow, body_max},
};

/// A field of the dialog, framed as an input.
fn field(editor: &Entity<Editor>, cx: &App) -> impl IntoElement {
	let palette = cx.theme().palette;
	div()
		.px(space::S2_5)
		.py(space::S1_5)
		.rounded(radius::MD)
		.border_1()
		.border_color(palette.border.default)
		.bg(palette.bg.app)
		.child(editor.clone())
}

impl InteractionDock {
	/// The dialog's card body.
	pub(super) fn render_dialog(
		&self,
		dialog: &DialogInteraction,
		state: &DialogState,
		blocked: bool,
		window: &Window,
		cx: &Context<Self>,
	) -> AnyElement {
		let palette = cx.theme().palette;
		let tab = state.tab(cx);
		let (Some(question), Some(answers)) = (dialog.questions.get(tab), state.questions.get(tab))
		else {
			return div().into_any_element();
		};
		let many = dialog.questions.len() > 1;
		let header = div()
			.flex()
			.items_center()
			.justify_between()
			.gap(space::S3)
			.child(if many {
				div()
					.flex_1()
					.min_w_0()
					.child(state.tabs.clone())
					.into_any_element()
			} else {
				div()
					.type_style(text::SMALL)
					.text_color(palette.text.muted)
					.child(SharedString::from(super::dialog::tab_label(question)))
					.into_any_element()
			})
			.children(state.countdown.clone());
		let asked = div()
			.id("dock-dialog-question")
			.max_h(body_max(window))
			.overflow_y_scroll()
			.type_style(text::BODY)
			.text_color(palette.text.primary)
			.child(question.question.clone());
		div()
			.flex()
			.flex_col()
			.gap(space::S2)
			.child(header)
			.child(asked)
			.child(self.render_dialog_options(question, answers, blocked, cx))
			.child(field(&answers.custom, cx))
			.child(field(&answers.note, cx))
			.child(Self::render_dialog_footer(dialog, state, blocked, cx))
			.into_any_element()
	}

	/// The question's options, and beside them the preview of the one the
	/// keyboard is on.
	fn render_dialog_options(
		&self,
		question: &DialogQuestion,
		answers: &QuestionState,
		blocked: bool,
		cx: &Context<Self>,
	) -> AnyElement {
		let palette = cx.theme().palette;
		let cursor = self.shown.as_ref().and_then(|shown| shown.cursor);
		let recommended = question
			.recommended
			.and_then(|index| usize::try_from(index).ok());
		let rows = question.options.iter().enumerate().map(|(index, option)| {
			let picked = u32::try_from(index).is_ok_and(|index| answers.selected.contains(&index));
			let marker = if question.multi {
				Marker::Check(picked)
			} else {
				Marker::Radio(picked)
			};
			OptionRow::new(("dock-dialog-option", index), index, option.label.clone())
				.description(option.description.as_ref())
				.marker(marker)
				.recommended(recommended == Some(index))
				.cursor(cursor == Some(index))
				.disabled(blocked)
				.render(cx.listener(move |this, _, window, cx| this.pick(index, window, cx)), cx)
		});
		let options = div()
			.flex()
			.flex_col()
			.flex_1()
			.min_w_0()
			.gap(space::S0_5)
			.children(rows);
		let preview = cursor
			.and_then(|index| question.options.get(index))
			.and_then(|option| option.preview.clone())
			.map(|preview| {
				div()
					.id("dock-dialog-preview")
					.flex_1()
					.min_w_0()
					.overflow_y_scroll()
					.px(space::S2_5)
					.py(space::S2)
					.rounded(radius::LG)
					.bg(palette.code.bg)
					.type_style(text::MONO)
					.text_color(palette.text.secondary)
					.child(preview)
			});
		div()
			.flex()
			.items_start()
			.gap(space::S3)
			.child(options)
			.children(preview)
			.into_any_element()
	}

	/// How many questions have an answer, chat instead, and next or submit.
	fn render_dialog_footer(
		dialog: &DialogInteraction,
		state: &DialogState,
		blocked: bool,
		cx: &Context<Self>,
	) -> AnyElement {
		let palette = cx.theme().palette;
		let count = dialog.questions.len();
		let answered = (0..count).filter(|&at| state.is_answered(at, cx)).count();
		let tab = state.tab(cx);
		let complete = answered == count;
		let primary = if complete {
			Button::new("dock-dialog-submit", "Submit")
				.variant(ButtonVariant::Primary)
				.size(ButtonSize::Sm)
				.disabled(blocked)
				.on_click(cx.listener(|this, _, window, cx| this.submit_dialog(window, cx)))
		} else {
			Button::new("dock-dialog-next", "Next")
				.variant(ButtonVariant::Primary)
				.size(ButtonSize::Sm)
				.disabled(blocked || !state.is_answered(tab, cx))
				.on_click(cx.listener(|this, _, window, cx| this.next_question(window, cx)))
		};
		let progress = if count > 1 {
			format!("{answered} of {count} answered")
		} else {
			String::new()
		};
		div()
			.flex()
			.items_center()
			.gap(space::S2)
			.child(
				div()
					.flex_1()
					.min_w_0()
					.type_style(text::SMALL)
					.text_color(palette.text.muted)
					.child(progress),
			)
			.child(
				Button::new("dock-dialog-chat", "Chat instead")
					.variant(ButtonVariant::Ghost)
					.size(ButtonSize::Sm)
					.disabled(blocked)
					.on_click(cx.listener(|this, _, window, cx| this.chat_instead(window, cx))),
			)
			.child(primary)
			.into_any_element()
	}
}
