//! Terminal 2D addressable cell grid and cursor state.
//!
//! Enforces dimensions from 20x5 to 400x120 inclusive.
//! Manages scroll regions, cursor positioning, deferred wrapping, and screen
//! resizing.

use std::{error::Error, fmt};

use crate::vpty::cell::{Attributes, Cell, ColorRgb};

/// Minimum allowed terminal columns.
pub const MIN_COLS: usize = 20;
/// Maximum allowed terminal columns.
pub const MAX_COLS: usize = 400;
/// Minimum allowed terminal rows.
pub const MIN_ROWS: usize = 5;
/// Maximum allowed terminal rows.
pub const MAX_ROWS: usize = 120;

/// Error returned when grid dimensions fall outside `20x5..=400x120`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DimensionError {
	/// Attempted column count.
	pub cols: usize,
	/// Attempted row count.
	pub rows: usize,
}

impl fmt::Display for DimensionError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(
			f,
			"grid dimensions {}x{} outside allowed range {}x{}..={}x{}",
			self.cols, self.rows, MIN_COLS, MIN_ROWS, MAX_COLS, MAX_ROWS
		)
	}
}

impl Error for DimensionError {}

/// Cursor position (0-indexed).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CursorPos {
	/// 0-indexed column index.
	pub col: usize,
	/// 0-indexed row index.
	pub row: usize,
}

/// Saved cursor state (DEC / ANSI cursor save).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SavedCursor {
	/// Saved position.
	pub pos:         CursorPos,
	/// Saved attributes.
	pub attrs:       Attributes,
	/// Saved foreground color.
	pub fg:          Option<ColorRgb>,
	/// Saved background color.
	pub bg:          Option<ColorRgb>,
	/// Saved origin mode.
	pub origin_mode: bool,
}

/// Vertical scroll region defined by top and bottom 0-indexed row bounds
/// inclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScrollRegion {
	/// Top row index (inclusive, 0-indexed).
	pub top:    usize,
	/// Bottom row index (inclusive, 0-indexed).
	pub bottom: usize,
}

/// Terminal 2D addressable cell grid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grid {
	cols:          usize,
	rows:          usize,
	cells:         Vec<Vec<Cell>>,
	cursor:        CursorPos,
	saved_cursor:  Option<SavedCursor>,
	scroll_region: ScrollRegion,
	wrap_pending:  bool,
	origin_mode:   bool,
	autowrap:      bool,
}

impl Grid {
	/// Creates a new grid with specified dimensions.
	///
	/// Returns `Err(DimensionError)` if `cols` is outside `20..=400` or `rows`
	/// is outside `5..=120`.
	pub fn new(cols: usize, rows: usize) -> Result<Self, DimensionError> {
		if !(MIN_COLS..=MAX_COLS).contains(&cols) || !(MIN_ROWS..=MAX_ROWS).contains(&rows) {
			return Err(DimensionError { cols, rows });
		}
		let cells = vec![vec![Cell::blank(); cols]; rows];
		let scroll_region = ScrollRegion { top: 0, bottom: rows.saturating_sub(1) };
		Ok(Self {
			cols,
			rows,
			cells,
			cursor: CursorPos { col: 0, row: 0 },
			saved_cursor: None,
			scroll_region,
			wrap_pending: false,
			origin_mode: false,
			autowrap: true,
		})
	}

	/// Returns column count.
	#[must_use]
	pub const fn cols(&self) -> usize {
		self.cols
	}

	/// Returns row count.
	#[must_use]
	pub const fn rows(&self) -> usize {
		self.rows
	}

	/// Returns current cursor position.
	#[must_use]
	pub const fn cursor(&self) -> CursorPos {
		self.cursor
	}

	/// Returns whether wrap is pending on the next printed glyph.
	#[must_use]
	pub const fn wrap_pending(&self) -> bool {
		self.wrap_pending
	}

	/// Sets or clears `wrap_pending`.
	pub const fn set_wrap_pending(&mut self, pending: bool) {
		self.wrap_pending = pending;
	}

	/// Returns the current scroll region.
	#[must_use]
	pub const fn scroll_region(&self) -> ScrollRegion {
		self.scroll_region
	}

	/// Returns whether origin mode (DECOM) is active.
	#[must_use]
	pub const fn origin_mode(&self) -> bool {
		self.origin_mode
	}

	/// Sets origin mode (DECOM). When enabled, cursor positioning is relative to
	/// the scroll region.
	pub const fn set_origin_mode(&mut self, origin_mode: bool) {
		self.origin_mode = origin_mode;
		self.set_cursor_home();
	}

	/// Returns whether autowrap mode (DECAWM) is active.
	#[must_use]
	pub const fn autowrap(&self) -> bool {
		self.autowrap
	}

