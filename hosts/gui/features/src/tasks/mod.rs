//! Phase progress and task lifecycle dashboard.

mod chrome;
pub mod logic;
pub mod state;
mod view;

pub use state::TasksState;
pub use view::{next_elapsed_deadline, render};
