//! Syntax-highlighted file contents view (§5.6, §5.11).
//!
//! The rows and the columns the pane draws are the ones its own box shows, so
//! a file wider or taller than the panel costs what the panel draws rather
//! than what the file holds. `pane_window` states why.

use syntect::{
	easy::HighlightLines,
	highlighting::{Style, ThemeSet},
	parsing::SyntaxSet,
};
use veyyon_desktop_kit::{ColorRole, SpacingStep, TextRamp, TextWeight, TokenSet, mono_advance};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	Context, Div, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
	Styled, Window, div, px,
};

use crate::{
	ShellView,
	right_panel::{
		content::{FileLine, FileView, HighlightSpan},
		diff_rows::gutter_cell,
		mono_pane::{PaneParts, pane_cell, pane_content_px, pinned_gutter_pane},
		pane_scroll::{PaneId, PaneScrolls},
		pane_window::{ColumnWindow, RowWalk, scrolled, text_columns, visible_pieces},
	},
};

/// Renders the File view tenant in the right panel.
pub fn file_view(
	file: &Option<FileView>,
	panes: &PaneScrolls,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	window: &mut Window,
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

	let rows = panes.handle(PaneId::FileRows);
	let code_columns = panes.handle(PaneId::FileColumns);
	let mut container = div()
		.id("right-panel-file-view")
		.track_scroll(&rows)
		.flex_1()
		.w_full()
		.flex()
		.flex_col()
		.overflow_y_scroll();
	container = container.child(path_header(file_data, geometry, tokens));

	if file_data.binary {
		return container.child(notice_row("Binary file cannot be displayed", geometry, tokens));
	}

	// The header is inside the scrolled content, so the rows begin that far
	// down it and the cursor starts there.
	let mut walk = RowWalk::of(&scrolled(&rows, window));
	walk.advance(geometry.chrome_row_height_px);
	let advance_px = mono_advance(window, tokens, &geometry.diff_font_size);
	let visible = ColumnWindow::of(&scrolled(&code_columns, window), advance_px);

	let mut gutter = div();
	let mut code = div();
	for line in &file_data.lines {
		if !walk.admit(geometry.diff_row_height_px) {
			continue;
		}
		gutter = gutter.child(pane_cell(geometry).child(gutter_cell(
			&format!("{:>4}", line.line_number),
			geometry,
			tokens,
		)));
		code = code.child(line_cell(line, visible, advance_px, geometry, tokens));
	}

	container = container.child(
		pinned_gutter_pane(
			PaneParts {
				id: "right-panel-file-code".into(),
				columns: &code_columns,
				gutter,
				code,
				content_width_px: pane_content_px(window, tokens, geometry, widest_line(file_data)),
				padding: walk.take_padding(),
			},
			geometry,
			tokens,
		)
		.w_full()
		.flex_shrink_0(),
	);

	if file_data.truncated {
		container =
			container.child(notice_row("File truncated due to size limits", geometry, tokens));
	}

	container
}

/// The row that states which file is open and how long it is.
fn path_header(file: &FileView, geometry: &PanelsSurfaceTokens, tokens: &TokenSet) -> Div {
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
				.child(file.path.clone()),
		)
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.child(format!("{} lines", file.lines.len())),
		)
}

/// A row that carries a message instead of a line of the file.
fn notice_row(message: &str, geometry: &PanelsSurfaceTokens, tokens: &TokenSet) -> Div {
	div()
		.h(px(geometry.diff_row_height_px))
		.w_full()
		.flex_shrink_0()
		.flex()
		.items_center()
		.px(tokens.spacing(SpacingStep::S3))
		.text_size(tokens.font_size(TextRamp::Micro))
		.text_color(tokens.color(ColorRole::Muted))
		.child(message.to_owned())
}

/// One line's cell, holding the pieces of it the pane's columns reach.
///
/// The pieces are placed by a box of the cells dropped before them rather than
/// at the cell they start at, so the text stands under the same column of the
/// pane it would have if the whole line were drawn.
fn line_cell(
	line: &FileLine,
	visible: ColumnWindow,
	advance_px: f32,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
) -> Div {
	let (lead_cells, pieces) = visible_pieces(&line.spans, visible);
	let mut cell = pane_cell(geometry);
	if lead_cells > 0 {
		cell = cell.child(div().w(px(lead_cells as f32 * advance_px)).flex_shrink_0());
	}
	for piece in pieces {
		cell = cell.child(
			div()
				.flex_shrink_0()
				.text_color(tokens.color(piece.role))
				.child(piece.text.to_owned()),
		);
	}
	cell
}

/// The widest line of the file, in monospace cells.
///
/// A line's spans are one line's pieces, so its width is their sum: the widest
/// piece is not the widest line. Measured over the whole file rather than over
/// the rows on screen, because a content width that changed as the pane
/// scrolled would move the scroll extent under the gesture reading it.
fn widest_line(file: &FileView) -> usize {
	file
		.lines
		.iter()
		.map(|line| {
			line
				.spans
				.iter()
				.map(|span| text_columns(&span.text))
				.sum::<usize>()
		})
		.max()
		.unwrap_or(0)
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
