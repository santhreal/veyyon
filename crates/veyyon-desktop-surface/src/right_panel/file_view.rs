//! Syntax-highlighted file contents view (§5.6, §5.11).

use syntect::{
	easy::HighlightLines,
	highlighting::{Style, ThemeSet},
	parsing::SyntaxSet,
};
use veyyon_desktop_kit::{ColorRole, SpacingStep, TextRamp, TextWeight, TokenSet};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	Context, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement, Styled,
	div, px,
};

use crate::{
	ShellView,
	right_panel::{
		content::{FileLine, FileView, HighlightSpan},
		diff_rows::gutter_cell,
	},
};

/// Renders the File view tenant in the right panel.
pub fn file_view(
	file: &Option<FileView>,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	_cx: &Context<ShellView>,
) -> impl IntoElement {
	let Some(file_data) = file else {
		return div()
			.id("right-panel-file-empty")
			.flex_1()
			.w_full()
			.flex()
			.items_center()
			.justify_center()
			.text_size(tokens.font_size(TextRamp::Small))
			.text_color(tokens.color(ColorRole::Muted))
			.child("No file open");
	};

	let mut container = div()
		.id("right-panel-file-view")
		.flex_1()
		.w_full()
		.flex()
		.flex_col()
		.overflow_y_scroll();
	// File path header
	container = container.child(
		div()
			.h(px(geometry.chrome_row_height_px))
			.w_full()
			.flex_shrink_0()
			.flex()
			.flex_row()
			.items_center()
			.justify_between()
			.px(tokens.spacing(SpacingStep::S3))
			.bg(tokens.color(ColorRole::Inset))
			.border_b(px(geometry.chrome_resize_handle_line_px))
			.border_color(tokens.color(ColorRole::Hairline))
			.child(
				div()
					.text_size(tokens.font_size(TextRamp::Micro))
					.font_weight(tokens.font_weight(TextWeight::Medium))
					.text_color(tokens.color(ColorRole::Foreground))
					.truncate()
					.child(file_data.path.clone()),
			)
			.child(
				div()
					.text_size(tokens.font_size(TextRamp::Micro))
					.text_color(tokens.color(ColorRole::Muted))
					.child(format!("{} lines", file_data.lines.len())),
			),
	);

	if file_data.binary {
		return container.child(
			div()
				.h(px(geometry.diff_row_height_px))
				.w_full()
				.flex_shrink_0()
				.flex()
				.items_center()
				.px(tokens.spacing(SpacingStep::S3))
				.text_size(tokens.font_size(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child("Binary file cannot be displayed"),
		);
	}

	for line in &file_data.lines {
		let line_no = format!("{:>4}", line.line_number);
		let mut row = div()
			.h(px(geometry.diff_row_height_px))
			.w_full()
			.flex_shrink_0()
			.flex()
			.flex_row()
			.items_center()
			.text_size(tokens.font_size(TextRamp::Micro))
			.line_height(px(geometry.diff_row_height_px))
			.font_family(tokens.mono_family())
			.child(gutter_cell(&line_no, geometry, tokens));

		let mut content_line = div()
			.flex_1()
			.min_w_0()
			.flex()
			.flex_row()
			.items_center()
			.overflow_hidden()
			.whitespace_nowrap();

		for span in &line.spans {
			content_line = content_line.child(
				div()
					.text_color(tokens.color(span.role))
					.child(span.text.clone()),
			);
		}

		row = row.child(content_line);
		container = container.child(row);
	}

	if file_data.truncated {
		container = container.child(
			div()
				.h(px(geometry.diff_row_height_px))
				.w_full()
				.flex_shrink_0()
				.flex()
				.items_center()
				.px(tokens.spacing(SpacingStep::S3))
				.text_size(tokens.font_size(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child("File truncated due to size limits"),
		);
	}

	container
}

/// Highlights source text using syntect, mapping style scopes onto
/// `ColorRole`s.
#[must_use]
pub fn highlight_source(path: &str, content: &str, truncated: bool, binary: bool) -> FileView {
	if binary {
		return FileView { path: path.to_string(), lines: Vec::new(), truncated, binary: true };
	}

	let ps = SyntaxSet::load_defaults_newlines();
	let ts = ThemeSet::load_defaults();
	let syntax = ps
		.find_syntax_for_file(path)
		.ok()
		.flatten()
		.unwrap_or_else(|| ps.find_syntax_plain_text());
	let theme = &ts.themes["base16-ocean.dark"];
	let mut h = HighlightLines::new(syntax, theme);

	let mut lines = Vec::new();
	for (line_idx, line) in content.lines().enumerate() {
		let ranges: Result<Vec<(Style, &str)>, _> = h.highlight_line(line, &ps);
		let spans = match ranges {
			Ok(r) => r
				.into_iter()
				.map(|(style, text)| HighlightSpan {
					text: text.to_string(),
					role: map_style_to_role(style),
				})
				.collect(),
			Err(_) => vec![HighlightSpan { text: line.to_string(), role: ColorRole::Foreground }],
		};

		lines.push(FileLine { line_number: line_idx + 1, spans });
	}

	FileView { path: path.to_string(), lines, truncated, binary: false }
}

const fn map_style_to_role(style: Style) -> ColorRole {
	// Syntect colors mapped to token roles
	let (r, g, b) = (style.foreground.r, style.foreground.g, style.foreground.b);
	if r > 180 && g < 150 && b < 150 {
		ColorRole::Accent
	} else if r < 140 && g < 140 && b < 140 {
		ColorRole::Muted
	} else if g > 160 && r < 160 {
		ColorRole::Secondary
	} else {
		ColorRole::Foreground
	}
}
