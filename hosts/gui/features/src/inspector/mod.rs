//! Route-aware content for the shell-owned Context, Details, and Outline tabs.

mod chrome;
mod context;
mod details;
mod outline;
pub mod state;
mod view;

pub use state::InspectorState;
pub use view::render_content;
