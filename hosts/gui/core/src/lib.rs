//! The front end's decisions, with no toolkit under them.
//!
//! Everything a window would have to be open to test is somewhere else. What is
//! here is the store, every move over it, and the analysis of the text a
//! message carries. The crate compiles without a GPU, a display or a font, and
//! its suites run in milliseconds.
//!
//! A dependency on gpui in this crate is a defect. The layering that keeps that
//! true is `hosts/gui/ARCHITECTURE.md`.

pub mod command;
pub mod keys;
pub mod palette;
pub mod store;
pub mod text;
