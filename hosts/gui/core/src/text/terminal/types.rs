//! Terminal cell, cursor, color, and attribute primitives.

/// Colors a terminal cell can hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub enum CellColor {
	/// Default terminal color (foreground or background).
	#[default]
	Default,
	/// 256-color palette index (0..=15 standard/bright ANSI, 16..=231 color
	/// cube, 232..=255 grayscale).
	Indexed(u8),
	/// 24-bit direct true color.
	Rgb(u8, u8, u8),
}

/// Text rendition flags for a terminal cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct CellAttributes {
	pub bold:          bool,
	pub dim:           bool,
	pub italic:        bool,
	pub underline:     bool,
	pub reverse:       bool,
	pub strikethrough: bool,
	pub hidden:        bool,
}

impl CellAttributes {
	pub const fn is_empty(self) -> bool {
		!self.bold
			&& !self.dim
			&& !self.italic
			&& !self.underline
			&& !self.reverse
			&& !self.strikethrough
			&& !self.hidden
	}

	pub fn reset(&mut self) {
		*self = Self::default();
	}
}

/// A single cell in the terminal grid.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Cell {
	pub grapheme:    String,
	pub fg:          CellColor,
	pub bg:          CellColor,
	pub attrs:       CellAttributes,
	pub wide:        bool,
	pub wide_spacer: bool,
}

impl Default for Cell {
	fn default() -> Self {
		Self {
			grapheme:    String::from(" "),
			fg:          CellColor::Default,
			bg:          CellColor::Default,
			attrs:       CellAttributes::default(),
			wide:        false,
			wide_spacer: false,
		}
	}
}

impl Cell {
	pub fn new(grapheme: impl Into<String>) -> Self {
		Self { grapheme: grapheme.into(), ..Self::default() }
	}

	pub fn blank() -> Self {
		Self::default()
	}

	pub fn is_blank(&self) -> bool {
		(self.grapheme.is_empty() || self.grapheme == " ")
			&& self.fg == CellColor::Default
			&& self.bg == CellColor::Default
			&& self.attrs.is_empty()
			&& !self.wide
			&& !self.wide_spacer
	}

	pub fn reset(&mut self) {
		self.grapheme.clear();
		self.grapheme.push(' ');
		self.fg = CellColor::Default;
		self.bg = CellColor::Default;
		self.attrs.reset();
		self.wide = false;
		self.wide_spacer = false;
	}
}

/// Terminal cursor state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cursor {
	pub row:          usize,
	pub col:          usize,
	pub visible:      bool,
	pub wrap_pending: bool,
}

impl Default for Cursor {
	fn default() -> Self {
		Self { row: 0, col: 0, visible: true, wrap_pending: false }
	}
}

/// Saved cursor position and text rendition state.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SavedCursor {
	pub cursor: Cursor,
	pub fg:     CellColor,
	pub bg:     CellColor,
	pub attrs:  CellAttributes,
}

/// Viewport grid dimensions in characters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GridSize {
	pub cols: usize,
	pub rows: usize,
}

impl GridSize {
	pub fn new(cols: usize, rows: usize) -> Self {
		Self { cols: cols.max(1), rows: rows.max(1) }
	}
}