	/// Sets autowrap mode (DECAWM).
	pub const fn set_autowrap(&mut self, autowrap: bool) {
		self.autowrap = autowrap;
		if !autowrap {
			self.wrap_pending = false;
		}
	}

	/// Returns a reference to the cell at `(col, row)`.
	#[must_use]
	pub fn cell(&self, col: usize, row: usize) -> Option<&Cell> {
		self.cells.get(row).and_then(|r| r.get(col))
	}

	/// Returns a mutable reference to the cell at `(col, row)`.
	pub fn cell_mut(&mut self, col: usize, row: usize) -> Option<&mut Cell> {
		self.cells.get_mut(row).and_then(|r| r.get_mut(col))
	}

	/// Sets the cursor position directly, clamped to terminal bounds or scroll
	/// region if origin mode is active.
	pub fn set_cursor(&mut self, col: usize, row: usize) {
		self.wrap_pending = false;
		if self.origin_mode {
			let actual_row = (self.scroll_region.top + row).min(self.scroll_region.bottom);
			self.cursor.row = actual_row;
		} else {
			self.cursor.row = row.min(self.rows.saturating_sub(1));
		}
		self.cursor.col = col.min(self.cols.saturating_sub(1));
	}

	/// Moves the cursor to the home position (top-left or top of scroll region).
	pub const fn set_cursor_home(&mut self) {
		self.wrap_pending = false;
		if self.origin_mode {
			self.cursor.row = self.scroll_region.top;
		} else {
			self.cursor.row = 0;
		}
		self.cursor.col = 0;
	}

	/// Saves the cursor position and attributes.
	pub const fn save_cursor(
		&mut self,
		attrs: Attributes,
		fg: Option<ColorRgb>,
		bg: Option<ColorRgb>,
	) {
		self.saved_cursor =
			Some(SavedCursor { pos: self.cursor, attrs, fg, bg, origin_mode: self.origin_mode });
	}

	/// Restores the cursor position and returns the saved attributes and colors,
	/// if any.
	pub fn restore_cursor(&mut self) -> Option<(Attributes, Option<ColorRgb>, Option<ColorRgb>)> {
		if let Some(saved) = self.saved_cursor {
			self.origin_mode = saved.origin_mode;
			self.cursor = saved.pos;
			// Clamp in case grid was resized in between
			self.cursor.col = self.cursor.col.min(self.cols.saturating_sub(1));
			self.cursor.row = self.cursor.row.min(self.rows.saturating_sub(1));
			self.wrap_pending = false;
			Some((saved.attrs, saved.fg, saved.bg))
		} else {
			None
		}
	}

	/// Sets the vertical scroll region (0-indexed top and bottom inclusive).
	/// If top >= bottom or bottom >= rows, defaults to full screen.
	pub const fn set_scroll_region(&mut self, top: usize, bottom: usize) {
		if top < bottom && bottom < self.rows {
			self.scroll_region = ScrollRegion { top, bottom };
		} else {
			self.scroll_region = ScrollRegion { top: 0, bottom: self.rows.saturating_sub(1) };
		}
		self.set_cursor_home();
	}

	/// Resets the scroll region to the full screen.
	pub const fn reset_scroll_region(&mut self) {
		self.scroll_region = ScrollRegion { top: 0, bottom: self.rows.saturating_sub(1) };
	}

	/// Scrolls the scroll region up by `count` lines. Lines scrolled off the top
	/// are lost. New blank lines enter at the bottom of the scroll region.
	pub fn scroll_up(&mut self, count: usize) {
		let top = self.scroll_region.top;
		let bottom = self.scroll_region.bottom;
		if top >= bottom || top >= self.rows || bottom >= self.rows {
			return;
		}
		let count = count.min(bottom - top + 1);
		for _ in 0..count {
			self.cells.remove(top);
			self.cells.insert(bottom, vec![Cell::blank(); self.cols]);
		}
	}

	/// Scrolls the scroll region down by `count` lines. Lines scrolled off the
	/// bottom are lost. New blank lines enter at the top of the scroll region.
	pub fn scroll_down(&mut self, count: usize) {
		let top = self.scroll_region.top;
		let bottom = self.scroll_region.bottom;
		if top >= bottom || top >= self.rows || bottom >= self.rows {
			return;
		}
		let count = count.min(bottom - top + 1);
		for _ in 0..count {
			self.cells.remove(bottom);
			self.cells.insert(top, vec![Cell::blank(); self.cols]);
		}
	}

	/// Carriage return `\r`: moves cursor to column 0.
	pub const fn carriage_return(&mut self) {
		self.cursor.col = 0;
		self.wrap_pending = false;
	}

