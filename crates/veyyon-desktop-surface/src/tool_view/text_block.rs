//! Native GPUI renderer for `TextBlockView`, `ViewLine`, and `ViewSpan`
//! (§contracts/view).

use veyyon_desktop_kit::{
	ColorRole, Icon, IconName, IconSize, MonoSizeStep, RadiusStep, SpacingStep, TextRamp,
	TextWeight, TokenSet, indicators::badge::Badge,
};
use veyyon_desktop_model::tool_view::{TextBlockView, ViewLine, ViewSpan};
use veyyon_gpui::{
	CursorStyle, Div, InteractiveElement, MouseButton, ParentElement, Styled, div, px,
};

use super::{
	ToolViewCallbacks, ToolViewTarget,
	sanitize::sanitize_control_sequences,
	theme::{
		resolve_emblem_icon, resolve_status_color, resolve_status_icon, resolve_tone_color,
		resolve_tone_tint,
	},
};

/// Renders a single `ViewSpan` into an interactive or styled GPUI element.
#[must_use]
pub fn render_span(span: &ViewSpan, tokens: &TokenSet, callbacks: &ToolViewCallbacks) -> Div {
	// Sanitize control sequences on text
	let raw_text = sanitize_control_sequences(&span.text);

	let tone_color = span
		.tone
		.map_or_else(|| tokens.color(ColorRole::Foreground), |t| resolve_tone_color(t, tokens));

	// 1. Status glyph mark on span
	if let Some(status) = span.status {
		let icon_name = resolve_status_icon(status);
		let color = resolve_status_color(status, tokens);
		return div()
			.flex_shrink_0()
			.flex()
			.flex_row()
			.items_center()
			.mr(tokens.spacing(SpacingStep::S1))
			.child(Icon::new(icon_name).size(IconSize::Size12).color(color));
	}

	// 2. Symbolic glyph mark on span with fallback
	if let Some(symbol) = &span.symbol {
		let clean_sym = sanitize_control_sequences(symbol);
		if let Some(icon_name) = resolve_emblem_icon(&clean_sym) {
			return div()
				.flex_shrink_0()
				.flex()
				.flex_row()
				.items_center()
				.mr(tokens.spacing(SpacingStep::S1))
				.child(
					Icon::new(icon_name)
						.size(IconSize::Size12)
						.color(tone_color),
				);
		}
		// Unknown symbol falls back to span's text
	}

	// 3. Badge presentation
	if span.badge {
		let tint = span
			.tone
			.map_or(veyyon_desktop_kit::TintRole::Working, resolve_tone_tint);
		return div()
			.flex_shrink_0()
			.flex()
			.flex_row()
			.items_center()
			.child(Badge::new(raw_text, tint));
	}

	let mut el = div()
		.text_size(tokens.font_size(TextRamp::Small))
		.line_height(tokens.line_height(TextRamp::Small))
		.text_color(tone_color);

	if span.bold {
		el = el.font_weight(tokens.font_weight(TextWeight::Semibold));
	}

	if span.strike {
		el = el.line_through();
	}

	// Actionable targets (Link or File)
	let target = if let Some(link) = &span.link {
		let clean_link = sanitize_control_sequences(link);
		Some(ToolViewTarget::Url(clean_link))
	} else {
		span.file.as_ref().map(|path| {
			let clean_path = sanitize_control_sequences(path);
			ToolViewTarget::File { path: clean_path, line: span.file_line }
		})
	};

	if let Some(tgt) = target
		&& let Some(on_target) = &callbacks.on_target
	{
		let cb = on_target.clone();
		el = el
			.cursor(CursorStyle::PointingHand)
			.hover(|s| s.underline())
			.on_mouse_down(MouseButton::Left, move |_event, window, cx| {
				cb(tgt.clone(), window, cx);
			});
	}

	// Inline markdown handling if requested on span
	if span.markdown && (raw_text.contains('`') || raw_text.contains("**") || raw_text.contains('*'))
	{
		let parsed_elements = render_inline_markdown(&raw_text, tone_color, tokens);
		for child_el in parsed_elements {
			el = el.child(child_el);
		}
	} else {
		el = el.child(raw_text);
	}

	el
}

