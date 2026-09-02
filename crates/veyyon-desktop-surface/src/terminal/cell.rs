//! Terminal cell, colour, and style representations.
//!
//! Cells are the atomic render unit of the terminal grid. Every cell holds a
//! character, foreground and background colours, style flags, and a column
//! width (1 for standard characters, 2 for wide glyphs, and 0 for wide
//! continuation cells).

/// The sixteen standard ANSI terminal colours.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum NamedColor {
	#[default]
	Black,
	Red,
	Green,
	Yellow,
	Blue,
	Magenta,
	Cyan,
	White,
	BrightBlack,
	BrightRed,
	BrightGreen,
	BrightYellow,
	BrightBlue,
	BrightMagenta,
	BrightCyan,
	BrightWhite,
}

impl NamedColor {
	/// Returns the named colour corresponding to an ANSI colour index (0..=15).
	#[must_use]
	pub const fn from_index(index: u8) -> Option<Self> {
		match index {
			0 => Some(Self::Black),
			1 => Some(Self::Red),
			2 => Some(Self::Green),
			3 => Some(Self::Yellow),
			4 => Some(Self::Blue),
			5 => Some(Self::Magenta),
			6 => Some(Self::Cyan),
			7 => Some(Self::White),
			8 => Some(Self::BrightBlack),
			9 => Some(Self::BrightRed),
			10 => Some(Self::BrightGreen),
			11 => Some(Self::BrightYellow),
			12 => Some(Self::BrightBlue),
			13 => Some(Self::BrightMagenta),
			14 => Some(Self::BrightCyan),
			15 => Some(Self::BrightWhite),
			_ => None,
		}
	}

	/// Returns the 0..=15 index of this named colour.
	#[must_use]
	pub const fn index(self) -> u8 {
		match self {
			Self::Black => 0,
			Self::Red => 1,
			Self::Green => 2,
			Self::Yellow => 3,
			Self::Blue => 4,
			Self::Magenta => 5,
			Self::Cyan => 6,
			Self::White => 7,
			Self::BrightBlack => 8,
			Self::BrightRed => 9,
			Self::BrightGreen => 10,
			Self::BrightYellow => 11,
			Self::BrightBlue => 12,
			Self::BrightMagenta => 13,
			Self::BrightCyan => 14,
			Self::BrightWhite => 15,
		}
	}
}

/// The colour value of a terminal cell foreground or background.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Ink {
	/// Default terminal foreground or background colour from the theme.
	#[default]
	Default,
	/// One of the 16 standard ANSI colours.
	Named(NamedColor),
	/// 256-colour palette index (0..=255).
	Indexed(u8),
	/// Direct 24-bit RGB truecolour.
	Rgb(u8, u8, u8),
}

/// Character styling attributes for a terminal cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct CellStyle {
	/// Bold weight.
	pub bold:      bool,
	/// Faint or dim intensity.
	pub dim:       bool,
	/// Italic font style.
	pub italic:    bool,
	/// Underlined text.
	pub underline: bool,
	/// Blinking text.
	pub blink:     bool,
	/// Inverted foreground and background colours.
	pub inverse:   bool,
	/// Hidden (concealed) text.
	pub hidden:    bool,
	/// Strikethrough text.
	pub strike:    bool,
}

impl CellStyle {
	/// Constructs a default style with all attributes cleared.
	#[must_use]
	pub const fn new() -> Self {
		Self {
			bold:      false,
			dim:       false,
			italic:    false,
			underline: false,
			blink:     false,
			inverse:   false,
			hidden:    false,
			strike:    false,
		}
	}

	/// Returns true when all styling attributes are false.
	#[must_use]
	pub const fn is_default(&self) -> bool {
		!self.bold
			&& !self.dim
			&& !self.italic
			&& !self.underline
			&& !self.blink
			&& !self.inverse
			&& !self.hidden
			&& !self.strike
	}

	/// Clears all style flags back to default.
	pub const fn reset(&mut self) {
		*self = Self::new();
	}
}

/// One cell in the terminal grid.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Cell {
	/// The character displayed in this cell.
	pub c:      char,
	/// Foreground colour ink.
	pub ink:    Ink,
	/// Background colour ink.
	pub bg_ink: Ink,
	/// Active text styling.
	pub style:  CellStyle,
	/// Display width in terminal columns (1 for normal, 2 for wide leading, 0
	/// for wide continuation).
	pub width:  u8,
}

impl Default for Cell {
	fn default() -> Self {
		Self::blank()
	}
}

impl Cell {
	/// A blank empty cell.
	pub const BLANK: Self = Self {
		c:      ' ',
		ink:    Ink::Default,
		bg_ink: Ink::Default,
		style:  CellStyle::new(),
		width:  1,
	};

	/// Returns a new blank cell.
	#[must_use]
	pub const fn blank() -> Self {
		Self::BLANK
	}

	/// Returns true if the cell contains an unstyled space character.
	#[must_use]
	pub const fn is_blank(&self) -> bool {
		self.c == ' '
			&& matches!(self.ink, Ink::Default)
			&& matches!(self.bg_ink, Ink::Default)
			&& self.style.is_default()
			&& self.width == 1
	}

	/// Resets the cell to blank state.
	pub const fn reset(&mut self) {
		*self = Self::blank();
	}
}
