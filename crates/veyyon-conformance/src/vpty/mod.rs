//! Virtual PTY (`vpty`): VT100/xterm escape-sequence parser and 2D cell grid.
//!
//! Owned by the `vpty` module; see
//! `docs/internal/whole-product-rust-conformance.md` section "1. Virtual PTY
//! (`vpty`)", "Terminal Dimensions and Geometry Matrix", and "Unicode, Width,
//! and Typography Assertions".
//!
//! # Architecture
//!
//! - [`Cell`]: Codepoint content (grapheme cluster), 24-bit RGB colors,
//!   formatting attributes, and continuation status for wide characters.
//! - [`Grid`]: 2D addressable cell grid with dimensions `20x5..=400x120`,
//!   scroll regions, cursor positioning, and deferred wrap state.
//! - [`Parser`]: ANSI X3.64 / VT100 / xterm stream parser consuming CSI, OSC,
//!   and C0 controls. Malformed or unknown escape sequences are safely consumed
//!   into a record log rather than corrupting the grid.
//! - [`Input`]: Real-terminal input injection encoding for named keys,
//!   modifiers, bracketed paste, SGR 1006 mouse events, and signal keys
//!   (`Ctrl+C`, `Ctrl+D`).
//! - [`Assert`]: Deterministic inspection, row/region extraction, style
//!   queries, and grid diffing.
//!
//! # Omissions and Stated Limits
//!
//! - **No Process Spawning / `ConPTY` / PTY OS Handles**: This virtual module
//!   provides pure in-memory emulation for headless rendering and parser
//!   verification without OS PTY dependencies.
//! - **No SIGWINCH Delivery**: Resizing is invoked explicitly via
//!   [`Grid::resize`]. Virtual PTY does not deliver OS signals (`SIGWINCH` on
//!   POSIX or `ConPTY` resize calls on Windows), as tests drive geometry
//!   transitions deterministically in-process.
//! - **No Software Rasterization to PNG**: Dual-ground raster proofs (`#1e2127`
//!   and `#000000`) are owned by the companion `render` lane.

pub mod assertions;
pub mod cell;
pub mod grid;
pub mod input;
pub mod parser;

pub use assertions::{Assert, Region, StyleInfo};
pub use cell::{Attributes, Cell, ColorRgb};
pub use grid::{
	CursorPos, DimensionError, Grid, MAX_COLS, MAX_ROWS, MIN_COLS, MIN_ROWS, ScrollRegion,
};
pub use input::{Input, Key, Modifiers, MouseButton, MouseEvent, MouseEventKind};
pub use parser::{
	CsiAction, MalformedSequence, Parser, SgrEffect, color_256_to_rgb, csi_action, sgr_effect,
};

/// High-level Virtual Terminal bundling a [`Grid`] and [`Parser`].
#[derive(Debug, Clone)]
pub struct Terminal {
	grid:   Grid,
	parser: Parser,
}

impl Terminal {
	/// Creates a new virtual terminal with the specified column and row
	/// dimensions.
	///
	/// Returns `Err(DimensionError)` if dimensions fall outside
	/// `20x5..=400x120`.
	pub fn new(cols: usize, rows: usize) -> Result<Self, DimensionError> {
		let grid = Grid::new(cols, rows)?;
		let parser = Parser::new();
		Ok(Self { grid, parser })
	}

	/// Returns a reference to the underlying grid.
	#[must_use]
	pub const fn grid(&self) -> &Grid {
		&self.grid
	}

	/// Returns a mutable reference to the underlying grid.
	pub const fn grid_mut(&mut self) -> &mut Grid {
		&mut self.grid
	}

	/// Returns a reference to the parser.
	#[must_use]
	pub const fn parser(&self) -> &Parser {
		&self.parser
	}

	/// Returns a mutable reference to the parser.
	pub const fn parser_mut(&mut self) -> &mut Parser {
		&mut self.parser
	}

	/// Feeds terminal output text into the parser and updates the grid.
	pub fn write_str(&mut self, text: &str) {
		self.parser.parse_str(text, &mut self.grid);
	}

	/// Feeds raw terminal output bytes into the parser and updates the grid.
	pub fn write_bytes(&mut self, bytes: &[u8]) {
		self.parser.parse_bytes(bytes, &mut self.grid);
	}

	/// Resizes the terminal grid.
	pub fn resize(&mut self, cols: usize, rows: usize) -> Result<(), DimensionError> {
		self.grid.resize(cols, rows)
	}

	/// Convenience helper: extracts the displayed text of a row.
	#[must_use]
	pub fn row_text(&self, row: usize) -> String {
		Assert::row_text(&self.grid, row)
	}

	/// Convenience helper: returns a stable full-grid snapshot for diffing.
	#[must_use]
	pub fn snapshot(&self) -> String {
		Assert::grid_snapshot(&self.grid)
	}
}

#[cfg(test)]
mod tests;
