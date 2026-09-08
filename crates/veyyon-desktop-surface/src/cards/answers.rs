//! The answer row every card ends with, and what one answer dispatches.

use veyyon_desktop_kit::{
	ColorRole, RadiusStep, SpacingStep, StrokeStep, TextRamp, TextWeight, TokenSet,
};
use veyyon_gpui::{
	Context, Div, InteractiveElement, ParentElement, StatefulInteractiveElement, Styled, div,
};

use crate::{ShellView, intent::Intent};

/// What clicking an answer dispatches.
///
/// Most answers are decided when the card is drawn. A reply is not: its text
/// is whatever the composer holds at the click, so it is built then.
#[derive(Clone)]
pub(super) enum Choice {
	Fixed(Box<Intent>),
	Reply { card: usize },
}

impl Choice {
	fn intent(&self, view: &ShellView) -> Intent {
		match self {
			Self::Fixed(intent) => intent.as_ref().clone(),
			Self::Reply { card } => {
				Intent::Reply { card: *card, text: view.composer_text().to_string() }
			},
		}
	}
}

/// The answer row every card ends with. A decision surface that states the
/// question without offering the answers is a notification.
pub(super) fn answers(
	choices: &[(&str, Choice)],
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let mut row = div()
		.w_full()
		.flex()
		.flex_row()
		.justify_end()
		.gap(tokens.spacing(SpacingStep::S2));

	// The last choice is the affirmative one and carries the accent; the rest
	// are ink on hairline, so the default reading of the card is what it will
	// do. A neutral fill here would paint a second ground over the card's own.
	let last = choices.len().saturating_sub(1);
	for (index, (label, choice)) in choices.iter().enumerate() {
		let affirmative = index == last;
		let (ground, edge, ink, hover) = if affirmative {
			(
				tokens.color(ColorRole::Accent),
				tokens.transparent(),
				tokens.color(ColorRole::AccentForeground),
				tokens.color(ColorRole::Focus),
			)
		} else {
			(
				tokens.transparent(),
				tokens.color(ColorRole::Hairline),
				tokens.color(ColorRole::Secondary),
				tokens.row_hover(),
			)
		};
		let choice = choice.clone();

		row = row.child(
			div()
				.id(("choice", index))
				.on_click(cx.listener(move |view, _event, _window, cx| {
					let intent = choice.intent(view);
					view.dispatch(intent, cx);
				}))
				.hover(move |style| style.bg(hover))
				.flex_shrink_0()
				.px(tokens.spacing(SpacingStep::S3))
				.py(tokens.spacing(SpacingStep::S1))
				.rounded(tokens.radius(RadiusStep::Sm))
				.bg(ground)
				.border(tokens.stroke(StrokeStep::Hairline))
				.border_color(edge)
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(ink)
				.child((*label).to_owned()),
		);
	}

	row
}
