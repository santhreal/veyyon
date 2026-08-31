//! Terminal emulator wrapping byte parsing, grid mutations, and text rendition.

use super::{
	grid::{DEFAULT_SCROLLBACK_CEILING, Grid, Line},
	parser::ByteParser,
	types::{Cell, CellAttributes, CellColor, Cursor, GridSize, SavedCursor},
};

/// Pure terminal state machine folding bytes into a renderable cell grid.
#[derive(Debug, Clone)]
pub struct TerminalEmulator {
	pub(crate) parser:            ByteParser,
	pub(crate) primary_grid:      Grid,
	pub(crate) alt_grid:          Option<Grid>,
	pub(crate) cursor:            Cursor,
	pub(crate) saved_cursor:      SavedCursor,
	pub(crate) alt_saved_cursor:  SavedCursor,
	pub(crate) current_fg:        CellColor,
	pub(crate) current_bg:        CellColor,
	pub(crate) current_attrs:     CellAttributes,
	pub(crate) auto_wrap:         bool,
	pub(crate) app_cursor:        bool,
	pub(crate) bracketed_paste:   bool,
	pub(crate) tab_stops:         Vec<bool>,
	pub(crate) title:             Option<String>,
	pub(crate) bell:              bool,
	pub(crate) scrollback_offset: usize,
}

impl TerminalEmulator {
	pub fn new(cols: usize, rows: usize) -> Self {
		Self::with_ceiling(cols, rows, DEFAULT_SCROLLBACK_CEILING)
	}

	pub fn with_ceiling(cols: usize, rows: usize, scrollback_ceiling: usize) -> Self {
		let size = GridSize::new(cols, rows);
		let mut tab_stops = vec![false; size.cols];
		for c in (0..size.cols).step_by(8) {
			tab_stops[c] = true;
		}
		Self {
			parser: ByteParser::new(),
			primary_grid: Grid::new(size, scrollback_ceiling),
			alt_grid: None,
			cursor: Cursor::default(),
			saved_cursor: SavedCursor::default(),
			alt_saved_cursor: SavedCursor::default(),
			current_fg: CellColor::Default,
			current_bg: CellColor::Default,
			current_attrs: CellAttributes::default(),
			auto_wrap: true,
			app_cursor: false,
			bracketed_paste: false,
			tab_stops,
			title: None,
			bell: false,
			scrollback_offset: 0,
		}
	}

	pub fn feed(&mut self, bytes: &[u8]) {
		let mut parser = std::mem::take(&mut self.parser);
		parser.advance(bytes, self);
		self.parser = parser;
	}

	pub fn resize(&mut self, cols: usize, rows: usize) {
		let new_size = GridSize::new(cols, rows);
		self.primary_grid.reflow(new_size);
		if let Some(alt) = &mut self.alt_grid {
			alt.reflow(new_size);
		}
		self.cursor.row = self.cursor.row.min(new_size.rows.saturating_sub(1));
		self.cursor.col = self.cursor.col.min(new_size.cols.saturating_sub(1));
		self.tab_stops.resize(new_size.cols, false);
		for c in (0..new_size.cols).step_by(8) {
			self.tab_stops[c] = true;
		}
	}

	pub fn cols(&self) -> usize {
		self.active_grid().size.cols
	}

	pub fn rows(&self) -> usize {
		self.active_grid().size.rows
	}

	pub fn cursor(&self) -> Cursor {
		self.cursor
	}

	pub fn is_alt_screen(&self) -> bool {
		self.alt_grid.is_some()
	}

	pub fn title(&self) -> Option<&str> {
		self.title.as_deref()
	}

	pub fn take_bell(&mut self) -> bool {
		std::mem::take(&mut self.bell)
	}

	pub fn history_lines(&self) -> usize {
		self.active_grid().scrollback.len()
	}

	pub fn total_lines(&self) -> usize {
		self.active_grid().total_lines
	}

	pub fn scrollback_offset(&self) -> usize {
		self.scrollback_offset
	}

	pub fn scroll(&mut self, delta: i32) {
		let max_offset = self.history_lines();
		let target =
			(self.scrollback_offset as i64 + delta as i64).clamp(0, max_offset as i64) as usize;
		self.scrollback_offset = target;
	}

	pub fn scroll_to_bottom(&mut self) {
		self.scrollback_offset = 0;
	}

