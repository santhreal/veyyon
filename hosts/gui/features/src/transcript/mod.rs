//! The conversation.
//!
//! A reading column, not a full-width sprawl: prose at the width of a maximised
//! window is unreadable, and a transcript is mostly prose. The column is
//! centred and capped, and it sits at the bottom of its own scroll so a short
//! conversation begins where the composer is rather than at the top of an empty
//! screen.
//!
//! WHAT IT SAYS WHEN NOTHING ANSWERS. Under the last message, where a reply
//! would be, one line states what the window is attached to. That line is the
//! whole honesty of this surface: nothing draws an answer that was not
//! produced, and a reader can tell at a glance whether silence means detached
//! or thinking. [`logic::tail`] decides which of the four things it says,
//! without a window.

pub mod logic;
pub mod view;

pub use logic::{Opening, Tail, opening, tail};
pub use view::render;

#[cfg(test)]
mod tests;
