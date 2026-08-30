//! Where a message is written.
//!
//! Docked, never floating over the transcript: a field that hovers costs the
//! last line of the conversation to a drop shadow, and the last line is the one
//! being read. It sits on the reading column the transcript uses, so the caret
//! is under the text it follows.
//!
//! ONE ROW, AND TWO THINGS AROUND IT. The field with a send beside it; a notice
//! above it when the store has something to say; a hint under it until there is
//! something to send. Nothing else: an attachment control with nothing behind
//! it is a press that teaches a reader the window is a mock-up.
//!
//! The field itself belongs to the window, because a caret has to outlive a
//! frame. This surface takes it and draws around it.

pub mod logic;
pub mod view;

pub use logic::{PLACEHOLDER, armed, hints, notice};
pub use view::render;

#[cfg(test)]
mod tests;