	pub fn scroll_to_offset(&mut self, offset: usize) {
		self.scrollback_offset = offset.min(self.history_lines());
	}

	pub fn line(&self, viewport_row: usize) -> Option<&Line> {
		let grid = self.active_grid();
		if viewport_row >= grid.size.rows {
			return None;
		}
		if self.scrollback_offset == 0 {
			grid.lines.get(viewport_row)
		} else {
			let history_len = grid.scrollback.len();
			if self.scrollback_offset <= history_len {
				let scroll_idx = history_len - self.scrollback_offset + viewport_row;
				if scroll_idx < history_len {
					grid.scrollback.get(scroll_idx)
				} else {
					grid.lines.get(scroll_idx - history_len)
				}
			} else {
				grid.lines.get(viewport_row)
			}
		}
	}

	pub fn cell(&self, viewport_row: usize, col: usize) -> Option<&Cell> {
		self.line(viewport_row).and_then(|line| line.cells.get(col))
	}

	pub(crate) fn active_grid(&self) -> &Grid {
		self.alt_grid.as_ref().unwrap_or(&self.primary_grid)
	}

	pub(crate) fn active_grid_mut(&mut self) -> &mut Grid {
		self.alt_grid.as_mut().unwrap_or(&mut self.primary_grid)
	}

	pub(crate) fn line_feed(&mut self) {
		self.cursor.wrap_pending = false;
		let bottom = self.active_grid().scroll_bottom;
		if self.cursor.row >= bottom {
			self.active_grid_mut().scroll_up(1);
		} else {
			self.cursor.row += 1;
		}
	}

	pub(crate) fn set_sgr(&mut self, params: &[Option<u32>]) {
		if params.is_empty() {
			self.reset_sgr();
			return;
		}
		let mut i = 0;
		while i < params.len() {
			let p = params[i].unwrap_or(0);
			match p {
				0 => self.reset_sgr(),
				1 => self.current_attrs.bold = true,
				2 => self.current_attrs.dim = true,
				3 => self.current_attrs.italic = true,
				4 => self.current_attrs.underline = true,
				7 => self.current_attrs.reverse = true,
				8 => self.current_attrs.hidden = true,
				9 => self.current_attrs.strikethrough = true,
				21 => self.current_attrs.bold = false,
				22 => {
					self.current_attrs.bold = false;
					self.current_attrs.dim = false;
				},
				23 => self.current_attrs.italic = false,
				24 => self.current_attrs.underline = false,
				27 => self.current_attrs.reverse = false,
				28 => self.current_attrs.hidden = false,
				29 => self.current_attrs.strikethrough = false,
				30..=37 => self.current_fg = CellColor::Indexed((p - 30) as u8),
				38 => {
					if let Some(color) = parse_extended_color(params, &mut i) {
						self.current_fg = color;
					}
				},
				39 => self.current_fg = CellColor::Default,
				40..=47 => self.current_bg = CellColor::Indexed((p - 40) as u8),
				48 => {
					if let Some(color) = parse_extended_color(params, &mut i) {
						self.current_bg = color;
					}
				},
				49 => self.current_bg = CellColor::Default,
				90..=97 => self.current_fg = CellColor::Indexed((p - 90 + 8) as u8),
				100..=107 => self.current_bg = CellColor::Indexed((p - 100 + 8) as u8),
				_ => {},
			}
			i += 1;
		}
	}

	pub(crate) fn reset_sgr(&mut self) {
		self.current_fg = CellColor::Default;
		self.current_bg = CellColor::Default;
		self.current_attrs.reset();
	}
}

fn parse_extended_color(params: &[Option<u32>], idx: &mut usize) -> Option<CellColor> {
	if *idx + 1 >= params.len() {
		return None;
	}
	*idx += 1;
	match params[*idx].unwrap_or(0) {
		5 => {
			if *idx + 1 < params.len() {
				*idx += 1;
				Some(CellColor::Indexed(params[*idx].unwrap_or(0) as u8))
			} else {
				None
			}
		},
		2 => {
			if *idx + 3 < params.len() {
				let r = params[*idx + 1].unwrap_or(0) as u8;
				let g = params[*idx + 2].unwrap_or(0) as u8;
				let b = params[*idx + 3].unwrap_or(0) as u8;
				*idx += 3;
				Some(CellColor::Rgb(r, g, b))
			} else {
				None
			}
		},
		_ => None,
	}
}
