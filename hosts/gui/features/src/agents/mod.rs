//! Agent hierarchy, selected-agent activity, transcript paging, and lifecycle
//! controls.

pub mod chat;
mod chrome;
mod detail;
pub(crate) mod format;
pub mod logic;
pub mod state;
pub mod transcript;
pub mod tree;
mod view;

pub use state::AgentsState;
pub use view::render;
