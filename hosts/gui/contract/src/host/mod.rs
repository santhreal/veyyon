//! What the surface a session is drawn on can do.
//!
//! The Rust mirror of the host contract. A session degrades against what it is
//! told rather than against what it assumes, which is the whole reason two
//! hosts can draw the same session: the terminal reports no native scrollback
//! and a window reports one, and neither has to know the other exists.

pub mod capabilities;

pub use capabilities::PresentationCapabilities;