	/// Line feed `\n` or index (`IND`): moves cursor down one line.
	/// If at bottom of scroll region, scrolls the scroll region up.
	pub fn line_feed(&mut self) {
		self.wrap_pending = false;
		if self.cursor.row == self.scroll_region.bottom {
			self.scroll_up(1);
		} else if self.cursor.row + 1 < self.rows {
			self.cursor.row += 1;
		}
	}

	/// Reverse index (`RI`): moves cursor up one line.
	/// If at top of scroll region, scrolls the scroll region down.
	pub fn reverse_index(&mut self) {
		self.wrap_pending = false;
		if self.cursor.row == self.scroll_region.top {
			self.scroll_down(1);
		} else if self.cursor.row > 0 {
			self.cursor.row -= 1;
		}
	}

	/// Backspace `\b`: moves cursor left one column (if not at col 0).
	pub const fn backspace(&mut self) {
		self.wrap_pending = false;
		if self.cursor.col > 0 {
			self.cursor.col -= 1;
		}
	}

	/// Horizontal tab `\t`: advances cursor to next 8-column tab stop, or end of
	/// line.
	pub fn tab(&mut self) {
		self.wrap_pending = false;
		let next_tab = (self.cursor.col / 8 + 1) * 8;
		self.cursor.col = next_tab.min(self.cols.saturating_sub(1));
	}

	/// Cursor up (`CUU`).
	pub fn cursor_up(&mut self, count: usize) {
		self.wrap_pending = false;
		let min_row = if self.origin_mode {
			self.scroll_region.top
		} else {
			0
		};
		self.cursor.row = self.cursor.row.saturating_sub(count).max(min_row);
	}

	/// Cursor down (`CUD`).
	pub fn cursor_down(&mut self, count: usize) {
		self.wrap_pending = false;
		let max_row = if self.origin_mode {
			self.scroll_region.bottom
		} else {
			self.rows.saturating_sub(1)
		};
		self.cursor.row = (self.cursor.row + count).min(max_row);
	}

	/// Cursor forward (`CUF`).
	pub fn cursor_forward(&mut self, count: usize) {
		self.wrap_pending = false;
		self.cursor.col = (self.cursor.col + count).min(self.cols.saturating_sub(1));
	}

	/// Cursor backward (`CUB`).
	pub const fn cursor_backward(&mut self, count: usize) {
		self.wrap_pending = false;
		self.cursor.col = self.cursor.col.saturating_sub(count);
	}

	/// Erase in Display (`ED`).
	/// - 0: Erase from cursor to end of screen.
	/// - 1: Erase from beginning of screen to cursor.
	/// - 2 or 3: Erase complete display.
	pub fn erase_in_display(&mut self, mode: u32, bg: Option<ColorRgb>) {
		self.wrap_pending = false;
		match mode {
			0 => {
				// From cursor to end of current row
				if let Some(row) = self.cells.get_mut(self.cursor.row) {
					for cell in row.iter_mut().skip(self.cursor.col) {
						cell.clear(bg);
					}
				}
				// All subsequent rows
				for row in self.cells.iter_mut().skip(self.cursor.row + 1) {
					for cell in row.iter_mut() {
						cell.clear(bg);
					}
				}
			},
			1 => {
				// All preceding rows
				for row in self.cells.iter_mut().take(self.cursor.row) {
					for cell in row.iter_mut() {
						cell.clear(bg);
					}
				}
				// Current row up to cursor
				if let Some(row) = self.cells.get_mut(self.cursor.row) {
					for cell in row.iter_mut().take(self.cursor.col + 1) {
						cell.clear(bg);
					}
				}
			},
			2 | 3 => {
				// Complete screen
				for row in &mut self.cells {
					for cell in row {
						cell.clear(bg);
					}
				}
			},
			_ => {},
		}
	}

	/// Erase in Line (`EL`).
	/// - 0: Erase from cursor to end of line.
	/// - 1: Erase from start of line to cursor.
	/// - 2: Erase entire line.
	pub fn erase_in_line(&mut self, mode: u32, bg: Option<ColorRgb>) {
		self.wrap_pending = false;
		if let Some(row) = self.cells.get_mut(self.cursor.row) {
			match mode {
				0 => {
					for cell in row.iter_mut().skip(self.cursor.col) {
						cell.clear(bg);
					}
				},
				1 => {
					for cell in row.iter_mut().take(self.cursor.col + 1) {
						cell.clear(bg);
					}
				},
				2 => {
					for cell in row.iter_mut() {
						cell.clear(bg);
					}
				},
				_ => {},
			}
		}
	}

	/// Erase characters (`ECH`): erases `count` characters from cursor position
	/// to the right.
	pub fn erase_characters(&mut self, count: usize, bg: Option<ColorRgb>) {
		self.wrap_pending = false;
		if let Some(row) = self.cells.get_mut(self.cursor.row) {
			for cell in row.iter_mut().skip(self.cursor.col).take(count) {
				cell.clear(bg);
			}
		}
	}

