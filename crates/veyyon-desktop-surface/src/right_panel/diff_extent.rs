//! How tall and how wide a diff's rows are (§5.11).
//!
//! A pane states its scroll extent before the frame is laid out: the cursor
//! through the region advances by the height each row draws at whether the row
//! is built or skipped, and the code column is as wide as the file's widest
//! line. Both are read from the rows rather than from the cells, so the extent
//! is the file's and does not change as the wheel changes which rows the pane
//! builds.

use veyyon_desktop_tokens::PanelsSurfaceTokens;

use crate::right_panel::{
	content::{DiffFile, DiffRow},
	diff_rows::{collapsed_label, hunk_header_text, truncated_notice},
	pane_window::text_columns,
};

/// How tall a row draws, which is what the cursor through the region advances
/// by whether the row is built or measured.
pub const fn row_height(row: &DiffRow, geometry: &PanelsSurfaceTokens) -> f32 {
	match row {
		DiffRow::HunkHeader { .. } => geometry.diff_hunk_header_height_px,
		_ => geometry.diff_row_height_px,
	}
}

/// How wide a row's text is, in monospace cells.
fn row_columns(row: &DiffRow) -> usize {
	match row {
		DiffRow::HunkHeader { old_start, old_count, new_start, new_count, symbol } => {
			text_columns(&hunk_header_text(*old_start, *old_count, *new_start, *new_count, symbol))
		},
		DiffRow::Collapsed { hidden, .. } => text_columns(&collapsed_label(*hidden)),
		DiffRow::Binary { message } | DiffRow::Unavailable { reason: message } => {
			text_columns(message)
		},
		DiffRow::Truncated { remaining } => text_columns(&truncated_notice(*remaining)),
		DiffRow::Context { text, .. }
		| DiffRow::Added { text, .. }
		| DiffRow::Removed { text, .. } => text_columns(text),
	}
}

/// How wide the widest row of `file` is, as a unified pane draws it.
///
/// Measured over the whole file rather than over the rows on screen: the
/// content width is the pane's scroll extent, and an extent that changed as
/// the pane scrolled would move under the gesture reading it.
pub fn unified_file_columns(file: &DiffFile) -> usize {
	file.rows.iter().map(row_columns).max().unwrap_or(0)
}

/// The same for a split pane's two sides: the old side carries the removed
/// lines and the spanning rows, the new side the added ones, and both carry
/// the context.
pub fn split_file_columns(file: &DiffFile) -> (usize, usize) {
	let mut old = 0;
	let mut new = 0;
	for row in &file.rows {
		let cells = row_columns(row);
		match row {
			DiffRow::Added { .. } => new = new.max(cells),
			DiffRow::Context { .. } => {
				old = old.max(cells);
				new = new.max(cells);
			},
			_ => old = old.max(cells),
		}
	}
	(old, new)
}
