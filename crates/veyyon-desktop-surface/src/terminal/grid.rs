//! Terminal grid buffer and cursor management.
//!
//! Maintains visible rows, scrollback history up to 10,000 rows, cursor
//! coordinates, active styling, alternate screen buffers, and scroll regions.

use std::collections::VecDeque;

use unicode_width::UnicodeWidthChar;

use super::{
	cell::{Cell, CellStyle, Ink},
	selection::TerminalSelection,
};

/// Maximum scrollback history retained in rows.
pub const MAX_SCROLLBACK_ROWS: usize = 10_000;

/// Saved cursor position and formatting attributes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SavedCursor {
	pub col:       usize,
	pub row:       usize,
	pub style:     CellStyle,
	pub fg:        Ink,
	pub bg:        Ink,
	pub auto_wrap: bool,
}

/// The terminal grid holding visible cells and scrollback history.
#[derive(Debug, Clone)]
pub struct TerminalGrid {
	pub cols:                 usize,
	pub rows:                 usize,
	pub cursor_col:           usize,
	pub cursor_row:           usize,
	pub cursor_visible:       bool,
	pub auto_wrap:            bool,
	pub wrap_next:            bool,
	pub alternate_screen:     bool,
	pub bracketed_paste:      bool,
	pub scroll_top:           usize,
	pub scroll_bottom:        usize,
	pub title:                String,
	pub style:                CellStyle,
	pub fg:                   Ink,
	pub bg:                   Ink,
	pub primary_lines:        VecDeque<Vec<Cell>>,
	pub alt_lines:            Vec<Vec<Cell>>,
	pub saved_cursor_primary: SavedCursor,
	pub saved_cursor_alt:     SavedCursor,
	pub selection:            Option<TerminalSelection>,
}

impl TerminalGrid {
	/// Constructs a new terminal grid with specified dimensions.
	#[must_use]
	pub fn new(cols: usize, rows: usize) -> Self {
		let cols = cols.max(1);
		let rows = rows.max(1);
		let mut primary_lines = VecDeque::with_capacity(rows);
		for _ in 0..rows {
			primary_lines.push_back(vec![Cell::blank(); cols]);
		}
		let mut alt_lines = Vec::with_capacity(rows);
		for _ in 0..rows {
			alt_lines.push(vec![Cell::blank(); cols]);
		}

		Self {
			cols,
			rows,
			cursor_col: 0,
			cursor_row: 0,
			cursor_visible: true,
			auto_wrap: true,
			wrap_next: false,
			alternate_screen: false,
			bracketed_paste: false,
			scroll_top: 0,
			scroll_bottom: rows.saturating_sub(1),
			title: String::new(),
			style: CellStyle::new(),
			fg: Ink::Default,
			bg: Ink::Default,
			primary_lines,
			alt_lines,
			saved_cursor_primary: SavedCursor::default(),
			saved_cursor_alt: SavedCursor::default(),
			selection: None,
		}
	}

	/// Returns total lines in scrollback history.
	#[must_use]
	pub fn scrollback_len(&self) -> usize {
		if self.alternate_screen {
			0
		} else {
			self.primary_lines.len().saturating_sub(self.rows)
		}
	}

	/// Returns a reference to a visible screen row (0..self.rows).
	#[must_use]
	pub fn visible_row(&self, row: usize) -> Option<&[Cell]> {
		if row >= self.rows {
			return None;
		}
		if self.alternate_screen {
			self.alt_lines.get(row).map(Vec::as_slice)
		} else {
			let idx = self.primary_lines.len().saturating_sub(self.rows) + row;
			self.primary_lines.get(idx).map(Vec::as_slice)
		}
	}

	/// Returns a mutable reference to a visible screen row.
	pub fn visible_row_mut(&mut self, row: usize) -> Option<&mut [Cell]> {
		if row >= self.rows {
			return None;
		}
		if self.alternate_screen {
			self.alt_lines.get_mut(row).map(Vec::as_mut_slice)
		} else {
			let idx = self.primary_lines.len().saturating_sub(self.rows) + row;
			self.primary_lines.get_mut(idx).map(Vec::as_mut_slice)
		}
	}