	/// Writes a grapheme cluster at the current cursor position, taking into
	/// account width (1 or 2).
	///
	/// Handles deferred wrapping: if at the right margin when wrap is pending,
	/// advances to the next line before printing.
	/// If a wide character (width 2) is printed at the last column, it wraps to
	/// the next line first.
	pub fn write_grapheme(
		&mut self,
		cluster: &str,
		width: usize,
		fg: Option<ColorRgb>,
		bg: Option<ColorRgb>,
		attrs: Attributes,
	) {
		if width == 0 {
			// Zero-width characters (e.g. standalone zero-width joiners/marks):
			// Attach to preceding cell if possible, else drop.
			if self.cursor.col > 0
				&& let Some(cell) = self.cell_mut(self.cursor.col - 1, self.cursor.row)
			{
				cell.content.push_str(cluster);
			}
			return;
		}

		// Check deferred wrap
		if self.autowrap && self.wrap_pending {
			self.carriage_return();
			self.line_feed();
		}

		// If wide character and at right margin, wrap to next line first
		if self.autowrap && width == 2 && self.cursor.col + 1 >= self.cols {
			// Clear current rightmost cell
			if let Some(cell) = self.cell_mut(self.cursor.col, self.cursor.row) {
				cell.clear(bg);
			}
			self.carriage_return();
			self.line_feed();
		}

		let row = self.cursor.row;
		let col = self.cursor.col;

		// Write primary cell
		if let Some(cell) = self.cell_mut(col, row) {
			cell.content = cluster.to_string();
			cell.fg = fg;
			cell.bg = bg;
			cell.attrs = attrs;
			cell.is_continuation = false;
		}

		if width == 2 {
			// Write continuation cell
			if let Some(cont_cell) = self.cell_mut(col + 1, row) {
				cont_cell.content.clear();
				cont_cell.fg = fg;
				cont_cell.bg = bg;
				cont_cell.attrs = attrs;
				cont_cell.is_continuation = true;
			}
		}

		// Advance cursor position
		if width == 2 {
			if col + 2 < self.cols {
				self.cursor.col += 2;
				self.wrap_pending = false;
			} else {
				// At or beyond last column
				self.cursor.col = self.cols.saturating_sub(1);
				if self.autowrap {
					self.wrap_pending = true;
				}
			}
		} else if col + 1 < self.cols {
			self.cursor.col += 1;
			self.wrap_pending = false;
		} else {
			// Reached rightmost column
			self.cursor.col = self.cols.saturating_sub(1);
			if self.autowrap {
				self.wrap_pending = true;
			}
		}
	}

	/// Resizes the grid to new dimensions `(new_cols, new_rows)`.
	///
	/// Returns `Err(DimensionError)` if outside `20x5..=400x120`.
	///
	/// Truncation/expansion rule:
	/// - When columns expand, existing rows are padded with blank cells.
	/// - When columns shrink, existing rows are truncated at `new_cols`.
	/// - When rows expand, new blank rows are added at the bottom.
	/// - When rows shrink, rows are truncated from the bottom.
	/// - Cursor is clamped to `(new_cols - 1, new_rows - 1)`.
	/// - Scroll region is reset to full screen if invalidated.
	pub fn resize(&mut self, new_cols: usize, new_rows: usize) -> Result<(), DimensionError> {
		if !(MIN_COLS..=MAX_COLS).contains(&new_cols) || !(MIN_ROWS..=MAX_ROWS).contains(&new_rows) {
			return Err(DimensionError { cols: new_cols, rows: new_rows });
		}

		// Resize columns for existing rows
		for row in &mut self.cells {
			if new_cols > self.cols {
				row.resize(new_cols, Cell::blank());
			} else if new_cols < self.cols {
				row.truncate(new_cols);
				// If last cell became an orphan continuation, clear it
				if let Some(last) = row.last_mut()
					&& last.is_continuation
				{
					last.clear(None);
				}
			}
		}

		// Resize rows
		if new_rows > self.rows {
			for _ in self.rows..new_rows {
				self.cells.push(vec![Cell::blank(); new_cols]);
			}
		} else if new_rows < self.rows {
			self.cells.truncate(new_rows);
		}

		self.cols = new_cols;
		self.rows = new_rows;

		// Clamp cursor
		self.cursor.col = self.cursor.col.min(self.cols.saturating_sub(1));
		self.cursor.row = self.cursor.row.min(self.rows.saturating_sub(1));
		self.wrap_pending = false;

		// Reset scroll region to full screen
		self.scroll_region = ScrollRegion { top: 0, bottom: self.rows.saturating_sub(1) };

		Ok(())
	}
}
