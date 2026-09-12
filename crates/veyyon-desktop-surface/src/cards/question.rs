//! The question card: what the agent is asking, and the answers it offers.

use veyyon_desktop_kit::{ColorRole, RadiusStep, SpacingStep, TextRamp, TintRole, TokenSet};
use veyyon_desktop_tokens::AttachedCardsSurfaceTokens;
use veyyon_gpui::{
	Context, Div, InteractiveElement, ParentElement, StatefulInteractiveElement, Styled, div, px,
};

use super::{
	answers::{Choice, answers},
	shell,
};
use crate::{
	ShellView,
	controls::{Availability, availability_style},
	intent::Intent,
};

/// A question: what the agent is asking, and the answers it offers.
pub(super) fn question(
	card: usize,
	prompt: &str,
	options: &[String],
	answer: &Availability,
	geometry: &AttachedCardsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let mut element = shell(TintRole::Input, geometry.question_padding, tokens).child(
		div()
			.w_full()
			.text_size(px(geometry.question_size.size))
			.line_height(px(geometry.question_size.line_height))
			.text_color(tokens.color(ColorRole::Foreground))
			.child(prompt.to_owned()),
	);

	// A question's options are its answers: the row is the control, not a list
	// above one, because an option an operator cannot click is a transcript of
	// the question rather than a way to answer it. An answer the host cannot
	// take is the one case a row is drawn and not offered, at the opacity
	// every unavailable control is drawn at (§4.3).
	let (opacity, cursor, activatable) = availability_style(answer, tokens);
	for (option, label) in options.iter().enumerate() {
		let hover = tokens.row_hover();
		let formatted_label = if option < 9 {
			format!("{}. {}", option + 1, label)
		} else {
			label.clone()
		};

		let mut row = div()
			.id(("option", option))
			.h(px(geometry.question_option_row_height_px))
			.w_full()
			.flex()
			.items_center()
			.px(tokens.spacing(SpacingStep::S2))
			.rounded(tokens.radius(RadiusStep::Sm))
			.bg(tokens.color(ColorRole::Inset))
			.opacity(opacity)
			.cursor(cursor)
			.min_w_0()
			.overflow_hidden()
			.whitespace_nowrap()
			.truncate()
			.text_size(tokens.font_size(TextRamp::Small))
			.line_height(tokens.line_height(TextRamp::Small))
			.text_color(tokens.color(ColorRole::Secondary))
			.child(formatted_label);
		if activatable {
			row = row
				.on_click(cx.listener(move |view, _event, _window, cx| {
					view.dispatch(Intent::Answer { card, option }, cx);
				}))
				.hover(move |style| style.bg(hover));
		}
		element = element.child(row);
	}

	// A question that offers options is answered by one of them: the host
	// takes an option index for it and refuses free text, leaving the question
	// open. So the composer's text is an answer only where the question has no
	// options, and the card offers that reply only there (§5.5).
	if options.is_empty() {
		element = element.child(answers(
			&[("Reply with the composer's text", Choice::Reply { card })],
			answer,
			tokens,
			cx,
		));
	}
	element
}
