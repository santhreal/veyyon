//! The answer row every card ends with, and what one answer dispatches.

use veyyon_desktop_kit::{
	ColorRole, RadiusStep, SpacingStep, StrokeStep, TextRamp, TextWeight, TintRole, TokenSet,
};
use veyyon_gpui::{
	Context, Div, InteractiveElement, ParentElement, StatefulInteractiveElement, Styled, div,
};

use crate::{
	ShellView,
	controls::{Availability, availability_style},
	intent::Intent,
};

/// What clicking an answer dispatches.
///
/// Fixed answers are constructed during rendering. Replies and plan refinements
/// use the current composer text at click time, not the previous rendered
/// draft.
#[derive(Clone)]
pub(super) enum Choice {
	Fixed(Box<Intent>),
	Reply { card: usize },
	Refine { card: usize },
}

impl Choice {
	fn intent(&self, view: &ShellView) -> Intent {
		match self {
			Self::Fixed(intent) => intent.as_ref().clone(),
			Self::Reply { card } => {
				Intent::Reply { card: *card, text: view.composer_text().to_string() }
			},
			Self::Refine { card } => Intent::Plan {
				card:     *card,
				accepted: false,
				feedback: view.composer_text().to_string(),
			},
		}
	}
}

/// One answer a card offers: the words on it, what pressing it dispatches,
/// and whether it ends the thing the card is about.
///
/// A destructive answer is drawn in the error ink rather than the accent and
/// is never the card's affirmative, so a card whose last control drops a goal
/// or deletes a session does not read as inviting that.
pub(super) struct Answer<'a> {
	pub label:  &'a str,
	pub choice: Choice,
	pub danger: bool,
}

impl<'a> Answer<'a> {
	pub const fn new(label: &'a str, choice: Choice) -> Self {
		Self { label, choice, danger: false }
	}

	pub const fn danger(label: &'a str, choice: Choice) -> Self {
		Self { label, choice, danger: true }
	}
}

/// Which answer in a row carries the accent: the last one that does not end
/// the thing the card is about. A row whose every answer ends it has none, so
/// a card offering only `Drop` invites nothing.
#[must_use]
pub fn affirmative(ends_the_subject: impl IntoIterator<Item = bool>) -> Option<usize> {
	let mut found = None;
	for (index, ends) in ends_the_subject.into_iter().enumerate() {
		if !ends {
			found = Some(index);
		}
	}
	found
}

/// The answer row every card ends with. A decision surface that states the
/// question without offering the answers is a notification.
pub(super) fn answers(
	choices: &[Answer<'_>],
	availability: &Availability,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let (opacity, cursor, activatable) = availability_style(availability, tokens);
	let mut row = div()
		.w_full()
		.flex()
		.flex_row()
		.justify_end()
		.gap(tokens.spacing(SpacingStep::S2));

	// The last choice that does not end the card's subject is the affirmative
	// one and carries the accent; the rest are ink on hairline, so the default
	// reading of the card is what it will do. A neutral fill here would paint
	// a second ground over the card's own. A destructive answer takes the
	// error tint at the same weight as the quiet ones, which is §6.10's
	// danger control: an edge and an ink, never a fill inviting the press.
	let last = affirmative(choices.iter().map(|answer| answer.danger));
	let error = tokens.tint(TintRole::Error);
	for (index, Answer { label, choice, danger }) in choices.iter().enumerate() {
		let (ground, edge, ink, hover) = if *danger {
			(tokens.transparent(), error.fill, error.ink, error.fill)
		} else if Some(index) == last {
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

		let mut answer = div()
			.id(("choice", index))
			.flex_shrink_0()
			.px(tokens.spacing(SpacingStep::S3))
			.py(tokens.spacing(SpacingStep::S1))
			.rounded(tokens.radius(RadiusStep::Sm))
			.bg(ground)
			.border(tokens.stroke(StrokeStep::Hairline))
			.border_color(edge)
			.opacity(opacity)
			.cursor(cursor)
			.text_size(tokens.font_size(TextRamp::Micro))
			.line_height(tokens.line_height(TextRamp::Micro))
			.font_weight(tokens.font_weight(TextWeight::Medium))
			.text_color(ink)
			.child((*label).to_owned());
		if activatable {
			answer = answer
				.on_click(cx.listener(move |view, _event, _window, cx| {
					let intent = choice.intent(view);
					view.dispatch(intent, cx);
				}))
				.hover(move |style| style.bg(hover));
		}
		row = row.child(answer);
	}

	row
}
