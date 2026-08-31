//! Terminal byte-stream parsing, escape sequence dispatch, and grid emulation.
//!
//! Pure state machines over terminal bytes without windowing or toolkit
//! dependencies.

pub mod emulator;
pub mod grid;
mod handler;
pub mod parser;
pub mod sequences;
pub mod types;

#[cfg(test)]
mod every_terminal_sequence_maps_to_a_grid_state;

pub use emulator::TerminalEmulator;
pub use grid::{DEFAULT_SCROLLBACK_CEILING, Grid, Line, char_width, is_combining_or_zwj};
pub use parser::{ByteParser, CsiSequence, ParserHandler};
pub use sequences::SequenceKind;
pub use types::{Cell, CellAttributes, CellColor, Cursor, GridSize, SavedCursor};
