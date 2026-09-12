//! Native GPUI renderer for Diff lines in `ViewSection` (§contracts/view).

use veyyon_desktop_kit::{ColorRole, MonoSizeStep, MonoText, SpacingStep, TokenSet};
use veyyon_desktop_model::tool_view::{ViewDiffLines, ViewDiffSide, ViewLine};
use veyyon_gpui::{
	CursorStyle, Div, InteractiveElement, MouseButton, ParentElement, Styled, div, px,
};

use super::{
	ToolViewCallbacks, ToolViewTarget, sanitize::sanitize_control_sequences, text_block::render_line,
};

/// Renders lines formatted as a Diff change with side styling, gutters, and
/// targets.
#[must_use]
pub fn render_diff_lines(
	lines: &[ViewLine],
	diff: &ViewDiffLines,
	start_idx: usize,
	tokens: &TokenSet,
	callbacks: &ToolViewCallbacks,
) -> Div {
	let mut container = div()
		.flex()
		.flex_col()
		.w_full()
		.mono_text(tokens, MonoSizeStep::Small);

	let clean_path = diff.path.as_deref().map(sanitize_control_sequences);

	for (rel_idx, line) in lines.iter().enumerate() {
		let abs_idx = start_idx + rel_idx;
		let side = diff
			.sides
			.get(abs_idx)
			.copied()
			.unwrap_or(ViewDiffSide::Context);
		let line_num = diff
			.line_numbers
			.as_ref()
			.and_then(|nums| nums.get(abs_idx).copied().flatten());

		let (marker, text_color, mut bg_color) = match side {
			ViewDiffSide::Added => {
				("+", tokens.color(ColorRole::DoneInk), tokens.color(ColorRole::DoneFill))
			},
			ViewDiffSide::Removed => {
				("-", tokens.color(ColorRole::ErrorInk), tokens.color(ColorRole::ErrorFill))
			},
			ViewDiffSide::Context => (" ", tokens.color(ColorRole::Secondary), tokens.transparent()),
			ViewDiffSide::Gap => ("~", tokens.color(ColorRole::Muted), tokens.transparent()),
		};
		if bg_color != tokens.transparent() {
			bg_color.a *= 0.18;
		}

		let mut row = div()
			.flex()
			.flex_row()
			.items_center()
			.w_full()
			.px(tokens.spacing(SpacingStep::S1))
			.py(px(1.0))
			.bg(bg_color);

		// Line number gutter if provided
		if diff.line_numbers.is_some() {
			let num_str = line_num.map(|n| n.to_string()).unwrap_or_default();
			row = row.child(
				div()
					.w(px(36.0))
					.flex_shrink_0()
					.text_color(tokens.color(ColorRole::Muted))
					.child(num_str),
			);
		}

		// Marker column (+, -, ~, ' ')
		row = row.child(
			div()
				.w(px(14.0))
				.flex_shrink_0()
				.text_color(text_color)
				.child(marker),
		);

		// Line content
		let mut content_box = div().flex_1().min_w_0().text_color(text_color);

		// If path is specified and clickable target callback exists
		if let Some(path) = &clean_path
			&& let Some(on_target) = &callbacks.on_target
		{
			let cb = on_target.clone();
			let target = ToolViewTarget::File { path: path.clone(), line: line_num };
			content_box = content_box.cursor(CursorStyle::PointingHand).on_mouse_down(
				MouseButton::Left,
				move |_event, window, cx| {
					cb(target.clone(), window, cx);
				},
			);
		}

		content_box = content_box.child(render_line(line, tokens, callbacks, true));
		row = row.child(content_box);
		container = container.child(row);
	}

	container
}
