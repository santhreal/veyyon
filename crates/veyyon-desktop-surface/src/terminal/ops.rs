//! Terminal editing and scrolling operations.
//!
//! Provides screen erase, character insert/delete, line insert/delete,
//! scrolling within margins, and cursor save/restore functions on
//! `TerminalGrid`.

use super::grid::{MAX_SCROLLBACK_ROWS, SavedCursor, TerminalGrid};
use crate::terminal::cell::Cell;

impl TerminalGrid {
	/// Scrolls the scroll region up by `count` lines.
	pub fn scroll_up_region(&mut self, count: usize) {
		let count = count.min(self.scroll_bottom.saturating_sub(self.scroll_top) + 1);
		if count == 0 {
			return;
		}

		if self.alternate_screen {
			for r in self.scroll_top..=self.scroll_bottom {
				let src = r + count;
				if src <= self.scroll_bottom {
					self.alt_lines[r] = self.alt_lines[src].clone();
				} else {
					self.alt_lines[r] = vec![Cell::blank(); self.cols];
				}
			}
		} else if self.scroll_top == 0 && self.scroll_bottom == self.rows.saturating_sub(1) {
			for _ in 0..count {
				if self.primary_lines.len() >= MAX_SCROLLBACK_ROWS + self.rows {
					self.primary_lines.pop_front();
				}
				self.primary_lines.push_back(vec![Cell::blank(); self.cols]);
			}
		} else {
			let base = self.primary_lines.len().saturating_sub(self.rows);
			for r in self.scroll_top..=self.scroll_bottom {
				let src = r + count;
				let dest_idx = base + r;
				if src <= self.scroll_bottom {
					let src_idx = base + src;
					self.primary_lines[dest_idx] = self.primary_lines[src_idx].clone();
				} else {
					self.primary_lines[dest_idx] = vec![Cell::blank(); self.cols];
				}
			}
		}
	}

	/// Scrolls the scroll region down by `count` lines.
	pub fn scroll_down_region(&mut self, count: usize) {
		let count = count.min(self.scroll_bottom.saturating_sub(self.scroll_top) + 1);
		if count == 0 {
			return;
		}

		if self.alternate_screen {
			for r in (self.scroll_top..=self.scroll_bottom).rev() {
				if r >= self.scroll_top + count {
					self.alt_lines[r] = self.alt_lines[r - count].clone();
				} else {
					self.alt_lines[r] = vec![Cell::blank(); self.cols];
				}
			}
		} else {
			let base = self.primary_lines.len().saturating_sub(self.rows);
			for r in (self.scroll_top..=self.scroll_bottom).rev() {
				let dest_idx = base + r;
				if r >= self.scroll_top + count {
					let src_idx = base + (r - count);
					self.primary_lines[dest_idx] = self.primary_lines[src_idx].clone();
				} else {
					self.primary_lines[dest_idx] = vec![Cell::blank(); self.cols];
				}
			}
		}
	}

	/// Erases display areas according to ED parameter mode.
	pub fn erase_in_display(&mut self, mode: u16) {
		match mode {
			0 => {
				self.erase_in_line(0);
				for r in (self.cursor_row + 1)..self.rows {
					if let Some(row) = self.visible_row_mut(r) {
						for cell in row.iter_mut() {
							cell.reset();
						}
					}
				}
			},
			1 => {
				for r in 0..self.cursor_row {
					if let Some(row) = self.visible_row_mut(r) {
						for cell in row.iter_mut() {
							cell.reset();
						}
					}
				}
				self.erase_in_line(1);
			},
			2 => {
				for r in 0..self.rows {
					if let Some(row) = self.visible_row_mut(r) {
						for cell in row.iter_mut() {
							cell.reset();
						}
					}
				}
			},
			3 => {
				for r in 0..self.rows {
					if let Some(row) = self.visible_row_mut(r) {
						for cell in row.iter_mut() {
							cell.reset();
						}
					}
				}
				if !self.alternate_screen {
					self.primary_lines.drain(..self.scrollback_len());
				}
			},
			_ => {},
		}
	}

