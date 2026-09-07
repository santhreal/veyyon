//! Native GPUI renderer for `NoticeView` (§contracts/view).

use veyyon_desktop_kit::{
	Icon, IconSize, RadiusStep, SpacingStep, TextRamp, TextWeight, TokenSet,
	indicators::badge::Badge,
};
use veyyon_desktop_model::tool_view::NoticeView;
use veyyon_gpui::{Div, ParentElement, Styled, div, px};

use super::{
	ToolViewCallbacks,
	sanitize::sanitize_control_sequences,
	text_block::{render_line, render_span},
	theme::{resolve_emblem_icon, resolve_status_color, resolve_status_icon, resolve_status_tint},
};

/// Renders a short notice banner whose whole body carries a single state with
/// full sanitization.
#[must_use]
pub fn render_notice(view: &NoticeView, tokens: &TokenSet, callbacks: &ToolViewCallbacks) -> Div {
	let status_color = resolve_status_color(view.state, tokens);
	let tint = resolve_status_tint(view.state);
	let tint_pair = tokens.tint(tint);

	let mut bg_color = tint_pair.fill;
	bg_color.a = 0.15;

	let mut container = div()
		.flex()
		.flex_col()
		.w_full()
		.min_w_0()
		.bg(bg_color)
		.border_1()
		.border_color(status_color)
		.rounded(tokens.radius(RadiusStep::Sm))
		.p(tokens.spacing(SpacingStep::S2))
		.gap(tokens.spacing(SpacingStep::S1));

	// 1. Headline Row with Mark, Headline Spans, and Tag
	let mut headline_row = div()
		.flex()
		.flex_row()
		.items_center()
		.w_full()
		.min_w_0()
		.gap(tokens.spacing(SpacingStep::S2));

	// Mark / Status icon with fallback
	let clean_mark = view.mark.as_deref().map(sanitize_control_sequences);
	let icon_name = clean_mark
		.as_deref()
		.and_then(resolve_emblem_icon)
		.unwrap_or_else(|| resolve_status_icon(view.state));

	headline_row = headline_row.child(
		div().flex_shrink_0().child(
			Icon::new(icon_name)
				.size(IconSize::Size14)
				.color(status_color),
		),
	);

	// Headline content
	let mut headline_content = div()
		.flex_1()
		.min_w_0()
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S1))
		.font_weight(tokens.font_weight(TextWeight::Semibold))
		.text_size(tokens.font_size(TextRamp::Small))
		.text_color(status_color);

	for span in &view.headline {
		headline_content = headline_content.child(render_span(span, tokens, callbacks));
	}
	headline_row = headline_row.child(headline_content);

	// Tag badge if provided
	if let Some(tag) = &view.tag {
		let clean_tag = sanitize_control_sequences(tag);
		headline_row = headline_row.child(div().flex_shrink_0().child(Badge::new(clean_tag, tint)));
	}

	container = container.child(headline_row);

	// 2. Optional Body Lines
	if !view.body.is_empty() {
		let mut body_container = div()
			.flex()
			.flex_col()
			.w_full()
			.min_w_0()
			.pl(px(22.0))
			.gap(tokens.spacing(SpacingStep::S1));

		for line in &view.body {
			body_container = body_container.child(render_line(line, tokens, callbacks, false));
		}

		container = container.child(body_container);
	}

	container
}
