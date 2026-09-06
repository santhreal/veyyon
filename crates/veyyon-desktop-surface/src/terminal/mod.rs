//! Pure Rust ANSI / ECMA-48 terminal emulation and cell grid.
//!
//! Provides text styling, cell colour resolution, cursor positioning, erase
//! commands, scrolling regions, OSC titles, private modes, and scrollback
//! retention up to 10,000 rows.

mod cell;
mod csi;
mod grid;
mod ops;
mod parser;
mod selection;
mod sgr;

pub use self::{
	cell::{Cell, CellStyle, Ink, NamedColor},
	grid::{MAX_SCROLLBACK_ROWS, SavedCursor, TerminalGrid},
	parser::TerminalEmulator,
	selection::{SelectionKind, TerminalSelection},
	sgr::apply_sgr,
};
