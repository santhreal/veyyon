//! Native GPUI renderer for `HeadedBlockView` (§contracts/view).

use veyyon_desktop_kit::{
	ColorRole, Icon, IconName, IconSize, RadiusStep, SpacingStep, TextRamp, TextWeight, TokenSet,
};
use veyyon_desktop_model::tool_view::HeadedBlockView;
use veyyon_gpui::{
	CursorStyle, Div, InteractiveElement, MouseButton, ParentElement, Styled, div, px,
};

use super::{ToolViewCallbacks, status_row::render_status_row, text_block::render_line};

/// Renders a frameless headed block with optional status row header, indented
/// lines, `ViewTailWindow` semantics, and hidden count disclosure.
#[must_use]
pub fn render_headed_block(
	view: &HeadedBlockView,
	tokens: &TokenSet,
	row_budget: Option<usize>,
	callbacks: &ToolViewCallbacks,
) -> Div {
	let mut container = div()
		.flex()
		.flex_col()
		.w_full()
		.min_w_0()
		.gap(tokens.spacing(SpacingStep::S1));

	// 1. Optional Header Row
	if let Some(header) = &view.header {
		container = container.child(render_status_row(header, tokens, callbacks));
	}

	// 2. Line bounds & ViewTailWindow calculation
	let total_lines = view.lines.len();

	let (display_lines, omitted_front, omitted_back) = if let Some(tail) = &view.tail {
		// Tail Window: section displays the END of its lines
		let effective_max = if tail.viewport {
			let host_bound = row_budget.map(|b| b.saturating_sub(tail.reserve.unwrap_or(0)));
			match (tail.max, host_bound) {
				(Some(m), Some(h)) => m.min(h),
				(Some(m), None) => m,
				(None, Some(h)) => h,
				(None, None) => total_lines,
			}
		} else {
			tail.max.unwrap_or(total_lines)
		};

		if total_lines > effective_max {
			let front = total_lines - effective_max;
			(&view.lines[front..], front, 0)
		} else {
			(&view.lines[..], 0, 0)
		}
	} else {
		// Non-tail block: lines are drawn from the front.
		if let Some(budget) = row_budget {
			if total_lines > budget {
				(&view.lines[..budget], 0, total_lines - budget)
			} else {
				(&view.lines[..], 0, 0)
			}
		} else {
			(&view.lines[..], 0, 0)
		}
	};

	// 3. Indented Lines Block
	let mut lines_container = div()
		.flex()
		.flex_col()
		.w_full()
		.min_w_0()
		.pl(tokens.spacing(SpacingStep::S4))
		.gap(tokens.spacing(SpacingStep::S1));

	if omitted_front > 0 {
		let mut front_el = div()
			.py(px(2.0))
			.text_size(tokens.font_size(TextRamp::Micro))
			.text_color(tokens.color(ColorRole::Muted));

		if let Some(on_disclose) = &callbacks.on_disclose {
			let cb = on_disclose.clone();
			front_el = front_el
				.cursor(CursorStyle::PointingHand)
				.hover(|s| s.text_color(tokens.color(ColorRole::Accent)))
				.on_mouse_down(MouseButton::Left, move |_event, window, cx| {
					cb(window, cx);
				});
		}

		lines_container = lines_container.child(
			front_el.child(format!("... ({omitted_front} earlier lines omitted - click to expand)")),
		);
	}

	for line in display_lines {
		lines_container = lines_container.child(render_line(line, tokens, callbacks, false));
	}

	// 4. Back omission or Hidden Count Disclosure Bar
	if omitted_back > 0 {
		let label = if let Some(hidden) = &view.hidden {
			hidden.format_label()
		} else {
			format!("{omitted_back} more lines")
		};
		let revealable = view.hidden.as_ref().is_none_or(|h| h.revealable);
		lines_container =
			lines_container.child(render_disclosure_affordance(&label, revealable, tokens, callbacks));
	} else if let Some(hidden) = &view.hidden {
		lines_container = lines_container.child(render_disclosure_affordance(
			&hidden.format_label(),
			hidden.revealable,
			tokens,
			callbacks,
		));
	}

	container = container.child(lines_container);
	container
}

/// Helper to render disclosure affordance.
fn render_disclosure_affordance(
	label: &str,
	revealable: bool,
	tokens: &TokenSet,
	callbacks: &ToolViewCallbacks,
) -> Div {
	if revealable && callbacks.on_disclose.is_some() {
		let cb = callbacks.on_disclose.clone().unwrap();
		div()
			.flex()
			.flex_row()
			.items_center()
			.gap(tokens.spacing(SpacingStep::S1))
			.mt(tokens.spacing(SpacingStep::S1))
			.px(tokens.spacing(SpacingStep::S2))
			.py(px(2.0))
			.rounded(tokens.radius(RadiusStep::Sm))
			.bg(tokens.color(ColorRole::Inset))
			.cursor(CursorStyle::PointingHand)
			.hover(|s| s.bg(tokens.color(ColorRole::Canvas)))
			.on_mouse_down(MouseButton::Left, move |_event, window, cx| {
				cb(window, cx);
			})
			.child(
				Icon::new(IconName::ChevronRight)
					.size(IconSize::Size12)
					.color(tokens.color(ColorRole::Accent)),
			)
			.child(
				div()
					.text_size(tokens.font_size(TextRamp::Small))
					.text_color(tokens.color(ColorRole::Accent))
					.font_weight(tokens.font_weight(TextWeight::Medium))
					.child(label.to_string()),
			)
	} else {
		div()
			.mt(tokens.spacing(SpacingStep::S1))
			.text_size(tokens.font_size(TextRamp::Micro))
			.text_color(tokens.color(ColorRole::Muted))
			.child(format!("({label})"))
	}
}
