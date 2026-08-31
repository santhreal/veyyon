//! Searchable model catalog and exact provider-instance selection.

pub mod logic;
mod view;

pub use view::{picker_content, render, selected_unavailable};
