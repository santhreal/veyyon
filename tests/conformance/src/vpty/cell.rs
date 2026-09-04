//! Terminal cell representation.
//!
//! A cell represents one column position in a terminal grid.
//! It stores a grapheme cluster (not a single `char`), 24-bit RGB foreground
//! and background colors, text styling attributes, and whether it is a
//! continuation cell for a wide character.

use std::fmt;

/// Text styling attributes for a terminal cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Hash)]
pub struct Attributes {
	/// Bold / increased intensity.
	pub bold:          bool,
	/// Dim / faint / decreased intensity.
	pub dim:           bool,
	/// Italicized text.
	pub italic:        bool,
	/// Underlined text.
	pub underline:     bool,
	/// Inverse / reverse video (swap FG and BG).
	pub inverse:       bool,
	/// Strikethrough / crossed out text.
	pub strikethrough: bool,
}

impl Attributes {
	/// Returns an empty attribute set with all flags cleared.
	#[must_use]
	pub const fn none() -> Self {
		Self {
			bold:          false,
			dim:           false,
			italic:        false,
			underline:     false,
			inverse:       false,
			strikethrough: false,
		}
	}

	/// Returns true if no attributes are enabled.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		!self.bold
			&& !self.dim
			&& !self.italic
			&& !self.underline
			&& !self.inverse
			&& !self.strikethrough
	}
}

/// 24-bit RGB color representation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ColorRgb {
	/// Red component (0-255).
	pub r: u8,
	/// Green component (0-255).
	pub g: u8,
	/// Blue component (0-255).
	pub b: u8,
}

impl ColorRgb {
	/// Black (#000000).
	pub const BLACK: Self = Self::new(0, 0, 0);
	/// White (#ffffff).
	pub const WHITE: Self = Self::new(255, 255, 255);

	/// Creates a new RGB color.
	#[must_use]
	pub const fn new(r: u8, g: u8, b: u8) -> Self {
		Self { r, g, b }
	}
}

impl fmt::Display for ColorRgb {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
	}
}

/// Terminal cell content and formatting.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Cell {
	/// Grapheme cluster content. Empty string for continuation cells or blank
	/// cells.
	pub content:         String,
	/// Optional 24-bit RGB foreground color (`None` = default terminal FG).
	pub fg:              Option<ColorRgb>,
	/// Optional 24-bit RGB background color (`None` = default terminal BG).
	pub bg:              Option<ColorRgb>,
	/// Text styling attributes.
	pub attrs:           Attributes,
	/// True if this cell is the trailing / continuation half of a multi-column
	/// glyph.
	pub is_continuation: bool,
}

impl Default for Cell {
	fn default() -> Self {
		Self::blank()
	}
}

impl Cell {
	/// Creates an empty blank cell with default colors and no attributes.
	#[must_use]
	pub const fn blank() -> Self {
		Self {
			content:         String::new(),
			fg:              None,
			bg:              None,
			attrs:           Attributes::none(),
			is_continuation: false,
		}
	}

	/// Creates a continuation cell for a wide character.
	#[must_use]
	pub const fn continuation(
		fg: Option<ColorRgb>,
		bg: Option<ColorRgb>,
		attrs: Attributes,
	) -> Self {
		Self { content: String::new(), fg, bg, attrs, is_continuation: true }
	}

	/// Creates a cell with the given grapheme cluster content, colors, and
	/// attributes.
	#[must_use]
	pub fn with_content(
		content: impl Into<String>,
		fg: Option<ColorRgb>,
		bg: Option<ColorRgb>,
		attrs: Attributes,
	) -> Self {
		Self { content: content.into(), fg, bg, attrs, is_continuation: false }
	}

	/// Clears this cell back to blank with the given default/active background
	/// and attributes.
	pub fn clear(&mut self, bg: Option<ColorRgb>) {
		self.content.clear();
		self.fg = None;
		self.bg = bg;
		self.attrs = Attributes::none();
		self.is_continuation = false;
	}

	/// Returns the displayed character or grapheme cluster string.
	/// If empty and not continuation, represents a space `" "`.
	#[must_use]
	pub fn display_str(&self) -> &str {
		if self.is_continuation {
			""
		} else if self.content.is_empty() {
			" "
		} else {
			&self.content
		}
	}
}
