//! Multi-mode search and navigation overlays.
//!
//! Core supplies authoritative replicas and frontend query/cursor state. This
//! module projects grouped rows and dispatches only `UiCommand` values.

pub mod highlight;
pub mod state;
pub mod view;
pub use view::{render, selected_child, selected_commands};

#[cfg(test)]
mod tests;
