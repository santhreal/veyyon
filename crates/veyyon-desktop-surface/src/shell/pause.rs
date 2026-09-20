//! The strip that states the host has frozen every agent (§4.1).
//!
//! A freeze is not a notice. A notice reports something that already
//! happened and is dismissed once read; a freeze is a state the window is in
//! until somebody releases it, and every turn in every session stays parked
//! while it holds. So it draws as its own strip, above everything, for as
//! long as it lasts, and carries the control that ends it rather than a
//! dismissal that would leave the freeze running with nothing on screen
//! saying so.
//!
//! It sits below the connection banner for the same reason: a window that is
//! not attached has no agents to have frozen, and the banner is what the
//! operator acts on first.

use veyyon_desktop_kit::{
	ColorRole, Icon, IconName, IconSize, RadiusStep, SpacingStep, StrokeStep, TextRamp, TextWeight,
	TokenSet,
};
use veyyon_gpui::{
	Context, CursorStyle, Div, ElementId, InteractiveElement, ParentElement,
	StatefulInteractiveElement, Styled, div, px,
};

use crate::{Intent, ShellView};

/// What the strip takes off the top of the window while a freeze holds.
///
/// One line of micro text between two S2 insets, which is the attention
/// strip's geometry: two strips of different heights stacked above the same
/// columns would move the session surface by a different amount depending on
/// which one is up.
#[must_use]
pub fn pause_strip_height(tokens: &TokenSet) -> f32 {
	2.0f32.mul_add(
		f32::from(tokens.spacing(SpacingStep::S2)),
		f32::from(tokens.line_height(TextRamp::Micro)),
	)
}

/// The strip: what is frozen, how long it has been frozen, and the way out.
///
/// `elapsed` is the duration the projection resolved, so the number moves on
/// the clock tick that moves every other elapsed label rather than on a
/// timer of this strip's own.
pub fn pause_strip(elapsed: &str, tokens: &TokenSet, cx: &Context<ShellView>) -> Div {
	let stated = div()
		.flex()
		.flex_row()
		.items_center()
		.min_w_0()
		.gap(tokens.spacing(SpacingStep::S2))
		.child(
			div().flex_shrink_0().child(
				Icon::new(IconName::Pause)
					.size(IconSize::Size12)
					.color(tokens.color(ColorRole::AttentionInk)),
			),
		)
		.child(
			div()
				.min_w_0()
				.truncate()
				.child(format!("Every agent is frozen · {elapsed}")),
		);

	let resume = div()
		.id(ElementId::Name("pause-resume".into()))
		.px(tokens.spacing(SpacingStep::S2))
		.py(tokens.spacing(SpacingStep::S0))
		.rounded(tokens.radius(RadiusStep::Xs))
		.bg(tokens.color(ColorRole::AttentionInk))
		.text_color(tokens.color(ColorRole::AttentionFill))
		.text_size(tokens.font_size(TextRamp::Micro))
		.line_height(tokens.line_height(TextRamp::Micro))
		.font_weight(tokens.font_weight(TextWeight::Medium))
		.cursor(CursorStyle::PointingHand)
		.flex_shrink_0()
		.on_click(cx.listener(|view, _event, _window, cx| {
			view.dispatch(Intent::ResumeAgents, cx);
		}))
		.child("Resume");

	div()
		.h(px(pause_strip_height(tokens)))
		.w_full()
		.overflow_hidden()
		.flex()
		.flex_row()
		.items_center()
		.justify_between()
		.px(tokens.spacing(SpacingStep::S4))
		.bg(tokens.color(ColorRole::AttentionFill))
		.border_b(tokens.stroke(StrokeStep::Hairline))
		.border_color(tokens.color(ColorRole::Hairline))
		.text_size(tokens.font_size(TextRamp::Micro))
		.line_height(tokens.line_height(TextRamp::Micro))
		.font_weight(tokens.font_weight(TextWeight::Medium))
		.text_color(tokens.color(ColorRole::AttentionInk))
		.child(stated)
		.child(resume)
}