/// Parses simple inline markdown emphasis and inline code blocks within a
/// single line.
fn render_inline_markdown(
	text: &str,
	base_color: veyyon_gpui::Hsla,
	tokens: &TokenSet,
) -> Vec<Div> {
	let mut out = Vec::new();
	let mut current = String::new();
	let chars: Vec<char> = text.chars().collect();
	let mut i = 0;

	while i < chars.len() {
		if chars[i] == '`' {
			// Flush current
			if !current.is_empty() {
				out.push(
					div()
						.text_color(base_color)
						.child(std::mem::take(&mut current)),
				);
			}
			i += 1;
			let mut code_str = String::new();
			while i < chars.len() && chars[i] != '`' {
				code_str.push(chars[i]);
				i += 1;
			}
			if i < chars.len() && chars[i] == '`' {
				i += 1;
			}
			out.push(
				div()
					.px(tokens.spacing(SpacingStep::S1))
					.bg(tokens.color(ColorRole::Inset))
					.rounded(tokens.radius(RadiusStep::Sm))
					.text_size(tokens.mono_font_size(MonoSizeStep::Small))
					.text_color(tokens.color(ColorRole::Secondary))
					.child(code_str),
			);
		} else if i + 1 < chars.len() && chars[i] == '*' && chars[i + 1] == '*' {
			if !current.is_empty() {
				out.push(
					div()
						.text_color(base_color)
						.child(std::mem::take(&mut current)),
				);
			}
			i += 2;
			let mut bold_str = String::new();
			while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '*') {
				bold_str.push(chars[i]);
				i += 1;
			}
			if i + 1 < chars.len() && chars[i] == '*' && chars[i + 1] == '*' {
				i += 2;
			}
			out.push(
				div()
					.text_color(base_color)
					.font_weight(tokens.font_weight(TextWeight::Semibold))
					.child(bold_str),
			);
		} else {
			current.push(chars[i]);
			i += 1;
		}
	}

	if !current.is_empty() {
		out.push(div().text_color(base_color).child(current));
	}

	out
}

/// Renders a single `ViewLine` (vector of `ViewSpan`) with support for clipping
/// and trailing metadata.
#[must_use]
pub fn render_line(
	line: &[ViewSpan],
	tokens: &TokenSet,
	callbacks: &ToolViewCallbacks,
	clip: bool,
) -> Div {
	let mut main_line = div()
		.flex()
		.flex_row()
		.items_center()
		.w_full()
		.min_w_0()
		.gap(tokens.spacing(SpacingStep::S1));

	if clip {
		main_line = main_line.overflow_hidden().whitespace_nowrap().truncate();
	} else {
		main_line = main_line.flex_wrap();
	}

	let mut trailing_spans = Vec::new();
	let mut in_trailing = false;

	for span in line {
		if span.trailing {
			in_trailing = true;
		}
		if in_trailing {
			trailing_spans.push(span);
		} else {
			main_line = main_line.child(render_span(span, tokens, callbacks));
		}
	}

	if !trailing_spans.is_empty() {
		let mut trailing_box = div()
			.flex()
			.flex_row()
			.items_center()
			.gap(tokens.spacing(SpacingStep::S1))
			.ml_auto()
			.flex_shrink_0();

		for span in trailing_spans {
			trailing_box = trailing_box.child(render_span(span, tokens, callbacks));
		}

		main_line = main_line.child(trailing_box);
	}

	main_line
}

/// Renders a `TextBlockView` into a block of styled lines with disclosure on
/// bounds.
#[must_use]
pub fn render_text_block(
	view: &TextBlockView,
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

	// Convert spans with internal newlines into discrete ViewLines
	let mut lines: Vec<ViewLine> = Vec::new();
	let mut current_line: ViewLine = Vec::new();

	for span in &view.spans {
		if span.text.contains('\n') {
			let parts: Vec<&str> = span.text.split('\n').collect();
			for (idx, part) in parts.iter().enumerate() {
				if !part.is_empty() || idx > 0 {
					let mut sub_span = span.clone();
					sub_span.text = (*part).to_string();
					current_line.push(sub_span);
				}
				if idx + 1 < parts.len() {
					lines.push(std::mem::take(&mut current_line));
				}
			}
		} else {
			current_line.push(span.clone());
		}
	}
	if !current_line.is_empty() {
		lines.push(current_line);
	}

	let line_count = lines.len();
	let max_lines = row_budget.unwrap_or(line_count);
	let (display_lines, omitted) = if line_count > max_lines {
		(&lines[..max_lines], line_count - max_lines)
	} else {
		(&lines[..], 0)
	};

	for line in display_lines {
		container = container.child(render_line(line, tokens, callbacks, false));
	}

	if omitted > 0 {
		let label = format!("{omitted} more lines");
		if let Some(on_disclose) = &callbacks.on_disclose {
			let cb = on_disclose.clone();
			container = container.child(
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
							.child(label),
					),
			);
		} else {
			container = container.child(
				div()
					.text_size(tokens.font_size(TextRamp::Micro))
					.text_color(tokens.color(ColorRole::Muted))
					.child(format!("... ({label} omitted)")),
			);
		}
	}

	container
}
