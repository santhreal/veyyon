//! History surface: date/repo grouped browsing, content search, and read-only
//! transcript playback.

pub mod center;
pub mod logic;
pub mod sidebar;
pub mod toolbar;

pub use center::render_center;
pub use sidebar::render_sidebar;
pub use toolbar::render_toolbar;

#[cfg(test)]
mod every_field_of_session_summary_is_rendered_or_opted_out;
#[cfg(test)]
mod history_route_is_reachable_from_every_window_entry_point;
#[cfg(test)]
mod search_distinguishes_full_messages_from_first_message_and_surfaces_unsearchable;
#[cfg(test)]
mod selecting_a_history_row_resumes_session_with_existing_transcript_renderer;
#[cfg(test)]
mod sessions_browse_by_date_and_repository_with_collapsible_groups;
