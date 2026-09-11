//! Text the host produced, turned into something a surface can draw.
//!
//! A host writes bytes, not cells: a terminal's output carries its own
//! control language, and reading it is domain work with no window in it. The
//! modules here hold that reading, so the same grid is available to a
//! projection, a test and an export without a renderer.

pub mod markdown;
pub mod terminal;
