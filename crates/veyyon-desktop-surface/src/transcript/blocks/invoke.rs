//! Tool invocation block renderer (§5.2, §5.3).
//!
//! Renders tool invocations collapsed to a 24px interactive line, expanding to
//! target and result details with animated height reveal and width-bounded
//! summaries.

use std::time::Instant;

use veyyon_desktop_kit::{
	CodeBlock, ColorRole, Icon, IconName, IconSize, MonoSizeStep, SpacingStep, TextRamp, TextWeight,
	TokenSet, Truncate,
	controls::button::{Button, ButtonSize},
};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{
	CursorStyle, Div, InteractiveElement, ParentElement, SharedString, Styled, WeakEntity, div, px,
};

use super::reveal::render_reveal_container;
use crate::{ShellView, transcript::state::TranscriptViewportState};

/// Tool invocation block, collapsed to a 24px interactive line, expanding to
/// parameter and result details.
pub fn render_invoke_block(
	turn_ix: usize,
	block_ix: usize,
	tool: &str,
	target: &str,
	result: Option<&str>,
	is_expanded: bool,
	geometry: &TranscriptSurfaceTokens,
	tokens: &TokenSet,
	motion_tokens: &MotionTokens,
	reduced_motion: bool,
	viewport_state: &TranscriptViewportState,
	view: Option<&WeakEntity<ShellView>>,
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

	let mut header = div()
		.h(px(geometry.chrome_event_line_height_px))
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
				.flex_shrink_0()
				.text_size(tokens.mono_font_size(MonoSizeStep::Small))
				.line_height(tokens.mono_line_height(MonoSizeStep::Small))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(tool.to_owned()),
		)
		.child(
			div().flex_1().min_w_0().child(
				Truncate::new(target.to_owned())
					.mono(MonoSizeStep::Small)
					.color(ColorRole::Secondary),
			),
		);

	if let Some(res) = result {
		let summary = res.lines().next().unwrap_or("").trim();
		header = header.child(
			div().flex_shrink_0().max_w(px(240.0)).min_w_0().child(
				Truncate::new(summary.to_owned())
					.ramp(TextRamp::Micro)
					.color(ColorRole::Muted),
			),
		);
	} else if viewport_state.is_streaming() && turn_ix + 1 == viewport_state.turn_count() {
		header = header.child(
			div()
				.flex_shrink_0()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Accent))
				.child("Running..."),
		);
	}

	let mut container = div().flex().flex_col().w_full().child(header);

	let mut details = div()
		.flex()
		.flex_col()
		.w_full()
		.mt(px(4.0))
		.p(tokens.spacing(SpacingStep::S2))
		.bg(tokens.color(ColorRole::Canvas))
		.rounded_md()
		.border_1()
		.border_color(tokens.color(ColorRole::Hairline))
		.gap(tokens.spacing(SpacingStep::S2));

	if !target.is_empty() {
		details = details.child(
			div()
				.text_size(tokens.mono_font_size(MonoSizeStep::Small))
				.text_color(tokens.color(ColorRole::Secondary))
				.child(format!("Target: {target}")),
		);
	}

	if let Some(res) = result {
		let lines: Vec<SharedString> = res
			.lines()
			.map(|l| SharedString::from(l.to_owned()))
			.collect();
		details = details.child(
			CodeBlock::lines(lines)
				.caption("Output")
				.size(MonoSizeStep::Small)
				.max_height(px(geometry.chrome_invoke_mono_pane_max_height_px)),
		);
	}

	details = details.child(
		div().flex().justify_end().w_full().child(
			Button::new("Collapse")
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
