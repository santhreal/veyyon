//! The columns a split diff's two panes draw in (§5.11).
//!
//! A split diff reads across: the third line removed sits beside the third
//! line added, and a row that spans the pane is pushed to both sides so they
//! stay level. The cells themselves are the unified pane's, built once in
//! `diff_columns` and arranged here.

use veyyon_desktop_kit::{ColorRole, TintRole, TokenSet};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{Context, Styled, div, px};

use crate::{
	ShellView,
	right_panel::{
		content::{DiffFile, DiffRow},
		diff_columns::{Line, PaneColumns, line_cells, span_cells, spanning_cells},
		diff_extent::{row_height, split_file_columns},
		pane_window::RowWalk,
	},
};

/// Builds the columns a split diff's two panes draw in: the old side and the
/// new side.
///
/// A spanning row is pushed to both panes so the sides stay level, with its
/// text on the old side only: drawn on both, a hunk header would read twice.
pub fn split_columns(
	file_index: usize,
	file: &DiffFile,
	walk: &mut RowWalk,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> (PaneColumns, PaneColumns) {
	let (old_columns, new_columns) = split_file_columns(file);
	let mut old = PaneColumns::new(old_columns);
	let mut new = PaneColumns::new(new_columns);

	let mut row_index = 0;
	while row_index < file.rows.len() {
		let row = &file.rows[row_index];
		if let DiffRow::Removed { .. } | DiffRow::Added { .. } = row {
			row_index = push_change_chunk(file, row_index, &mut old, &mut new, walk, geometry, tokens);
			continue;
		}
		let height = row_height(row, geometry);
		if !walk.admit(height) {
			row_index += 1;
			continue;
		}
		if let Some((pinned, code)) =
			spanning_cells(file_index, &file.path, row_index, row, geometry, tokens, cx)
		{
			let ground = match row {
				DiffRow::HunkHeader { .. } | DiffRow::Collapsed { .. } => {
					Some(tokens.color(ColorRole::Inset))
				},
				_ => None,
			};
			let (mirror_pinned, mirror_code) = span_cells(height, ground, div().h(px(height)));
			old.push(pinned, code);
			new.push(mirror_pinned, mirror_code);
			row_index += 1;
			continue;
		}
		if let DiffRow::Context { old_line, new_line, text } = row {
			let (pinned, code) = line_cells(&Line::context(*old_line, text), geometry, tokens);
			old.push(pinned, code);
			let (pinned, code) = line_cells(&Line::context(*new_line, text), geometry, tokens);
			new.push(pinned, code);
		}
		row_index += 1;
	}

	(old, new)
}

/// Pushes one run of removed lines beside the run of added lines that follows
/// it, one pair per row, and answers the row the run ended at.
///
/// The runs are paired rather than concatenated: a split diff reads across, so
/// the third line removed sits beside the third line added, and the shorter run
/// is padded with blank cells so the sides stay level.
fn push_change_chunk(
	file: &DiffFile,
	from: usize,
	old: &mut PaneColumns,
	new: &mut PaneColumns,
	walk: &mut RowWalk,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
) -> usize {
	let mut row_index = from;
	let mut removed = Vec::new();
	let mut added = Vec::new();

	while let Some(DiffRow::Removed { old_line, text, intraline }) = file.rows.get(row_index) {
		removed.push((*old_line, text, intraline));
		row_index += 1;
	}
	while let Some(DiffRow::Added { new_line, text, intraline }) = file.rows.get(row_index) {
		added.push((*new_line, text, intraline));
		row_index += 1;
	}

	for pair in 0..removed.len().max(added.len()) {
		// One pair is one row of the pane, whichever side is shorter, so the
		// cursor advances once per pair and not once per changed line.
		if !walk.admit(geometry.diff_row_height_px) {
			continue;
		}
		let line = match removed.get(pair) {
			Some((number, text, intraline)) => Line {
				number: Some(*number),
				sign: "-",
				sign_role: ColorRole::Foreground,
				text,
				intraline,
				tint: Some(TintRole::Error),
			},
			None => Line::blank(),
		};
		let (pinned, code) = line_cells(&line, geometry, tokens);
		old.push(pinned, code);

		let line = match added.get(pair) {
			Some((number, text, intraline)) => Line {
				number: Some(*number),
				sign: "+",
				sign_role: ColorRole::Foreground,
				text,
				intraline,
				tint: Some(TintRole::Done),
			},
			None => Line::blank(),
		};
		let (pinned, code) = line_cells(&line, geometry, tokens);
		new.push(pinned, code);
	}

	row_index
}
