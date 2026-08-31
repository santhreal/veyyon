//! Parser event dispatch routing terminal sequences to grid operations.

use super::{
	emulator::TerminalEmulator,
	grid::{Grid, char_width},
	parser::{CsiSequence, ParserHandler},
	types::{CellColor, Cursor, GridSize, SavedCursor},
};

impl ParserHandler for TerminalEmulator {
	fn print(&mut self, ch: char) {
		let w = char_width(ch);
		if w == 0 {
			if self.cursor.col > 0 {
				let target_col = self.cursor.col - 1;
				let row = self.cursor.row;
				if let Some(cell) = self.active_grid_mut().cell_mut(row, target_col) {
					cell.grapheme.push(ch);
				}
			}
			return;
		}
		let cols = self.cols();
		if self.cursor.wrap_pending {
			if self.auto_wrap {
				let row = self.cursor.row;
				if let Some(line) = self.active_grid_mut().lines.get_mut(row) {
					line.wrapped = true;
				}
				self.line_feed();
				self.cursor.col = 0;
			}
			self.cursor.wrap_pending = false;
		}
		if w == 2 && self.cursor.col + 1 >= cols && self.auto_wrap {
			let row = self.cursor.row;
			if let Some(line) = self.active_grid_mut().lines.get_mut(row) {
				line.wrapped = true;
			}
			self.line_feed();
			self.cursor.col = 0;
		}
		let (r, c) = (self.cursor.row, self.cursor.col);
		let fg = self.current_fg;
		let bg = self.current_bg;
		let attrs = self.current_attrs;
		if let Some(cell) = self.active_grid_mut().cell_mut(r, c) {
			cell.grapheme.clear();
			cell.grapheme.push(ch);
			cell.fg = fg;
			cell.bg = bg;
			cell.attrs = attrs;
			cell.wide = w == 2;
			cell.wide_spacer = false;
		}
		if w == 2 && c + 1 < cols {
			if let Some(spacer) = self.active_grid_mut().cell_mut(r, c + 1) {
				spacer.reset();
				spacer.wide_spacer = true;
			}
			self.cursor.col += 1;
		}
		if self.cursor.col + 1 >= cols {
			self.cursor.wrap_pending = true;
		} else {
			self.cursor.col += 1;
		}
	}

	fn execute_c0(&mut self, byte: u8) {
		match byte {
			0x07 => self.bell = true,
			0x08 => {
				self.cursor.wrap_pending = false;
				self.cursor.col = self.cursor.col.saturating_sub(1);
			},
			0x09 => {
				self.cursor.wrap_pending = false;
				let cols = self.cols();
				let mut next = self.cursor.col + 1;
				while next < cols && !self.tab_stops.get(next).copied().unwrap_or(false) {
					next += 1;
				}
				self.cursor.col = next.min(cols.saturating_sub(1));
			},
			0x0a..=0x0c => self.line_feed(),
			0x0d => {
				self.cursor.wrap_pending = false;
				self.cursor.col = 0;
			},
			_ => {},
		}
	}

