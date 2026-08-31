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
pub use chips::context_chips;
pub use logic::PLACEHOLDER;
pub use state::{
	ChipSlot, Control, attachment_control, attachment_owner, completion_owner, control_owner,
};
pub use view::{main_composer, render};

#[cfg(test)]
mod tests;
