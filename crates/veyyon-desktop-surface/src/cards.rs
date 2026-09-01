//! Attached cards: approval, question and plan (§5.3).
//!
//! These are the surfaces that make this a control surface rather than a
//! transcript viewer. A run that needs a decision does not bury the request in
//! scrollback where it competes with output; it attaches a card directly above
//! the composer, where the operator is already looking and already typing.
//!
//! The stack is capped. Three sessions asking at once is a queue of decisions,
//! not three stacked dialogs, so past the cap the rest collapse to one row that
//! states how many are waiting. An operator who cannot see the composer cannot
//! answer anything.

use veyyon_desktop_kit::{
	ColorRole, MonoSizeStep, RadiusStep, SpacingStep, StrokeStep, TextRamp, TextWeight, TintRole,
	TokenSet,
};
use veyyon_desktop_tokens::AttachedCardsSurfaceTokens;
use veyyon_gpui::{Div, IntoElement, ParentElement, Styled, div, px};

use crate::model::Card;

/// Builds the attached card stack, capped at the token's visible count.
pub fn card_stack(
	cards: &[Card],
	geometry: &AttachedCardsSurfaceTokens,
	tokens: &TokenSet,
) -> impl IntoElement {
	let mut stack = div()
		.flex()
		.flex_col()
		.w_full()
		.gap(tokens.spacing(SpacingStep::S2));

	let visible = geometry.stack_max_visible.min(cards.len());
	for card in cards.iter().take(visible) {
		stack = stack.child(match card {
			Card::Approval { tool, detail } => approval(tool, detail, geometry, tokens),
			Card::Question { prompt, options } => question(prompt, options, geometry, tokens),
			Card::Plan { title, body } => plan(title, body, geometry, tokens),
		});
	}

	let hidden = cards.len().saturating_sub(visible);
	if hidden > 0 {
		stack = stack.child(
			div()
				.h(px(geometry.stack_overflow_collapsed_height_px))
				.w_full()
				.flex()
				.items_center()
				.px(tokens.spacing(SpacingStep::S3))
				.rounded(tokens.radius(RadiusStep::Md))
				.bg(tokens.color(ColorRole::Inset))
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child(format!("{hidden} more waiting")),
		);
	}

	stack
}

/// The shell every card shares: a tinted edge naming what kind of decision it
/// is, so the kind is readable before the text is.
fn shell(tint: TintRole, padding: f32, tokens: &TokenSet) -> Div {
	div()
		.w_full()
		.p(px(padding))
		.rounded(tokens.radius(RadiusStep::Md))
		.bg(tokens.color(ColorRole::Float))
		.border(tokens.stroke(StrokeStep::Hairline))
		.border_color(tokens.tint(tint).fill)
		.overflow_hidden()
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S2))
}

/// An approval: what the agent wants to run, and the two answers.
fn approval(
	tool: &str,
	detail: &[String],
	geometry: &AttachedCardsSurfaceTokens,
	tokens: &TokenSet,
) -> Div {
	let mut pane = div()
		.w_full()
		.max_h(px(geometry.approval_detail_mono_pane_cap_px))
		.overflow_hidden()
		.rounded(tokens.radius(RadiusStep::Sm))
		.bg(tokens.color(ColorRole::Inset))
		.p(tokens.spacing(SpacingStep::S2))
		.flex()
		.flex_col();

	for line in detail {
		pane = pane.child(
			div()
				.w_full()
				.min_w_0()
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.text_size(tokens.mono_font_size(MonoSizeStep::Small))
				.line_height(tokens.mono_line_height(MonoSizeStep::Small))
				.text_color(tokens.color(ColorRole::Secondary))
				.child(line.clone()),
		);
	}

	shell(TintRole::Approve, geometry.approval_padding, tokens)
		.child(
			div()
				.w_full()
				.min_w_0()
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.text_size(px(geometry.approval_tool_name_size.size))
				.line_height(px(geometry.approval_tool_name_size.line_height))
				.font_weight(veyyon_gpui::FontWeight(f32::from(geometry.approval_tool_name_weight)))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(tool.to_owned()),
		)
		.child(pane)
		.child(answers(&["Reject", "Approve"], tokens))
}

/// A question: what the agent is asking, and the answers it offers.
fn question(
	prompt: &str,
	options: &[String],
	geometry: &AttachedCardsSurfaceTokens,
	tokens: &TokenSet,
) -> Div {
	let mut card = shell(TintRole::Input, geometry.question_padding, tokens).child(
		div()
			.w_full()
			.text_size(px(geometry.question_size.size))
			.line_height(px(geometry.question_size.line_height))
			.text_color(tokens.color(ColorRole::Foreground))
			.child(prompt.to_owned()),
	);

	for option in options {
		card = card.child(
			div()
				.h(px(geometry.question_option_row_height_px))
				.w_full()
				.flex()
				.items_center()
				.px(tokens.spacing(SpacingStep::S2))
				.rounded(tokens.radius(RadiusStep::Sm))
				.bg(tokens.color(ColorRole::Inset))
				.min_w_0()
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Secondary))
				.child(option.clone()),
		);
	}

	card
}

/// A plan: what the agent intends, capped in height and faded at the cut.
fn plan(
	title: &str,
	body: &[String],
	geometry: &AttachedCardsSurfaceTokens,
	tokens: &TokenSet,
) -> Div {
	let mut markdown = div()
		.w_full()
		.max_h(px(geometry.plan_max_markdown_height_px))
		.overflow_hidden()
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S1));

	for line in body {
		markdown = markdown.child(
			div()
				.w_full()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Secondary))
				.child(line.clone()),
		);
	}

	shell(TintRole::Plan, geometry.plan_padding, tokens)
		.child(
			div()
				.w_full()
				.min_w_0()
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.text_size(tokens.font_size(TextRamp::Body))
				.line_height(tokens.line_height(TextRamp::Body))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(title.to_owned()),
		)
		.child(markdown)
		.child(answers(&["Revise", "Accept"], tokens))
}

/// The answer row every card ends with. A decision surface that states the
/// question without offering the answers is a notification.
fn answers(labels: &[&str], tokens: &TokenSet) -> Div {
	let mut row = div()
		.w_full()
		.flex()
		.flex_row()
		.justify_end()
		.gap(tokens.spacing(SpacingStep::S2));

	// The last label is the affirmative one and carries the accent; the rest
	// are quiet, so the default reading of the card is what it will do.
	let last = labels.len().saturating_sub(1);
	for (index, label) in labels.iter().enumerate() {
		let affirmative = index == last;
		let (ground, ink) = if affirmative {
			(tokens.color(ColorRole::Accent), tokens.color(ColorRole::AccentForeground))
		} else {
			(tokens.color(ColorRole::Inset), tokens.color(ColorRole::Secondary))
		};

		row = row.child(
			div()
				.flex_shrink_0()
				.px(tokens.spacing(SpacingStep::S3))
				.py(tokens.spacing(SpacingStep::S1))
				.rounded(tokens.radius(RadiusStep::Sm))
				.bg(ground)
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(ink)
				.child((*label).to_owned()),
		);
	}

	row
}
