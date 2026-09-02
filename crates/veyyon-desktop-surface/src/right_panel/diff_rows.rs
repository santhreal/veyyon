//! Rendering of individual diff rows and hunk headers (§5.11).

use std::ops::Range;

use veyyon_desktop_kit::{
	ColorRole, RadiusStep, SpacingStep, TextRamp, TextWeight, TintRole, TokenSet,
};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	Context, Div, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
	Styled, div, px,
};

use crate::{ShellView, intent::Intent, right_panel::content::DiffRow};

/// Renders a single diff row in unified view mode.
pub fn render_unified_row(
	file_index: usize,
	row_index: usize,
	row: &DiffRow,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	match row {
		DiffRow::HunkHeader { old_start, old_count, new_start, new_count, symbol } => {
			render_hunk_header(
				*old_start, *old_count, *new_start, *new_count, symbol, geometry, tokens,
			)
		},
		DiffRow::Context { old_line: _, new_line, text } => {
			let line_no = format!("{new_line:>4}");
			div()
				.h(px(geometry.diff_row_height_px))
				.w_full()
				.flex_shrink_0()
				.flex()
				.flex_row()
				.items_center()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(px(geometry.diff_row_height_px))
				.font_family("mono")
				.child(gutter_cell(&line_no, geometry, tokens))
				.child(sign_cell(" ", geometry, tokens, ColorRole::Secondary))
				.child(content_cell(text, &[], tokens, None))
		},
		DiffRow::Added { new_line, text, intraline } => {
			let line_no = format!("{new_line:>4}");
			let mut row_bg = tokens.tint(TintRole::Done).fill;
			row_bg.a = geometry.diff_added_removed_alpha;
			let mut hl_bg = tokens.tint(TintRole::Done).fill;
			hl_bg.a = geometry.diff_intraline_alpha;

			div()
				.h(px(geometry.diff_row_height_px))
				.w_full()
				.flex_shrink_0()
				.flex()
				.flex_row()
				.items_center()
				.bg(row_bg)
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(px(geometry.diff_row_height_px))
				.font_family("mono")
				.child(gutter_cell(&line_no, geometry, tokens))
				.child(sign_cell("+", geometry, tokens, ColorRole::Foreground))
				.child(content_cell(text, intraline, tokens, Some(hl_bg)))
		},
		DiffRow::Removed { old_line, text, intraline } => {
			let line_no = format!("{old_line:>4}");
			let mut row_bg = tokens.tint(TintRole::Error).fill;
			row_bg.a = geometry.diff_added_removed_alpha;
			let mut hl_bg = tokens.tint(TintRole::Error).fill;
			hl_bg.a = geometry.diff_intraline_alpha;

			div()
				.h(px(geometry.diff_row_height_px))
				.w_full()
				.flex_shrink_0()
				.flex()
				.flex_row()
				.items_center()
				.bg(row_bg)
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(px(geometry.diff_row_height_px))
				.font_family("mono")
				.child(gutter_cell(&line_no, geometry, tokens))
				.child(sign_cell("-", geometry, tokens, ColorRole::Foreground))
				.child(content_cell(text, intraline, tokens, Some(hl_bg)))
		},
		DiffRow::Collapsed { hidden, .. } => {
			div().child(render_collapsed_row(file_index, row_index, *hidden, geometry, tokens, cx))
		},
		DiffRow::Binary { message } => render_notice_row(message, geometry, tokens),
		DiffRow::Unavailable { reason } => render_notice_row(reason, geometry, tokens),
		DiffRow::Truncated { remaining } => {
			let msg = format!("2,000 changed lines cap reached ({remaining} more lines not shown)");
			render_notice_row(&msg, geometry, tokens)
		},
	}
}

