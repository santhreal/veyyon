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

pub mod assistant_text;
pub mod code;
pub mod custom;
pub mod developer_text;
pub mod diff;
pub mod entry;
pub mod entry_meta;
pub mod execution;
pub mod fallback;
pub mod file_mention;
pub mod footer;
pub mod generic_json;
pub mod identity;
pub mod image;
pub mod lifecycle;
pub mod list;
pub mod markdown;
pub mod model_change;
pub mod quote;
pub mod summary;
pub mod table;
pub mod thinking;
pub mod tool;
pub mod unknown;
pub mod user_text;

#[cfg(test)]
mod tests;
