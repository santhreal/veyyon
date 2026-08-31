//! Surfaces for tab strips and space navigation.

mod space_switcher;
mod tab_strip;

#[cfg(test)]
mod the_tab_strip_reorders_and_closes_tabs;

pub use space_switcher::*;
pub use tab_strip::*;