/// Renders a hunk header boundary bar (§5.11).
pub fn render_hunk_header(
	old_start: usize,
	old_count: usize,
	new_start: usize,
	new_count: usize,
	symbol: &Option<String>,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
) -> Div {
	let range_text = format!("@@ -{old_start},{old_count} +{new_start},{new_count} @@");
	let mut el = div()
		.h(px(geometry.diff_hunk_header_height_px))
		.w_full()
		.flex_shrink_0()
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.px(tokens.spacing(SpacingStep::S3))
		.bg(tokens.color(ColorRole::Inset))
		.text_size(tokens.font_size(TextRamp::Micro))
		.line_height(px(geometry.diff_hunk_header_height_px))
		.font_weight(tokens.font_weight(TextWeight::Medium))
		.text_color(tokens.color(ColorRole::Secondary))
		.font_family("mono")
		.child(range_text);

	if let Some(sym) = symbol {
		el = el.child(
			div()
				.text_color(tokens.color(ColorRole::Foreground))
				.truncate()
				.child(sym.clone()),
		);
	}

	el
}

/// Renders a gutter cell containing a line number.
pub fn gutter_cell(text: &str, geometry: &PanelsSurfaceTokens, tokens: &TokenSet) -> Div {
	div()
		.w(px(geometry.diff_gutter_width_px))
		.flex_shrink_0()
		.text_align(veyyon_gpui::TextAlign::Right)
		.pr(tokens.spacing(SpacingStep::S2))
		.text_color(tokens.color(ColorRole::Secondary))
		.child(text.to_string())
}

/// Renders a sign cell (+, -, or space).
pub fn sign_cell(
	sign: &str,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	color: ColorRole,
) -> Div {
	div()
		.w(px(geometry.diff_sign_width_px))
		.flex_shrink_0()
		.text_align(veyyon_gpui::TextAlign::Center)
		.text_color(tokens.color(color))
		.child(sign.to_string())
}

/// Renders line content with intraline highlight spans.
pub fn content_cell(
	text: &str,
	intraline: &[Range<usize>],
	tokens: &TokenSet,
	highlight_bg: Option<veyyon_gpui::Hsla>,
) -> Div {
	let mut container = div()
		.flex_1()
		.min_w_0()
		.flex()
		.flex_row()
		.items_center()
		.overflow_hidden()
		.whitespace_nowrap()
		.text_color(tokens.color(ColorRole::Foreground));

	if intraline.is_empty() || highlight_bg.is_none() {
		return container.child(text.to_string());
	}

	let hl = highlight_bg.expect("checked above");
	let mut cursor = 0;

	for span in intraline {
		if span.start > cursor && span.start <= text.len() {
			container = container.child(text[cursor..span.start].to_string());
		}
		if span.end <= text.len() && span.start < span.end {
			container = container.child(
				div()
					.bg(hl)
					.rounded(tokens.radius(RadiusStep::Xs))
					.child(text[span.start..span.end].to_string()),
			);
			cursor = span.end;
		}
	}

	if cursor < text.len() {
		container = container.child(text[cursor..].to_string());
	}

	container
}

/// Renders a collapsed context region offering in-place expansion.
pub fn render_collapsed_row(
	file_index: usize,
	row_index: usize,
	hidden: usize,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	div()
		.id(veyyon_gpui::ElementId::Name(format!("collapsed-row-{file_index}-{row_index}").into()))
		.on_click(cx.listener(move |view, _event, _window, cx| {
			view.dispatch(Intent::ExpandContext { file: file_index, row: row_index });
			cx.notify();
		}))
		.h(px(geometry.diff_row_height_px))
		.w_full()
		.flex_shrink_0()
		.flex()
		.flex_row()
		.items_center()
		.justify_center()
		.bg(tokens.color(ColorRole::Inset))
		.hover(|s| s.bg(tokens.row_hover()))
		.text_size(tokens.font_size(TextRamp::Micro))
		.text_color(tokens.color(ColorRole::Secondary))
		.child(format!("Expand {hidden} lines"))
}

/// Renders a notice row for binary/unavailable files or truncation.
pub fn render_notice_row(message: &str, geometry: &PanelsSurfaceTokens, tokens: &TokenSet) -> Div {
	div()
		.h(px(geometry.diff_row_height_px))
		.w_full()
		.flex_shrink_0()
		.flex()
		.flex_row()
		.items_center()
		.px(tokens.spacing(SpacingStep::S3))
		.text_size(tokens.font_size(TextRamp::Micro))
		.text_color(tokens.color(ColorRole::Muted))
		.child(message.to_string())
}
