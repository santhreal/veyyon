//! The approval card: what the agent wants to run, and the four answers the
//! tool wrapper accepts.

use veyyon_desktop_kit::{
	ColorRole, MonoSizeStep, MonoText, RadiusStep, SpacingStep, TintRole, TokenSet,
};
use veyyon_desktop_tokens::AttachedCardsSurfaceTokens;
use veyyon_gpui::{Context, Div, ParentElement, Styled, div, px};

use super::{
	answers::{Choice, answers},
	shell,
};
use crate::{ShellView, intent::Intent};

/// An approval: what the agent wants to run, and the four answers the tool
/// wrapper accepts.
pub(super) fn approval(
	card: usize,
	tool: &str,
	detail: &[String],
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
		.flex_col();

	for line in detail {
		pane = pane.child(
			div()
				.w_full()
				.min_w_0()
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.mono_text(tokens, MonoSizeStep::Small)
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
		.child(answers(
			// The wrapper's own four, in its own words, with each standing
			// answer beside the once-only one it extends: a deny with no
			// standing form asks again on the next call of the same tool,
			// which is the answer an operator reaches for to stop it.
			&[
				(
					"Deny for session",
					Choice::Fixed(Box::new(Intent::Approval { card, approved: false, standing: true })),
				),
				(
					"Deny",
					Choice::Fixed(Box::new(Intent::Approval { card, approved: false, standing: false })),
				),
				(
					"Approve for session",
					Choice::Fixed(Box::new(Intent::Approval { card, approved: true, standing: true })),
				),
				(
					"Approve",
					Choice::Fixed(Box::new(Intent::Approval { card, approved: true, standing: false })),
				),
			],
			tokens,
			cx,
		))
}
