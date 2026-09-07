//! Native GPUI renderer for Tree hierarchy lines in `ViewSection`
//! (§contracts/view).

use veyyon_desktop_kit::{ColorRole, MonoSizeStep, MonoText, SpacingStep, TokenSet};
use veyyon_desktop_model::tool_view::{ViewLine, ViewTreeLines};
use veyyon_gpui::{Div, ParentElement, Styled, div};

use super::{ToolViewCallbacks, text_block::render_line};

/// Renders tree hierarchy lines with branch and leaf connectors.
#[must_use]
pub fn render_tree_lines(
	lines: &[ViewLine],
	tree: &ViewTreeLines,
	start_idx: usize,
	tokens: &TokenSet,
	callbacks: &ToolViewCallbacks,
) -> Div {
	let mut container = div().flex().flex_col().w_full();

	for (rel_idx, line) in lines.iter().enumerate() {
		let abs_idx = start_idx + rel_idx;
		let depth = tree.depth.get(abs_idx).copied().unwrap_or(0);
		let opens = tree.opens.get(abs_idx).copied().unwrap_or(true);
		let last = tree.last.get(abs_idx).copied().unwrap_or(false);

		let connector = if depth == 0 {
			String::new()
		} else {
			let indent = "  ".repeat(depth.saturating_sub(1));
			let mark = if opens {
				if last { "└── " } else { "├── " }
			} else {
				"│   "
			};
			format!("{indent}{mark}")
		};

		let row = div()
			.flex()
			.flex_row()
			.items_center()
			.w_full()
			.gap(tokens.spacing(SpacingStep::S1))
			.child(
				div()
					.flex_shrink_0()
					.mono_text(tokens, MonoSizeStep::Small)
					.text_color(tokens.color(ColorRole::Muted))
					.child(connector),
			)
			.child(
				div()
					.flex_1()
					.min_w_0()
					.child(render_line(line, tokens, callbacks, false)),
			);

		container = container.child(row);
	}

	container
}
