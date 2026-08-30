//! The one list a reader searches.
//!
//! A sheet over the window with a field at the top and rows under it: the
//! conversations first, then the commands, both reached by typing part of what
//! they are called. What is in the list, in what order, and what taking a row
//! does are [`veyyon_gui_core::palette`]; this draws it.
//!
//! WHY IT DRAWS NOTHING IT DECIDES. The highlighted index and the list are read
//! from one function, so a row cannot be lit at an index the list does not
//! draw. That defect is invisible until somebody presses Return and the wrong
//! thing happens, which is the worst kind: it teaches a reader not to trust the
//! keyboard.

pub mod logic;
pub mod view;

pub use logic::{chord, mark};
pub use view::render;

#[cfg(test)]
mod tests;
