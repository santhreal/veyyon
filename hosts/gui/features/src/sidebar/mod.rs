//! The conversation list, which is also the navigation.
//!
//! There is no tab strip. A conversation is reached from this list and the
//! content header names the one that is open, because a tab strip and a list
//! are two controls for one choice.
//!
//! HOW A ROW READS. A title, and under it the last thing said in that
//! conversation. No glyph column, no counter, no badge: the list is a column of
//! names, and a name is what the reader is looking for. A row recedes by
//! default and lifts under the pointer, where it also offers the one
//! destructive thing it can do, so nothing is offered until it is asked for.
//!
//! The order is most recently touched first.
//!
//! WHERE SETTINGS IS. The last row of this column, where a preferences entry
//! sits in every application with a sidebar. It is also a chord and a palette
//! command; three ways in, one of which is visible without knowing anything.

pub mod logic;
mod view;

pub use view::{render, selected_child};

#[cfg(test)]
mod tests;
