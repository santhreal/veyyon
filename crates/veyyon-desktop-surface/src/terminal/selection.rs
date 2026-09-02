//! Terminal selection and text extraction.
//!
//! Models linear stream selections and rectangular block selections across
//! the visible terminal grid and scrollback history.

use super::cell::Cell;

/// Selection highlight region kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionKind {
	/// Linear stream selection across line wraps.
	Linear,
	/// Rectangular column-bounded block selection.
	Rectangular,
}

/// Selection range in grid coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSelection {
	/// Starting column (0-indexed).
	pub start_col: usize,
	/// Starting row (0-indexed).
	pub start_row: usize,
	/// Ending column (0-indexed).
	pub end_col:   usize,
	/// Ending row (0-indexed).
	pub end_row:   usize,
	/// Selection mode.
	pub kind:      SelectionKind,
}

impl TerminalSelection {
	/// Returns true if the cell at (col, row) is within the selection bounds.
	#[must_use]
	pub fn contains(&self, col: usize, row: usize) -> bool {
		let (min_r, max_r, min_c, max_c) = self.normalized_bounds();
		match self.kind {
			SelectionKind::Rectangular => row >= min_r && row <= max_r && col >= min_c && col <= max_c,
			SelectionKind::Linear => {
				if row < min_r || row > max_r {
					false
				} else if min_r == max_r {
					col >= min_c && col <= max_c
				} else if row == min_r {
					col >= self.start_col.min(self.end_col)
				} else if row == max_r {
					col <= self.start_col.max(self.end_col)
				} else {
					true
				}
			},
		}
	}

	/// Returns normalized row and column bounds (`min_row`, `max_row`,
	/// `min_col`, `max_col`).
	#[must_use]
	pub fn normalized_bounds(&self) -> (usize, usize, usize, usize) {
		let min_r = self.start_row.min(self.end_row);
		let max_r = self.start_row.max(self.end_row);
		let min_c = self.start_col.min(self.end_col);
		let max_c = self.start_col.max(self.end_col);
		(min_r, max_r, min_c, max_c)
	}

	/// Extracts selected plain text from a list of rows.
	#[must_use]
	pub fn extract_text(&self, rows: &[Vec<Cell>]) -> String {
		let mut text = String::new();
		let (min_r, max_r, ..) = self.normalized_bounds();
		for r in min_r..=max_r {
			if let Some(row) = rows.get(r) {
				let mut line = String::new();
				for (c, cell) in row.iter().enumerate() {
					if self.contains(c, r) && cell.width > 0 {
						line.push(cell.c);
					}
				}
				let trimmed = line.trim_end();
				if !text.is_empty() {
					text.push('\n');
				}
				text.push_str(trimmed);
			}
		}
		text
	}
}
