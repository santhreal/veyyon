//! Per-session editor, context, decisions, and runtime controls.

mod banners;
mod chips;
mod completion;
mod completions;
mod controls;
mod logic;
mod state;
mod view;

pub use banners::pending_context;
pub use chips::{context_chips, sync_composer_state};
pub use logic::PLACEHOLDER;
pub use state::ComposerState;
pub use view::{main_composer, render};

#[cfg(test)]
mod tests;
