//! Contracts of the streaming markdown renderer in
//! `veyyon_desktop_ui::markdown`: the block model a source parses into, the
//! equality of a document built by appended deltas with a full parse of the
//! same source, highlighting onto the palette's syntax roles, and drawing in a
//! window.
//!
//! Not covered: pixel output of a drawn document; the rendering tests assert
//! what the window built and what a click did, not how it looks.

mod blocks;
mod highlighting;
mod rendering;
mod streaming;
mod timing;
