//! The columns a diff pane pins and the column it scrolls (§5.11).
//!
//! A diff row is a line number, a sign and a line of text, and §5.11 pins the
//! first two while the third scrolls. A row laid out as one flex row cannot do
//! that: the row is one box, so either all of it travels under the wheel or
//! none of it does, and a diff of a generated file was unreadable past the
//! panel's edge because none of it did.
//!
//! The rows are therefore built as two parallel columns of cells, one pinned
//! and one scrolled, with one cell per row on each side at the same authored
//! height, so a row still reads across the seam.
//!
//! A row that spans the pane rather than sitting in the columns — a hunk
//! header, a collapsed region, a notice — draws its ground in the pinned column
//! and its text in the scrolled one, so its bar is continuous across the seam
//! and the two columns stay in step further down the file.

use std::ops::Range;

use veyyon_desktop_kit::{ColorRole, TintRole, TokenSet};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	Context, Div, ElementId, Hsla, InteractiveElement, MouseButton, MouseDownEvent, ParentElement,
	ScrollHandle, Styled, Window, div, px,
};

use crate::{
	ShellView,
	detail::{Detail, DetailKind},
	right_panel::{
		content::{DiffFile, DiffRow},
		diff_extent::{row_height, unified_file_columns},
		diff_rows::{
			content_cell, gutter_cell, render_collapsed_row, render_hunk_header, render_notice_row,
			sign_cell, truncated_notice,
		},
		mono_pane::{PaneParts, pane_cell, pane_content_px, pinned_gutter_pane},
		pane_window::RowWalk,
	},
};

/// One pane's two columns: the cells of the rows it drew, and how wide its
/// widest row is in monospace cells.
///
/// The width is the file's rather than the drawn rows', because the rows drawn
/// are the rows the pane's box shows: a content width taken from those would
/// move the scroll extent every time the wheel changed which rows they are.
pub struct PaneColumns {
	pinned:  Vec<Div>,
	code:    Vec<Div>,
	columns: usize,
}

impl PaneColumns {
	pub(super) const fn new(columns: usize) -> Self {
		Self { pinned: Vec::new(), code: Vec::new(), columns }
	}

	/// Adds one row: the cell the pane pins and the cell it scrolls.
	pub(super) fn push(&mut self, pinned: Div, code: Div) {
		self.pinned.push(pinned);
		self.code.push(code);
	}

	/// Composes the columns into the pane that pins one and scrolls the other,
	/// with `padding` standing in for the rows outside its box.
	///
	/// `id` and `columns` carry the file and the side: two panes sharing either
	/// would share one offset, and one file's diff would scroll another's.
	pub fn into_pane(
		self,
		id: impl Into<ElementId>,
		columns: &ScrollHandle,
		padding: (f32, f32),
		window: &mut Window,
		geometry: &PanelsSurfaceTokens,
		tokens: &TokenSet,
	) -> Div {
		let content_width_px = pane_content_px(window, tokens, geometry, self.columns);
		pinned_gutter_pane(
			PaneParts {
				id: id.into(),
				columns,
				gutter: div().children(self.pinned),
				code: div().children(self.code),
				content_width_px,
				padding,
			},
			geometry,
			tokens,
		)
	}
}

/// One line of a diff, as both columns draw it.
pub(super) struct Line<'a> {
	/// The line number, or `None` for the blank side of a split pair.
	pub(super) number:    Option<usize>,
	pub(super) sign:      &'a str,
	pub(super) sign_role: ColorRole,
	pub(super) text:      &'a str,
	pub(super) intraline: &'a [Range<usize>],
	/// The row's tint, or `None` for a context line, which carries no ground.
	pub(super) tint:      Option<TintRole>,
}

impl Line<'_> {
	pub(super) const fn context(number: usize, text: &str) -> Line<'_> {
		Line {
			number: Some(number),
			sign: " ",
			sign_role: ColorRole::Secondary,
			text,
			intraline: &[],
			tint: None,
		}
	}

	pub(super) const fn blank() -> Line<'static> {
		Line {
			number:    None,
			sign:      " ",
			sign_role: ColorRole::Secondary,
			text:      "",
			intraline: &[],
			tint:      None,
		}
	}
}

/// The ground and the intraline highlight a tint resolves to at the alphas the
/// panel authors for them.
fn tint_fills(
	tint: Option<TintRole>,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
) -> (Option<Hsla>, Option<Hsla>) {
	let Some(role) = tint else {
		return (None, None);
	};
	let mut ground = tokens.tint(role).fill;
	ground.a = geometry.diff_added_removed_alpha;
	let mut highlight = tokens.tint(role).fill;
	highlight.a = geometry.diff_intraline_alpha;
	(Some(ground), Some(highlight))
}