	/// Erases line areas according to EL parameter mode.
	pub fn erase_in_line(&mut self, mode: u16) {
		let (col, row, cols) = (self.cursor_col, self.cursor_row, self.cols);
		if let Some(r) = self.visible_row_mut(row) {
			match mode {
				0 => {
					for c in col..cols {
						if let Some(cell) = r.get_mut(c) {
							cell.reset();
						}
					}
				},
				1 => {
					for c in 0..=col.min(cols.saturating_sub(1)) {
						if let Some(cell) = r.get_mut(c) {
							cell.reset();
						}
					}
				},
				2 => {
					for cell in r.iter_mut() {
						cell.reset();
					}
				},
				_ => {},
			}
		}
	}

	/// Erases `count` characters starting at cursor.
	pub fn erase_characters(&mut self, count: usize) {
		let (col, row) = (self.cursor_col, self.cursor_row);
		let limit = (col + count).min(self.cols);
		if let Some(r) = self.visible_row_mut(row) {
			for c in col..limit {
				if let Some(cell) = r.get_mut(c) {
					cell.reset();
				}
			}
		}
	}

	/// Inserts `count` blank characters at cursor position.
	pub fn insert_characters(&mut self, count: usize) {
		let (col, row, cols) = (self.cursor_col, self.cursor_row, self.cols);
		if let Some(r) = self.visible_row_mut(row) {
			for c in (col..cols).rev() {
				if c + count < cols {
					r[c + count] = r[c];
				}
				if c < col + count {
					r[c].reset();
				}
			}
		}
	}

	/// Deletes `count` characters at cursor position.
	pub fn delete_characters(&mut self, count: usize) {
		let (col, row, cols) = (self.cursor_col, self.cursor_row, self.cols);
		if let Some(r) = self.visible_row_mut(row) {
			for c in col..cols {
				if c + count < cols {
					r[c] = r[c + count];
				} else {
					r[c].reset();
				}
			}
		}
	}

	/// Inserts `count` lines at cursor row within scroll region.
	pub fn insert_lines(&mut self, count: usize) {
		if self.cursor_row < self.scroll_top || self.cursor_row > self.scroll_bottom {
			return;
		}
		let old_top = self.scroll_top;
		self.scroll_top = self.cursor_row;
		self.scroll_down_region(count);
		self.scroll_top = old_top;
	}

	/// Deletes `count` lines at cursor row within scroll region.
	pub fn delete_lines(&mut self, count: usize) {
		if self.cursor_row < self.scroll_top || self.cursor_row > self.scroll_bottom {
			return;
		}
		let old_top = self.scroll_top;
		self.scroll_top = self.cursor_row;
		self.scroll_up_region(count);
		self.scroll_top = old_top;
	}

	/// Saves cursor position and styling.
	pub const fn save_cursor(&mut self) {
		let saved = SavedCursor {
			col:       self.cursor_col,
			row:       self.cursor_row,
			style:     self.style,
			fg:        self.fg,
			bg:        self.bg,
			auto_wrap: self.auto_wrap,
		};
		if self.alternate_screen {
			self.saved_cursor_alt = saved;
		} else {
			self.saved_cursor_primary = saved;
		}
	}

	/// Restores saved cursor position and styling.
	pub fn restore_cursor(&mut self) {
		let saved = if self.alternate_screen {
			self.saved_cursor_alt
		} else {
			self.saved_cursor_primary
		};
		self.cursor_col = saved.col.min(self.cols.saturating_sub(1));
		self.cursor_row = saved.row.min(self.rows.saturating_sub(1));
		self.style = saved.style;
		self.fg = saved.fg;
		self.bg = saved.bg;
		self.auto_wrap = saved.auto_wrap;
		self.wrap_next = false;
	}

	/// Switches between primary and alternate screen buffers (mode 1049).
	pub fn set_alternate_screen(&mut self, enable: bool) {
		if self.alternate_screen == enable {
			return;
		}
		self.alternate_screen = enable;
		if enable {
			self.save_cursor();
			for row in &mut self.alt_lines {
				for cell in row.iter_mut() {
					cell.reset();
				}
			}
			self.cursor_col = 0;
			self.cursor_row = 0;
			self.wrap_next = false;
		} else {
			self.restore_cursor();
		}
	}
}
