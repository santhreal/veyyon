//! Native GPUI renderer for Code lines in `ViewSection` (§contracts/view).

use veyyon_desktop_kit::{ColorRole, MonoSizeStep, MonoText, SpacingStep, TokenSet};
use veyyon_desktop_model::tool_view::{ViewCodeLines, ViewLine};
use veyyon_gpui::{Div, ParentElement, Styled, div, px};

use super::{ToolViewCallbacks, sanitize::sanitize_control_sequences, text_block::render_line};

/// Renders lines formatted as Source Code with optional line numbers and lead
/// prompt.
#[must_use]
pub fn render_code_lines(
	lines: &[ViewLine],
	code: &ViewCodeLines,
	start_idx: usize,
	tokens: &TokenSet,
	callbacks: &ToolViewCallbacks,
) -> Div {
	let mut container = div()
		.flex()
		.flex_col()
		.w_full()
		.mono_text(tokens, MonoSizeStep::Small);

	// Lead prompt (e.g. $ cd services &&)
	if let Some(lead) = &code.lead {
		let clean_lead = sanitize_control_sequences(lead);
		container = container.child(
			div()
				.flex()
				.flex_row()
				.items_center()
				.px(tokens.spacing(SpacingStep::S1))
				.py(px(1.0))
				.text_color(tokens.color(ColorRole::Accent))
				.child(clean_lead),
		);
	}

	let has_line_numbers = code.line_numbers.is_some() || code.first_line_number.is_some();
	let gutter_width = if let Some(total) = code.total_lines {
		(total.to_string().len() * 9 + 12) as f32
	} else {
		36.0
	};

	for (rel_idx, line) in lines.iter().enumerate() {
		let abs_idx = start_idx + rel_idx;
		let line_num: Option<usize> = if let Some(nums) = &code.line_numbers {
			nums.get(abs_idx).copied().flatten()
		} else {
			code.first_line_number.map(|first| first + abs_idx)
		};

		let mut row = div()
			.flex()
			.flex_row()
			.items_center()
			.w_full()
			.px(tokens.spacing(SpacingStep::S1))
			.py(px(1.0));

		if has_line_numbers {
			let num_str = line_num.map(|n| n.to_string()).unwrap_or_default();
			row = row.child(
				div()
					.w(px(gutter_width))
					.flex_shrink_0()
					.text_color(tokens.color(ColorRole::Muted))
					.child(num_str),
			);
		}

		row = row.child(
			div()
				.flex_1()
				.min_w_0()
				.child(render_line(line, tokens, callbacks, true)),
		);
		container = container.child(row);
	}

	container
}
