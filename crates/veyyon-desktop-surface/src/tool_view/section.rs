//! Native GPUI renderer for `ViewSection` (§contracts/view).

use veyyon_desktop_kit::{
	ColorRole, SpacingStep, TextRamp, TextWeight, TokenSet, text::markdown::Markdown,
};
use veyyon_desktop_model::tool_view::{ViewLine, ViewSection};
use veyyon_gpui::{
	CursorStyle, Div, InteractiveElement, MouseButton, ParentElement, Styled, div, px,
};

use super::{
	ToolViewCallbacks, code::render_code_lines, diff::render_diff_lines,
	disclosure::render_disclosure, fit::FitsTheRow, sanitize::sanitize_control_sequences,
	text_block::render_line, tree::render_tree_lines,
};

/// Renders a single `ViewSection` adhering to canonical structural precedence
/// (Diff > Code > Markdown > Tree > List > Prose) and `ViewTailWindow`
/// semantics.
#[must_use]
pub fn render_section(
	section: &ViewSection,
	tokens: &TokenSet,
	row_budget: Option<usize>,
	callbacks: &ToolViewCallbacks,
	is_first: bool,
) -> Div {
	let mut container = div().flex().flex_col().w_full().min_w_0();

	// 1. Separator hairline if requested and not the first section
	if section.separator && !is_first {
		container = container
			.pt(tokens.spacing(SpacingStep::S2))
			.border_t_1()
			.border_color(tokens.color(ColorRole::Hairline))
			.mt(tokens.spacing(SpacingStep::S2));
	} else if !is_first {
		container = container.mt(tokens.spacing(SpacingStep::S2));
	}

	// 2. Section Label with sanitization
	if let Some(label) = &section.label {
		let clean_label = sanitize_control_sequences(label);
		container = container.child(
			div()
				.fit_primary()
				.mb(tokens.spacing(SpacingStep::S1))
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(clean_label),
		);
	}

	// 3. Line bounds & ViewTailWindow calculation
	let total_lines = section.lines.len();

	let (display_lines, start_idx, omitted_front, omitted_back) = if let Some(tail) = &section.tail {
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
			(&section.lines[front..], front, front, 0)
		} else {
			(&section.lines[..], 0, 0, 0)
		}
	} else {
		// Non-tail section: lines are the whole section.
		// If constrained by host row budget, show front lines and omit back lines with
		// disclosure.
		if let Some(budget) = row_budget {
			if total_lines > budget {
				(&section.lines[..budget], 0, 0, total_lines - budget)
			} else {
				(&section.lines[..], 0, 0, 0)
			}
		} else {
			(&section.lines[..], 0, 0, 0)
		}
	};

	// 4. Front omission notice for Tail Windows (clickable to expand if callback
	//    registered)
	if omitted_front > 0 {
		// No width role: this states a count in text this renderer authors,
		// not host text, so it cannot outgrow the row it sits alone on.
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

		container = container.child(
			front_el.child(format!("... ({omitted_front} earlier lines omitted - click to expand)")),
		);
	}

	// 5. Render Body by Precedence: Diff > Code > Markdown > Tree > List > Prose
	let body_el = if let Some(diff) = &section.diff {
		render_diff_lines(display_lines, diff, start_idx, tokens, callbacks)
	} else if let Some(code) = &section.code {
		render_code_lines(display_lines, code, start_idx, tokens, callbacks)
	} else if section.markdown {
		render_markdown_section(display_lines, tokens)
	} else if let Some(tree) = &section.tree {
		render_tree_lines(display_lines, tree, start_idx, tokens, callbacks)
	} else if section.list {
		render_list_lines(display_lines, section.clip, tokens, callbacks)
	} else {
		render_prose_lines(display_lines, section.clip, tokens, callbacks)
	};

	container = container.child(body_el);

	// 6. Back omission or Hidden Count Disclosure Bar
	if omitted_back > 0 {
		let label = if let Some(hidden) = &section.hidden {
			hidden.format_label()
		} else {
			format!("{omitted_back} more lines")
		};
		let revealable = section.hidden.as_ref().is_none_or(|h| h.revealable);
		container = container.child(render_disclosure(&label, revealable, tokens, callbacks));
	} else if let Some(hidden) = &section.hidden {
		container = container.child(render_disclosure(
			&hidden.format_label(),
			hidden.revealable,
			tokens,
			callbacks,
		));
	}

	container
}

/// Renders a Markdown document section.
///
/// `render_section` dispatches this before every arm that reads
/// `ViewSection::clip`, so a markdown section is a document that wraps
/// whatever the host asked for its lines.
///
/// Nothing here bounds it, and nothing needs to. Every ancestor between this
/// and the card is a flex column, which stretches its children across, so the
/// document is handed the card's width whether or not it asks for one; the
/// text system then breaks a run mid-word when the run has no break
/// opportunity of its own. A `w_full` or an `overflow_hidden` added here would
/// change no pixel — the containment suite's mutation gate says so — and would
/// read as the thing that holds the document in.
fn render_markdown_section(lines: &[ViewLine], _tokens: &TokenSet) -> Div {
	let mut source = String::new();
	for (idx, line) in lines.iter().enumerate() {
		for span in line {
			let clean = sanitize_control_sequences(&span.text);
			source.push_str(&clean);
		}
		if idx + 1 < lines.len() {
			source.push('\n');
		}
	}

	div().child(Markdown::new(source))
}

/// Renders list lines with bullet indicators.
fn render_list_lines(
	lines: &[ViewLine],
	clip: bool,
	tokens: &TokenSet,
	callbacks: &ToolViewCallbacks,
) -> Div {
	let mut container = div()
		.flex()
		.flex_col()
		.w_full()
		.gap(tokens.spacing(SpacingStep::S1));

	for line in lines {
		let row = div()
			.flex()
			.flex_row()
			.items_center()
			.w_full()
			.gap(tokens.spacing(SpacingStep::S2))
			.child(
				div()
					.flex_shrink_0()
					.text_size(tokens.font_size(TextRamp::Small))
					.text_color(tokens.color(ColorRole::Muted))
					.child("•"),
			)
			.child(
				div()
					.flex_1()
					.min_w_0()
					.child(render_line(line, tokens, callbacks, clip)),
			);
		container = container.child(row);
	}

	container
}

/// Renders standard prose lines.
fn render_prose_lines(
	lines: &[ViewLine],
	clip: bool,
	tokens: &TokenSet,
	callbacks: &ToolViewCallbacks,
) -> Div {
	let mut container = div()
		.flex()
		.flex_col()
		.w_full()
		.gap(tokens.spacing(SpacingStep::S1));
	for line in lines {
		container = container.child(render_line(line, tokens, callbacks, clip));
	}
	container
}
