//! The plan card: what the agent intends, capped in height and faded at the
//! cut.

use veyyon_desktop_kit::{ColorRole, SpacingStep, TextRamp, TextWeight, TintRole, TokenSet};
use veyyon_desktop_tokens::AttachedCardsSurfaceTokens;
use veyyon_gpui::{
	Context, Div, ParentElement, Styled, div, linear_color_stop, linear_gradient, prelude::*, px,
};

use super::{
	answers::{Choice, answers},
	shell,
};
use crate::{ShellView, intent::Intent};

/// A plan: what the agent intends, capped in height and faded at the cut.
pub(super) fn plan(
	card: usize,
	title: &str,
	body: &[String],
	geometry: &AttachedCardsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let mut lines = div()
		.w_full()
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S1));

	for line in body {
		lines = lines.child(
			div()
				.w_full()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Secondary))
				.child(line.clone()),
		);
	}

	// The cut is what the fade states, so the fade is drawn only where the
	// body reaches the cap: over a plan that fits, a gradient would dim the
	// last line it has. The height is the stack the lines make at the ramp
	// they are set in, which is a floor -- a line long enough to wrap counts
	// once here, so a body that only just overruns is cut without the fade.
	let lines_high = body.len() as f32 * f32::from(tokens.line_height(TextRamp::Small));
	let gaps_high = body.len().saturating_sub(1) as f32 * f32::from(tokens.spacing(SpacingStep::S1));
	let stacked = lines_high + gaps_high;
	let ground = tokens.color(ColorRole::Float);
	let markdown = div()
		.relative()
		.w_full()
		.max_h(px(geometry.plan_max_markdown_height_px))
		.overflow_hidden()
		.child(lines)
		.when(stacked > geometry.plan_max_markdown_height_px, |pane| {
			pane.child(
				div()
					.absolute()
					.bottom_0()
					.left_0()
					.right_0()
					.h(px(geometry.plan_fade_height_px))
					.bg(linear_gradient(
						180.0,
						linear_color_stop(ground.opacity(0.0), 0.0),
						linear_color_stop(ground, 1.0),
					)),
			)
		});

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
		.child(answers(
			&[
				("Revise", Choice::Refine { card }),
				(
					"Accept",
					Choice::Fixed(Box::new(Intent::Plan {
						card,
						accepted: true,
						feedback: String::new(),
					})),
				),
			],
			tokens,
			cx,
		))
}
