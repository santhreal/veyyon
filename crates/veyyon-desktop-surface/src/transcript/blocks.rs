//! Individual content block renderers for assistant turns (§5.2, §5.3).
//!
//! Implements the 6 standard chromes (Flow, Reason, Invoke, Artefact, Event,
//! Unknown) with interactive expansion, animated reveal transitions, mono code
//! panes, and streaming carets.

pub mod artifact;
pub mod invoke;
pub mod note;
pub mod pane;
pub mod prose;
pub mod reason;
pub mod reveal;

pub use artifact::*;
pub use invoke::render_invoke_block;
pub use note::render_note_block;
pub use pane::render_pane_block;
pub use prose::render_prose_block;
pub use reason::render_reason_block;
pub use reveal::render_reveal_container;
