//! Conversation navigation and center-column composition.

mod logic;
mod sessions;
mod state;
mod toolbar;
mod workspace;

pub use sessions::{session_shelf, sync_session_shelf};
pub use state::SessionShelfState;
pub use toolbar::route_toolbar;
pub use workspace::work_surface;

#[cfg(test)]
mod every_control_a_conversation_draws_animates_on_its_own_track;
