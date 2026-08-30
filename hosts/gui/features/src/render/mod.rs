//! One renderer per kind of thing a message can carry.
//!
//! Each is a function of parsed content plus the theme, with no state and no
//! store: `core::text` says what the content is, `kit` says what it is drawn
//! with, and the surface above decides where it goes. A new block kind is a new
//! file here and one arm in [`message`], and no existing renderer changes.
//!
//! WHY THESE ARE FUNCTIONS AND NOT COMPONENTS. A renderer draws content that
//! has no state of its own: a paragraph has no hover, a hunk has no press. The
//! controls inside one that do — a copy button on a fenced block, a disclosure
//! on a tool call — are primitives from the kit, which own their own state.

pub mod code;
pub mod diff;
pub mod markdown;
pub mod message;
pub mod tool;

#[cfg(test)]
mod tests;
