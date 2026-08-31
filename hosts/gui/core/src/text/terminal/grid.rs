//! Terminal grid buffer, scrollback management, and width reflow.

use std::collections::VecDeque;

use super::types::{Cell, GridSize};

pub const DEFAULT_SCROLLBACK_CEILING: usize = 10_000;

/// Return character display width: 0 for zero-width/combining/ZWJ, 2 for
/// wide/fullwidth/emoji, 1 otherwise.
pub fn char_width(ch: char) -> usize {
	let u = ch as u32;
	if is_combining_or_zwj(ch) {
		return 0;
	}
	if (0x1100..=0x115f).contains(&u)
		|| (0x2329..=0x232a).contains(&u)
		|| (0x2e80..=0x303e).contains(&u)
		|| (0x3040..=0xa4cf).contains(&u)
		|| (0xac00..=0xd7a3).contains(&u)
		|| (0xf900..=0xfaff).contains(&u)
		|| (0xfe10..=0xfe19).contains(&u)
		|| (0xfe30..=0xfe6f).contains(&u)
		|| (0xff00..=0xff60).contains(&u)
		|| (0xffe0..=0xffe6).contains(&u)
		|| (0x1f300..=0x1f64f).contains(&u)
		|| (0x1f680..=0x1f6ff).contains(&u)
		|| (0x1f900..=0x1f9ff).contains(&u)
		|| (0x20000..=0x3fffd).contains(&u)
	{
		2
	} else {
		1
	}
}

pub fn is_combining_or_zwj(ch: char) -> bool {
	let u = ch as u32;
	u == 0x200d
		|| (0x200b..=0x200f).contains(&u)
		|| (0x0300..=0x036f).contains(&u)
		|| (0x1ab0..=0x1aff).contains(&u)
		|| (0x1dc0..=0x1dff).contains(&u)
		|| (0x20d0..=0x20ff).contains(&u)
		|| (0xfe20..=0xfe2f).contains(&u)
		|| (0xfe00..=0xfe0f).contains(&u)
		|| (0xe0100..=0xe01ef).contains(&u)
}

/// One physical row in the terminal grid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
	pub cells:   Vec<Cell>,
	pub wrapped: bool,
}

impl Line {
	pub fn new(cols: usize) -> Self {
		Self { cells: vec![Cell::default(); cols], wrapped: false }
	}

	pub fn clear(&mut self) {
		for cell in &mut self.cells {
			cell.reset();
		}
		self.wrapped = false;
	}

	pub fn resize(&mut self, new_cols: usize) {
		self.cells.resize_with(new_cols, Cell::default);
	}

	pub fn is_empty(&self) -> bool {
		self.cells.iter().all(Cell::is_blank)
	}

	pub fn trim_len(&self) -> usize {
		self
			.cells
			.iter()
			.rposition(|c| !c.is_blank())
			.map_or(0, |idx| idx + 1)
	}
}

/// Terminal screen grid, scroll region, and scrollback history.
#[derive(Debug, Clone)]
pub struct Grid {
	pub size:               GridSize,
	pub lines:              Vec<Line>,
	pub scroll_top:         usize,
	pub scroll_bottom:      usize,
	pub scrollback:         VecDeque<Line>,
	pub scrollback_ceiling: usize,
	pub total_lines:        usize,
}

impl Grid {
	pub fn new(size: GridSize, scrollback_ceiling: usize) -> Self {
		let rows = size.rows;
		let cols = size.cols;
		let lines = (0..rows).map(|_| Line::new(cols)).collect();
		Self {
			size,
			lines,
			scroll_top: 0,
			scroll_bottom: rows.saturating_sub(1),
			scrollback: VecDeque::new(),
			scrollback_ceiling,
			total_lines: rows,
		}
	}

	pub fn cell(&self, row: usize, col: usize) -> Option<&Cell> {
		self.lines.get(row).and_then(|line| line.cells.get(col))
	}

	pub fn cell_mut(&mut self, row: usize, col: usize) -> Option<&mut Cell> {
		self
			.lines
			.get_mut(row)
			.and_then(|line| line.cells.get_mut(col))
	}

	pub fn set_scroll_region(&mut self, top: usize, bottom: usize) {
		if top < bottom && bottom < self.size.rows {
			self.scroll_top = top;
			self.scroll_bottom = bottom;
		}
	}

	pub fn reset_scroll_region(&mut self) {
		self.scroll_top = 0;
		self.scroll_bottom = self.size.rows.saturating_sub(1);
	}

	pub fn scroll_up(&mut self, count: usize) {
		let count = count.min(self.scroll_bottom - self.scroll_top + 1);
		if count == 0 {
			return;
		}
		let is_full_screen = self.scroll_top == 0 && self.scroll_bottom == self.size.rows - 1;
		for r in self.scroll_top..self.scroll_top + count {
			if is_full_screen {
				if self.scrollback.len() >= self.scrollback_ceiling {
					self.scrollback.pop_front();
				}
				self.scrollback.push_back(self.lines[r].clone());
				self.total_lines = self.total_lines.saturating_add(1);
			}
		}
		for r in self.scroll_top..=self.scroll_bottom.saturating_sub(count) {
			self.lines[r] = self.lines[r + count].clone();
		}
		for r in (self.scroll_bottom + 1).saturating_sub(count)..=self.scroll_bottom {
			self.lines[r] = Line::new(self.size.cols);
		}
	}

	pub fn scroll_down(&mut self, count: usize) {
		let count = count.min(self.scroll_bottom - self.scroll_top + 1);
		if count == 0 {
			return;
		}
		for r in (self.scroll_top + count..=self.scroll_bottom).rev() {
			self.lines[r] = self.lines[r - count].clone();
		}
		for r in self.scroll_top..self.scroll_top + count {
			self.lines[r] = Line::new(self.size.cols);
		}
	}

