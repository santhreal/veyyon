//! Chrome and screens.
//!
//! This crate draws whole surfaces: the transcript, the composer, the status
//! bar, and one page per [`veyyon_gui_contract::Route`]. What a tool result
//! looks like inside a transcript block belongs to `veyyon-gui-views`, and the
//! generic furniture every surface is built from — levels, tokens, one
//! `surface()` — belongs to `veyyon-gui-kit`.
//!
//! Everything here draws a [`veyyon_gui_contract`] value and nothing else. The
//! values come from that crate's fixtures today and from a session over a
//! transport later, and the shell cannot tell the difference: that is what
//! building against the fixtures first is for.

pub mod composer;
pub mod frame;
pub mod page;
pub mod sidebar;
pub mod status;
pub mod terminal;
pub mod transcript;
pub mod window;

pub use frame::{Chrome, Command, command, frame};
pub use window::Shell;