	/// Resizes the terminal grid without reflowing text.
	pub fn resize(&mut self, new_cols: usize, new_rows: usize) {
		let new_cols = new_cols.max(1);
		let new_rows = new_rows.max(1);
		if new_cols == self.cols && new_rows == self.rows {
			return;
		}

		for line in &mut self.primary_lines {
			line.resize(new_cols, Cell::blank());
		}
		while self.primary_lines.len() < new_rows {
			self.primary_lines.push_back(vec![Cell::blank(); new_cols]);
		}
		while self.primary_lines.len() > MAX_SCROLLBACK_ROWS + new_rows {
			self.primary_lines.pop_front();
		}
		for line in &mut self.alt_lines {
			line.resize(new_cols, Cell::blank());
		}
		self
			.alt_lines
			.resize(new_rows, vec![Cell::blank(); new_cols]);

		self.cols = new_cols;
		self.rows = new_rows;
		self.scroll_top = 0;
		self.scroll_bottom = new_rows.saturating_sub(1);
		self.cursor_col = self.cursor_col.min(new_cols.saturating_sub(1));
		self.cursor_row = self.cursor_row.min(new_rows.saturating_sub(1));
		self.wrap_next = false;
	}

	/// Inserts a printable character at cursor position.
	pub fn print_char(&mut self, c: char) {
		let width = UnicodeWidthChar::width(c).unwrap_or(1);
		if width == 0 {
			return;
		}

		if self.wrap_next && self.auto_wrap {
			self.wrap_next = false;
			self.cursor_col = 0;
			self.linefeed();
		}

		let (fg, bg, style) = (self.fg, self.bg, self.style);
		if width == 2 {
			if self.cursor_col >= self.cols.saturating_sub(1) {
				let (col, r_idx) = (self.cursor_col, self.cursor_row);
				if let Some(row) = self.visible_row_mut(r_idx)
					&& let Some(cell) = row.get_mut(col)
				{
					cell.reset();
				}
				if self.auto_wrap {
					self.cursor_col = 0;
					self.linefeed();
				}
			}
			let (col, row) = (self.cursor_col, self.cursor_row);
			if let Some(r) = self.visible_row_mut(row) {
				if let Some(c1) = r.get_mut(col) {
					*c1 = Cell { c, ink: fg, bg_ink: bg, style, width: 2 };
				}
				if let Some(c2) = r.get_mut(col + 1) {
					*c2 = Cell { c: ' ', ink: fg, bg_ink: bg, style, width: 0 };
				}
			}
			if self.cursor_col + 2 < self.cols {
				self.cursor_col += 2;
			} else {
				self.cursor_col = self.cols.saturating_sub(1);
				self.wrap_next = true;
			}
		} else {
			let (col, row) = (self.cursor_col, self.cursor_row);
			if let Some(r) = self.visible_row_mut(row)
				&& let Some(cell) = r.get_mut(col)
			{
				*cell = Cell { c, ink: fg, bg_ink: bg, style, width: 1 };
			}
			if self.cursor_col + 1 < self.cols {
				self.cursor_col += 1;
			} else {
				self.wrap_next = true;
			}
		}
	}

	/// Advances cursor to the next line, scrolling if at bottom margin.
	pub fn linefeed(&mut self) {
		self.wrap_next = false;
		if self.cursor_row == self.scroll_bottom {
			self.scroll_up_region(1);
		} else if self.cursor_row + 1 < self.rows {
			self.cursor_row += 1;
		}
	}

	/// Moves cursor to column 0.
	pub const fn carriage_return(&mut self) {
		self.cursor_col = 0;
		self.wrap_next = false;
	}

	/// Moves cursor left by 1 column.
	pub const fn backspace(&mut self) {
		self.cursor_col = self.cursor_col.saturating_sub(1);
		self.wrap_next = false;
	}

	/// Advances cursor to next horizontal tab stop (every 8 columns).
	pub const fn tab(&mut self) {
		self.wrap_next = false;
		self.cursor_col = ((self.cursor_col / 8) + 1) * 8;
		if self.cursor_col >= self.cols {
			self.cursor_col = self.cols.saturating_sub(1);
		}
	}
}
