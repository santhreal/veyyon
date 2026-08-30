//! Settings.
//!
//! A page in the window rather than a modal dialog: a dialog over a
//! conversation makes a reader lose their place to change a text size, and
//! every setting here changes something they can see behind it.
//!
//! TWO PAGES, AND ONE WAY TO ADD A THIRD. The nav is built from
//! [`SettingsPage::ALL`](veyyon_gui_core::store::model::SettingsPage::ALL), so
//! a page added there appears in the nav, in the palette and on a chord without
//! this file changing shape. A page is one function returning a stack of
//! [`Field`](veyyon_gui_kit::ui::Field)s inside
//! [`Group`](veyyon_gui_kit::ui::Group)s, and nothing else.
//!
//! EVERY CONTROL DISPATCHES A COMMAND. There is no setter here and no store
//! mutation: the switch, the stepper and the appearance control all hand back a
//! [`Command`](veyyon_gui_core::command::Command), which is what makes each of
//! them reachable from the palette and from a key as well.

pub mod keyboard;
pub mod logic;
pub mod view;

pub use logic::{Nav, nav};
pub use view::render;

#[cfg(test)]
mod tests;
