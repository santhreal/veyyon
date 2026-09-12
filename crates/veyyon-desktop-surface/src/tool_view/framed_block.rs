//! Native GPUI renderer for `FramedBlockView` (§contracts/view).

use veyyon_desktop_kit::{ColorRole, RadiusStep, SpacingStep, TokenSet};
use veyyon_desktop_model::tool_view::{FramedBlockView, ViewContentsKind, ViewStatus};
use veyyon_gpui::{Div, ParentElement, Styled, div};

use super::{ToolViewCallbacks, section::render_section, status_row::render_status_row};

/// Renders a framed panel block with header, state styling, and sections.
#[must_use]
pub fn render_framed_block(
	view: &FramedBlockView,
	tokens: &TokenSet,
	row_budget: Option<usize>,
	callbacks: &ToolViewCallbacks,
) -> Div {
	// Frame border color: accented by state if error or warning
	let border_color = match view.state {
		Some(ViewStatus::Error) => tokens.color(ColorRole::ErrorInk),
		Some(ViewStatus::Warning) => tokens.color(ColorRole::AttentionInk),
		Some(ViewStatus::Success | ViewStatus::Done) => {
			let mut c = tokens.color(ColorRole::DoneInk);
			c.a *= 0.6;
			c
		},
		_ => tokens.color(ColorRole::Hairline),
	};

	let bg_color = match view.contents.unwrap_or(ViewContentsKind::Report) {
		ViewContentsKind::Data => tokens.color(ColorRole::Ground),
		ViewContentsKind::Listing => tokens.color(ColorRole::Ground),
		ViewContentsKind::Report => tokens.color(ColorRole::Canvas),
	};

	let pad_x = if view.gutter {
		tokens.spacing(SpacingStep::S1)
	} else {
		tokens.spacing(SpacingStep::S3)
	};

	let pad_y = tokens.spacing(SpacingStep::S2);

	let mut container = div()
		.flex()
		.flex_col()
		.w_full()
		.min_w_0()
		.bg(bg_color)
		.border_1()
		.border_color(border_color)
		.rounded(tokens.radius(RadiusStep::Md))
		.px(pad_x)
		.py(pad_y);

	// 1. Optional Header Row
	if let Some(header) = &view.header {
		container = container.child(render_status_row(header, tokens, callbacks));
		if !view.sections.is_empty() {
			container = container.child(
				div()
					.w_full()
					.my(tokens.spacing(SpacingStep::S2))
					.border_b_1()
					.border_color(tokens.color(ColorRole::Hairline)),
			);
		}
	}

	// 2. Render Sections
	let mut remaining_budget = row_budget;
	for (idx, section) in view.sections.iter().enumerate() {
		let is_first = idx == 0 && view.header.is_none();
		let section_el = render_section(section, tokens, remaining_budget, callbacks, is_first);
		container = container.child(section_el);

		if let Some(budget) = remaining_budget {
			let spent = section.lines.len();
			remaining_budget = Some(budget.saturating_sub(spent));
		}
	}

	container
}