	fn csi(&mut self, seq: CsiSequence<'_>) {
		self.cursor.wrap_pending = false;
		let (rows, cols) = (self.rows(), self.cols());
		let (cur_row, cur_col) = (self.cursor.row, self.cursor.col);
		if seq.prefix == Some(b'?') {
			let is_set = seq.final_byte == b'h';
			for &p in seq.params {
				match p.unwrap_or(0) {
					1 => self.app_cursor = is_set,
					7 => self.auto_wrap = is_set,
					25 => self.cursor.visible = is_set,
					47 | 1047 | 1049 => {
						if is_set {
							if self.alt_grid.is_none() {
								self.alt_saved_cursor = SavedCursor {
									cursor: self.cursor,
									fg:     self.current_fg,
									bg:     self.current_bg,
									attrs:  self.current_attrs,
								};
								let mut alt = Grid::new(GridSize::new(cols, rows), 0);
								alt.erase_in_display(0, 0, 2);
								self.alt_grid = Some(alt);
							}
						} else if self.alt_grid.is_some() {
							self.alt_grid = None;
							self.cursor = self.alt_saved_cursor.cursor;
							self.current_fg = self.alt_saved_cursor.fg;
							self.current_bg = self.alt_saved_cursor.bg;
							self.current_attrs = self.alt_saved_cursor.attrs;
						}
					},
					2004 => self.bracketed_paste = is_set,
					_ => {},
				}
			}
			return;
		}

		match seq.final_byte {
			b'@' => {
				let n = seq.param(0, 1) as usize;
				self.active_grid_mut().insert_chars(cur_row, cur_col, n);
			},
			b'A' => {
				let n = seq.param(0, 1) as usize;
				let top = self.active_grid().scroll_top;
				if self.cursor.row >= top {
					self.cursor.row = self.cursor.row.saturating_sub(n).max(top);
				} else {
					self.cursor.row = self.cursor.row.saturating_sub(n);
				}
			},
			b'B' => {
				let n = seq.param(0, 1) as usize;
				let bottom = self.active_grid().scroll_bottom;
				if self.cursor.row <= bottom {
					self.cursor.row = (self.cursor.row + n).min(bottom);
				} else {
					self.cursor.row = (self.cursor.row + n).min(rows.saturating_sub(1));
				}
			},
			b'C' => {
				let n = seq.param(0, 1) as usize;
				self.cursor.col = (self.cursor.col + n).min(cols.saturating_sub(1));
			},
			b'D' => {
				let n = seq.param(0, 1) as usize;
				self.cursor.col = self.cursor.col.saturating_sub(n);
			},
			b'E' => {
				let n = seq.param(0, 1) as usize;
				self.cursor.col = 0;
				let bottom = self.active_grid().scroll_bottom;
				self.cursor.row = (self.cursor.row + n).min(bottom);
			},
			b'F' => {
				let n = seq.param(0, 1) as usize;
				self.cursor.col = 0;
				let top = self.active_grid().scroll_top;
				self.cursor.row = self.cursor.row.saturating_sub(n).max(top);
			},
			b'G' => {
				let n = seq.param(0, 1) as usize;
				self.cursor.col = n.saturating_sub(1).min(cols.saturating_sub(1));
			},
			b'H' | b'f' => {
				let r = seq.param(0, 1) as usize;
				let c = seq.param(1, 1) as usize;
				self.cursor.row = r.saturating_sub(1).min(rows.saturating_sub(1));
				self.cursor.col = c.saturating_sub(1).min(cols.saturating_sub(1));
			},
			b'J' => {
				let mode = seq.param(0, 0);
				self
					.active_grid_mut()
					.erase_in_display(cur_row, cur_col, mode);
			},
			b'K' => {
				let mode = seq.param(0, 0);
				self.active_grid_mut().erase_in_line(cur_row, cur_col, mode);
			},
			b'L' => {
				let n = seq.param(0, 1) as usize;
				self.active_grid_mut().insert_lines(cur_row, n);
			},
			b'M' => {
				let n = seq.param(0, 1) as usize;
				self.active_grid_mut().delete_lines(cur_row, n);
			},
			b'P' => {
				let n = seq.param(0, 1) as usize;
				self.active_grid_mut().delete_chars(cur_row, cur_col, n);
			},
			b'S' => {
				let n = seq.param(0, 1) as usize;
				self.active_grid_mut().scroll_up(n);
			},
			b'T' => {
				let n = seq.param(0, 1) as usize;
				self.active_grid_mut().scroll_down(n);
			},
			b'X' => {
				let n = seq.param(0, 1) as usize;
				self.active_grid_mut().erase_chars(cur_row, cur_col, n);
			},
			b'd' => {
				let r = seq.param(0, 1) as usize;
				self.cursor.row = r.saturating_sub(1).min(rows.saturating_sub(1));
			},
			b'g' => {
				let mode = seq.param(0, 0);
				if mode == 3 {
					self.tab_stops.fill(false);
				} else if mode == 0 && self.cursor.col < self.tab_stops.len() {
					self.tab_stops[self.cursor.col] = false;
				}
			},
			b'm' => self.set_sgr(seq.params),
			b'r' => {
				let top = seq.param(0, 1).saturating_sub(1) as usize;
				let bottom = seq
					.param_opt(1)
					.map_or(rows.saturating_sub(1), |b| b.saturating_sub(1) as usize);
				if top < bottom && bottom < rows {
					self.active_grid_mut().set_scroll_region(top, bottom);
					self.cursor.row = 0;
					self.cursor.col = 0;
				}
			},
			b's' => {
				self.saved_cursor = SavedCursor {
					cursor: self.cursor,
					fg:     self.current_fg,
					bg:     self.current_bg,
					attrs:  self.current_attrs,
				};
			},
			b'u' => {
				self.cursor = self.saved_cursor.cursor;
				self.current_fg = self.saved_cursor.fg;
				self.current_bg = self.saved_cursor.bg;
				self.current_attrs = self.saved_cursor.attrs;
			},
			_ => {},
		}
	}

	fn esc(&mut self, byte: u8) {
		match byte {
			b'7' => {
				self.saved_cursor = SavedCursor {
					cursor: self.cursor,
					fg:     self.current_fg,
					bg:     self.current_bg,
					attrs:  self.current_attrs,
				};
			},
			b'8' => {
				self.cursor = self.saved_cursor.cursor;
				self.current_fg = self.saved_cursor.fg;
				self.current_bg = self.saved_cursor.bg;
				self.current_attrs = self.saved_cursor.attrs;
			},
			b'M' => {
				let top = self.active_grid().scroll_top;
				if self.cursor.row <= top {
					self.active_grid_mut().scroll_down(1);
				} else {
					self.cursor.row = self.cursor.row.saturating_sub(1);
				}
			},
			b'E' => {
				self.cursor.col = 0;
				self.line_feed();
			},
			b'H' => {
				if let Some(stop) = self.tab_stops.get_mut(self.cursor.col) {
					*stop = true;
				}
			},
			b'c' => {
				let (cols, rows) = (self.cols(), self.rows());
				self.primary_grid =
					Grid::new(GridSize::new(cols, rows), self.primary_grid.scrollback_ceiling);
				self.alt_grid = None;
				self.cursor = Cursor::default();
				self.saved_cursor = SavedCursor::default();
				self.alt_saved_cursor = SavedCursor::default();
				self.reset_sgr();
				self.auto_wrap = true;
				self.app_cursor = false;
				self.bracketed_paste = false;
				self.tab_stops.fill(false);
				for c in (0..cols).step_by(8) {
					self.tab_stops[c] = true;
				}
			},
			_ => {},
		}
	}

	fn esc_hash(&mut self, byte: u8) {
		if byte == b'8' {
			let (cols, rows) = (self.cols(), self.rows());
			self.active_grid_mut().reset_scroll_region();
			for r in 0..rows {
				for c in 0..cols {
					if let Some(cell) = self.active_grid_mut().cell_mut(r, c) {
						cell.grapheme.clear();
						cell.grapheme.push('E');
						cell.fg = CellColor::Default;
						cell.bg = CellColor::Default;
						cell.attrs.reset();
						cell.wide = false;
						cell.wide_spacer = false;
					}
				}
			}
			self.cursor.row = 0;
			self.cursor.col = 0;
		}
	}

	fn osc(&mut self, code: u32, data: &str) {
		if matches!(code, 0..=2) {
			self.title = Some(data.to_owned());
		}
	}
}
