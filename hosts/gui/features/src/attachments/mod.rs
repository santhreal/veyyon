//! Attachment preview surfaces, size and type formatting, and removal controls.

pub mod preview;
pub mod state;
pub mod strip;

pub use preview::render_attachment_preview;
pub use strip::attachment_strip;

#[cfg(test)]
mod a_refused_attachment_states_its_reason_and_cannot_be_submitted;
#[cfg(test)]
mod composer_attachment_lifecycle_drives_staging_retry_and_submission;
#[cfg(test)]
mod every_attachment_kind_has_a_bounded_preview_and_reports_type_and_size;
