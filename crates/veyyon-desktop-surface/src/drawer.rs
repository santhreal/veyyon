//! The terminal drawer (§5.4).
//!
//! A run that shells out produces output the operator sometimes needs verbatim,
//! and a transcript that inlines all of it stops being readable. The drawer is
//! where that output goes: docked under the session surface, sized by its own
//! token, and closed by default. It is the only surface here that shows raw
//! bytes, so it is the only one drawn entirely in the mono ramp.

use veyyon_desktop_kit::{ColorRole, MonoSizeStep, SpacingStep, TextRamp, TextWeight, TokenSet};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{IntoElement, ParentElement, Styled, div, px};

/// Builds the terminal drawer.
pub fn terminal_drawer(
	lines: &[String],
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
) -> impl IntoElement {
	let mut body = div()
		.flex()
		.flex_col()
		.w_full()
		.flex_1()
		.overflow_hidden()
		.px(tokens.spacing(SpacingStep::S3))
		.pb(tokens.spacing(SpacingStep::S2));

	for line in lines {
		body = body.child(
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

	div()
		.w_full()
		.h(px(geometry.terminal_drawer_default_height_px))
		.min_h(px(geometry.terminal_drawer_min_height_px))
		.flex_shrink_0()
		.flex()
		.flex_col()
		.bg(tokens.color(ColorRole::Canvas))
		.border_t(px(geometry.chrome_resize_handle_line_px))
		.border_color(tokens.color(ColorRole::Hairline))
		.overflow_hidden()
		.child(
			div()
				.h(px(geometry.chrome_row_height_px))
				.w_full()
				.flex_shrink_0()
				.flex()
				.flex_row()
				.items_center()
				.gap(tokens.spacing(SpacingStep::S2))
				.px(tokens.spacing(SpacingStep::S3))
				.child(
					div()
						.flex_shrink_0()
						.text_size(tokens.font_size(TextRamp::Micro))
						.line_height(tokens.line_height(TextRamp::Micro))
						.font_weight(tokens.font_weight(TextWeight::Medium))
						.text_color(tokens.color(ColorRole::Secondary))
						.child("Terminal"),
				)
				.child(div().flex_1())
				.child(
					// The handle is the affordance for the drag that resizes
					// the drawer. Its hit area is larger than its line, which
					// is why the two are separate tokens.
					div()
						.flex_shrink_0()
						.h(px(geometry.chrome_resize_handle_line_px))
						.w(px(geometry.chrome_resize_handle_hit_px))
						.bg(tokens.color(ColorRole::Hairline)),
				),
		)
		.child(body)
}
