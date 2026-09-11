//! Reasoning / thinking block renderer (§5.2, §5.3).
//!
//! Renders thought summaries collapsed to a single line, expanding to full
//! thought prose with animated height reveal and markdown formatting.

use std::time::Instant;

use veyyon_desktop_kit::{
	ColorRole, Icon, IconName, IconSize, Markdown, SelectableProse, SpacingStep, TextRamp, TokenSet,
	controls::button::{Button, ButtonSize},
};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{
	CursorStyle, Div, ElementId, InteractiveElement, ParentElement, Styled, WeakEntity, div, px,
};

use super::reveal::render_reveal_container;
use crate::{
	ShellView,
	transcript::{selection::selectable_markdown, state::TranscriptViewportState},
};

/// Reasoning / thinking block, collapsed to a 24px line, expanding to full
/// thought prose.
pub fn render_reason_block(
	turn_ix: usize,
	block_ix: usize,
	summary: &str,
	is_expanded: bool,
	geometry: &TranscriptSurfaceTokens,
	tokens: &TokenSet,
	motion_tokens: &MotionTokens,
	reduced_motion: bool,
	viewport_state: &TranscriptViewportState,
	view: Option<&WeakEntity<ShellView>>,
	selection: Option<SelectableProse>,
) -> Div {
	let chevron = if is_expanded {
		IconName::ChevronDown
	} else {
		IconName::ChevronRight
	};

	let state_toggle = viewport_state.clone();
	let state_collapse = viewport_state.clone();
	let motion_tokens_toggle = motion_tokens.clone();
	let motion_tokens_collapse = motion_tokens.clone();
	let view_toggle = view.cloned();
	let view_collapse = view.cloned();

	let header = div()
		.h(px(geometry.chrome_collapsed_height_px))
		.w_full()
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.cursor(CursorStyle::PointingHand)
		.on_mouse_down(veyyon_gpui::MouseButton::Left, move |_event, _window, cx| {
			state_toggle.toggle_block_expanded(
				turn_ix,
				block_ix,
				&motion_tokens_toggle,
				reduced_motion,
				Instant::now(),
			);
			if let Some(v) = &view_toggle {
				let _ = v.update(cx, |_view, cx| cx.notify());
			}
		})
		.child(
			div().flex_shrink_0().child(
				Icon::new(chevron)
					.size(IconSize::Size12)
					.color(tokens.color(ColorRole::Muted)),
			),
		)
		.child(
			div()
				.flex_1()
				.min_w_0()
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.italic()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.child(format!("Thought: {summary}")),
		);

	let mut container = div().flex().flex_col().w_full().child(header);

	let details = div()
		.flex()
		.flex_col()
		.w_full()
		.mt(px(4.0))
		.p(tokens.spacing(SpacingStep::S3))
		.bg(tokens.color(ColorRole::Canvas))
		.rounded_md()
		.border_l_2()
		.border_color(tokens.color(ColorRole::Accent))
		.gap(tokens.spacing(SpacingStep::S2))
		.child(
			div()
				.italic()
				.text_color(tokens.color(ColorRole::Secondary))
				.child(selectable_markdown(
					Markdown::new(summary.to_owned()).prose_size(
						px(geometry.assistant_turn_type_size.size * 0.95),
						px(geometry.assistant_turn_type_size.line_height * 0.95),
					),
					selection,
				)),
		)
		.child(
			div().flex().justify_end().w_full().child(
				Button::new(
					ElementId::Name(format!("reason-collapse-{turn_ix}-{block_ix}").into()),
					"Collapse",
				)
				.size(ButtonSize::Small)
				.on_click(move |_event, _window, cx| {
					state_collapse.set_block_expanded(
						turn_ix,
						block_ix,
						false,
						&motion_tokens_collapse,
						reduced_motion,
						Instant::now(),
					);
					if let Some(v) = &view_collapse {
						let _ = v.update(cx, |_view, cx| cx.notify());
					}
				}),
			),
		);

	if let Some(revealed) =
		render_reveal_container(turn_ix, block_ix, is_expanded, viewport_state, view, details)
	{
		container = container.child(revealed);
	}

	container
}
