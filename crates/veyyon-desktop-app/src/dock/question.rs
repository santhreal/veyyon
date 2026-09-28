//! The question card: the prompt and its options, each option the answer
//! itself. A question without options is answered with the composer's draft,
//! since the host takes free text only there.

use gpui::{AnyElement, Context, Window, div, prelude::*};
use veyyon_desktop_model::QuestionInteraction;
use veyyon_desktop_ui::{
	controls::ButtonVariant,
	theme::{ActiveTheme, TypeStyled, space, text},
};

use super::{
	InteractionDock,
	card::{Act, Choice, Control},
	row::{OptionRow, body_max},
};
use crate::state::Answer;

/// Each option as the answer it sends, or the composer's draft for a
/// question without options.
pub(super) fn choices(question: &QuestionInteraction) -> Vec<Choice> {
	if question.options.is_empty() {
		return vec![Choice {
			label:   "Reply".into(),
			variant: ButtonVariant::Primary,
			act:     Act::Composer,
		}];
	}
	question
		.options
		.iter()
		.enumerate()
		.map(|(index, option)| {
			let answer = Answer::Option { index, text: option.clone() };
			Choice::send(option.clone(), ButtonVariant::Secondary, answer, Control::Option(index))
		})
		.collect()
}

impl InteractionDock {
	/// The prompt, whole and scrolling past a share of the window, then the
	/// options as rows 1–9 pick, or the line pointing at the composer.
	pub(super) fn render_question(
		&self,
		question: &QuestionInteraction,
		choices: &[Choice],
		blocked: bool,
		window: &Window,
		cx: &Context<Self>,
	) -> AnyElement {
		let palette = cx.theme().palette;
		let cursor = self.shown.as_ref().and_then(|shown| shown.cursor);
		let prompt = div()
			.id("dock-question-prompt")
			.max_h(body_max(window))
			.overflow_y_scroll()
			.type_style(text::BODY)
			.text_color(palette.text.primary)
			.child(question.prompt.trim().to_owned());
		let mut body = div().flex().flex_col().gap(space::S2).child(prompt);
		if question.options.is_empty() {
			body = body.child(
				div()
					.type_style(text::SMALL)
					.text_color(palette.text.muted)
					.child("Write the answer in the composer and press Enter."),
			);
			return body.into_any_element();
		}
		let rows = choices.iter().enumerate().map(|(index, choice)| {
			OptionRow::new(("dock-question-option", index), index, choice.label.clone())
				.cursor(cursor == Some(index))
				.disabled(blocked)
				.render(cx.listener(move |this, _, window, cx| this.pick(index, window, cx)), cx)
		});
		body
			.child(div().flex().flex_col().gap(space::S0_5).children(rows))
			.into_any_element()
	}
}