	pub fn insert_lines(&mut self, row: usize, count: usize) {
		if row < self.scroll_top || row > self.scroll_bottom {
			return;
		}
		let count = count.min(self.scroll_bottom - row + 1);
		for r in (row + count..=self.scroll_bottom).rev() {
			self.lines[r] = self.lines[r - count].clone();
		}
		for r in row..row + count {
			self.lines[r] = Line::new(self.size.cols);
		}
	}

	pub fn delete_lines(&mut self, row: usize, count: usize) {
		if row < self.scroll_top || row > self.scroll_bottom {
			return;
		}
		let count = count.min(self.scroll_bottom - row + 1);
		for r in row..=self.scroll_bottom.saturating_sub(count) {
			self.lines[r] = self.lines[r + count].clone();
		}
		for r in (self.scroll_bottom + 1).saturating_sub(count)..=self.scroll_bottom {
			self.lines[r] = Line::new(self.size.cols);
		}
	}

	pub fn insert_chars(&mut self, row: usize, col: usize, count: usize) {
		if let Some(line) = self.lines.get_mut(row) {
			let count = count.min(line.cells.len().saturating_sub(col));
			for c in (col + count..line.cells.len()).rev() {
				line.cells[c] = line.cells[c - count].clone();
			}
			for c in col..col + count {
				line.cells[c].reset();
			}
		}
	}

	pub fn delete_chars(&mut self, row: usize, col: usize, count: usize) {
		if let Some(line) = self.lines.get_mut(row) {
			let count = count.min(line.cells.len().saturating_sub(col));
			for c in col..line.cells.len().saturating_sub(count) {
				line.cells[c] = line.cells[c + count].clone();
			}
			for c in (line.cells.len().saturating_sub(count))..line.cells.len() {
				line.cells[c].reset();
			}
		}
	}

	pub fn erase_in_line(&mut self, row: usize, col: usize, mode: u32) {
		if let Some(line) = self.lines.get_mut(row) {
			match mode {
				0 => {
					let len = line.cells.len();
					for cell in &mut line.cells[col.min(len)..] {
						cell.reset();
					}
				},
				1 => {
					let end = (col + 1).min(line.cells.len());
					for cell in &mut line.cells[..end] {
						cell.reset();
					}
				},
				2 => line.clear(),
				_ => {},
			}
		}
	}

	pub fn erase_in_display(&mut self, row: usize, col: usize, mode: u32) {
		match mode {
			0 => {
				self.erase_in_line(row, col, 0);
				for r in (row + 1)..self.size.rows {
					self.lines[r].clear();
				}
			},
			1 => {
				for r in 0..row {
					self.lines[r].clear();
				}
				self.erase_in_line(row, col, 1);
			},
			2 => {
				for line in &mut self.lines {
					line.clear();
				}
			},
			3 => {
				for line in &mut self.lines {
					line.clear();
				}
				self.scrollback.clear();
			},
			_ => {},
		}
	}

	pub fn erase_chars(&mut self, row: usize, col: usize, count: usize) {
		if let Some(line) = self.lines.get_mut(row) {
			let end = (col + count).min(line.cells.len());
			for cell in &mut line.cells[col..end] {
				cell.reset();
			}
		}
	}

	pub fn reflow(&mut self, new_size: GridSize) {
		if self.size == new_size {
			return;
		}
		let mut logical_lines: Vec<Vec<Cell>> = Vec::new();
		let mut current_logical: Vec<Cell> = Vec::new();

		let all_physical = self.scrollback.iter().chain(self.lines.iter());
		for line in all_physical {
			let trimmed_len = if line.wrapped {
				line.cells.len()
			} else {
				line.trim_len()
			};
			current_logical.extend_from_slice(&line.cells[..trimmed_len]);
			if !line.wrapped {
				logical_lines.push(std::mem::take(&mut current_logical));
			}
		}
		if !current_logical.is_empty() {
			logical_lines.push(current_logical);
		}

		let mut rewrapped: Vec<Line> = Vec::new();
		for log_line in logical_lines {
			if log_line.is_empty() {
				rewrapped.push(Line::new(new_size.cols));
				continue;
			}
			let mut idx = 0;
			while idx < log_line.len() {
				let mut line = Line::new(new_size.cols);
				let mut col = 0;
				while idx < log_line.len() && col < new_size.cols {
					let cell = &log_line[idx];
					if cell.wide && col + 1 >= new_size.cols {
						break;
					}
					line.cells[col] = cell.clone();
					if cell.wide {
						col += 1;
						if col < new_size.cols {
							line.cells[col] = Cell { wide_spacer: true, ..Cell::default() };
						}
					}
					col += 1;
					idx += 1;
				}
				if idx < log_line.len() {
					line.wrapped = true;
				}
				rewrapped.push(line);
			}
		}

		self.size = new_size;
		self.scroll_top = 0;
		self.scroll_bottom = new_size.rows.saturating_sub(1);

		if rewrapped.len() <= new_size.rows {
			self.scrollback.clear();
			self.lines = rewrapped;
			while self.lines.len() < new_size.rows {
				self.lines.push(Line::new(new_size.cols));
			}
		} else {
			let split_at = rewrapped.len() - new_size.rows;
			let screen = rewrapped.split_off(split_at);
			self.lines = screen;
			let mut sb: VecDeque<Line> = rewrapped.into();
			while sb.len() > self.scrollback_ceiling {
				sb.pop_front();
			}
			self.scrollback = sb;
		}
	}
}