/// One line's pinned cell, scrolled cell and width in cells.
pub(super) fn line_cells(
	line: &Line<'_>,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
) -> (Div, Div) {
	let (ground, highlight) = tint_fills(line.tint, geometry, tokens);
	let number = line
		.number
		.map_or_else(|| "    ".to_owned(), |number| format!("{number:>4}"));

	let mut pinned = pane_cell(geometry)
		.flex_row()
		.child(gutter_cell(&number, geometry, tokens))
		.child(sign_cell(line.sign, geometry, tokens, line.sign_role));
	let mut code = pane_cell(geometry).flex_row().child(content_cell(
		line.text,
		line.intraline,
		tokens,
		highlight,
	));

	if let Some(fill) = ground {
		pinned = pinned.bg(fill);
		code = code.bg(fill);
	}

	(pinned, code)
}

/// A row that spans the pane: its ground in the pinned column, its content in
/// the scrolled one.
pub(super) fn span_cells(height_px: f32, ground: Option<Hsla>, code: Div) -> (Div, Div) {
	let mut bar = div().h(px(height_px)).flex_shrink_0();
	if let Some(fill) = ground {
		bar = bar.bg(fill);
	}
	(bar, code)
}

/// Whether this row spans the pane, and the cells it draws if it does.
pub(super) fn spanning_cells(
	file_index: usize,
	path: &str,
	row_index: usize,
	row: &DiffRow,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Option<(Div, Div)> {
	let inset = Some(tokens.color(ColorRole::Inset));
	match row {
		DiffRow::HunkHeader { old_start, old_count, new_start, new_count, symbol } => {
			let header = render_hunk_header(
				*old_start, *old_count, *new_start, *new_count, symbol, geometry, tokens,
			);
			// Every file's rows scroll in one region, so a hunk's own file
			// header is usually above the box by the time the hunk is on
			// screen, and the symbol it states is cut at the pane's width. A
			// secondary press states the file, the lines the hunk covers on
			// each side, what it changed, and the symbol whole (§8.25).
			let opened = path.to_owned();
			let header = header.on_mouse_down(
				MouseButton::Right,
				cx.listener(move |view, event: &MouseDownEvent, window, cx| {
					let kind = DetailKind::DiffHunk { path: opened.clone(), row: row_index };
					view.toggle_detail(Detail::below(kind, event.position), window, cx);
					cx.notify();
				}),
			);
			Some(span_cells(geometry.diff_hunk_header_height_px, inset, header))
		},
		DiffRow::Collapsed { hidden, .. } => {
			let row = div()
				.w_full()
				.flex_shrink_0()
				.child(render_collapsed_row(file_index, row_index, *hidden, geometry, tokens, cx));
			Some(span_cells(geometry.diff_row_height_px, inset, row))
		},
		DiffRow::Binary { message } | DiffRow::Unavailable { reason: message } => {
			let notice = render_notice_row(message, geometry, tokens);
			Some(span_cells(geometry.diff_row_height_px, None, notice))
		},
		DiffRow::Truncated { remaining } => {
			let notice = render_notice_row(&truncated_notice(*remaining), geometry, tokens);
			Some(span_cells(geometry.diff_row_height_px, None, notice))
		},
		DiffRow::Context { .. } | DiffRow::Added { .. } | DiffRow::Removed { .. } => None,
	}
}

/// Builds the columns a unified diff draws in, admitting the rows `walk`
/// states are inside the pane's box.
pub fn unified_columns(
	file_index: usize,
	file: &DiffFile,
	walk: &mut RowWalk,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> PaneColumns {
	let mut pane = PaneColumns::new(unified_file_columns(file));
	for (row_index, row) in file.rows.iter().enumerate() {
		if !walk.admit(row_height(row, geometry)) {
			continue;
		}
		if let Some((pinned, code)) =
			spanning_cells(file_index, &file.path, row_index, row, geometry, tokens, cx)
		{
			pane.push(pinned, code);
			continue;
		}
		let line = match row {
			DiffRow::Context { new_line, text, .. } => Line::context(*new_line, text),
			DiffRow::Added { new_line, text, intraline } => Line {
				number: Some(*new_line),
				sign: "+",
				sign_role: ColorRole::Foreground,
				text,
				intraline,
				tint: Some(TintRole::Done),
			},
			DiffRow::Removed { old_line, text, intraline } => Line {
				number: Some(*old_line),
				sign: "-",
				sign_role: ColorRole::Foreground,
				text,
				intraline,
				tint: Some(TintRole::Error),
			},
			_ => continue,
		};
		let (pinned, code) = line_cells(&line, geometry, tokens);
		pane.push(pinned, code);
	}
	pane
}
