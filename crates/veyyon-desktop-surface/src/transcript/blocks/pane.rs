//! Collapsed transcript output with animated, height-bounded disclosure.

use std::time::Instant;

use veyyon_desktop_kit::{
	CodeBlock, ColorRole, Icon, IconName, IconSize, MonoSizeStep, SelectableProse, SpacingStep,
	TextRamp, TokenSet, Truncate,
};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{
	CursorStyle, Div, InteractiveElement, ParentElement, SharedString, Styled, WeakEntity, div, px,
};

use super::reveal::render_reveal_container;
use crate::{ShellView, transcript::state::TranscriptViewportState};

/// Output starts as one line; expanded content scrolls within its height limit.
pub fn render_pane_block(
	turn_ix: usize,
	block_ix: usize,
	caption: &str,
	lines: &[String],
	is_expanded: bool,
	subordinate: bool,
	geometry: &TranscriptSurfaceTokens,
	tokens: &TokenSet,
	motion_tokens: &MotionTokens,
	reduced_motion: bool,
	viewport_state: &TranscriptViewportState,
	view: Option<&WeakEntity<ShellView>>,
	selection: Option<SelectableProse>,
) -> Div {
	let state_toggle = viewport_state.clone();
	let view_toggle = view.cloned();
	let motion = motion_tokens.clone();
	let header = div()
		.h(px(if subordinate {
			geometry.chrome_event_line_height_px
		} else {
			geometry.chrome_collapsed_height_px
		}))
		.w_full()
		.flex()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.cursor(CursorStyle::PointingHand)
		.on_mouse_down(veyyon_gpui::MouseButton::Left, move |_event, _window, cx| {
			state_toggle.toggle_block_expanded(
				turn_ix,
				block_ix,
				&motion,
				reduced_motion,
				Instant::now(),
			);
			if let Some(view) = &view_toggle {
				let _ = view.update(cx, |_view, cx| cx.notify());
			}
		})
		.child(
			Icon::new(if is_expanded {
				IconName::ChevronDown
			} else {
				IconName::ChevronRight
			})
			.size(IconSize::Size12)
			.color(tokens.color(ColorRole::Muted)),
		)
		.child(
			div().flex_1().min_w_0().child(
				Truncate::new(caption.to_owned())
					.ramp(TextRamp::Small)
					.color(if subordinate {
						ColorRole::Muted
					} else {
						ColorRole::Secondary
					}),
			),
		)
		.child(
			div()
				.flex_shrink_0()
				.text_size(tokens.font_size(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child(format!("{} lines", lines.len())),
		);
	let container = div().flex().flex_col().w_full().child(header);
	let (progress, _) = viewport_state.reveal_frame(turn_ix, block_ix, Instant::now());
	if !is_expanded && progress <= 0.0 {
		return container;
	}
	let mut pane = CodeBlock::lines(lines.iter().map(|line| SharedString::from(line.clone())))
		.size(MonoSizeStep::Small)
		.max_height(px(geometry.chrome_invoke_mono_pane_max_height_px));
	// The lines are the pane's spans, one each, numbered from the block: the
	// caption heads the row that opens the pane and is no span, so a drag over
	// it does not fight the press that expands the body.
	if let Some(prose) = &selection {
		pane = pane.selection(prose.clone(), prose.span(0));
	}
	let details = div().w_full().child(pane);
	container.children(render_reveal_container(
		turn_ix,
		block_ix,
		is_expanded,
		viewport_state,
		view,
		details,
	))
}
