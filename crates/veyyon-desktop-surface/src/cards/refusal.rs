//! The refusal card: what the agent or environment refused, drawn as text.

use veyyon_desktop_kit::{
	ColorRole, RadiusStep, SpacingStep, TextRamp, TextWeight, TintRole, TokenSet,
};
use veyyon_desktop_tokens::AttachedCardsSurfaceTokens;
use veyyon_gpui::{Context, Div, ParentElement, Styled, div, px};

use super::{
	answers::{Answer, Choice, answers},
	shell,
};
use crate::{ShellView, controls::Availability, intent::Intent};

/// A refusal decision card: what was refused and why, drawn as plain text.
pub(super) fn refusal(
	card: usize,
	title: &str,
	detail: &[String],
	answer: &Availability,
	geometry: &AttachedCardsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let mut pane = div()
		.w_full()
		.max_h(px(geometry.approval_detail_mono_pane_cap_px))
		.overflow_hidden()
		.rounded(tokens.radius(RadiusStep::Sm))
		.bg(tokens.color(ColorRole::Inset))
		.p(tokens.spacing(SpacingStep::S2))
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S1));

	for line in detail {
		pane = pane.child(
			div()
				.w_full()
				.min_w_0()
				.overflow_hidden()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Secondary))
				.child(line.clone()),
		);
	}

	shell(TintRole::Error, geometry.approval_padding, tokens)
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
		.child(pane)
		.child(answers(
			&[Answer::new(
				"Dismiss",
				Choice::Fixed(Box::new(Intent::Approval { card, approved: false, standing: false })),
			)],
			answer,
			tokens,
			cx,
		))
}
