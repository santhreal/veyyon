//! Floating notification stack and toast presentation.
//!
//! Renders queued core notifications into a bottom-trailing stack of animated
//! toasts, enforcing bounded visibility and per-control motion tracks.

pub mod owners;
pub mod view;

#[cfg(test)]
mod tests;

pub use owners::{StackChrome, stack_control, toast_control, toast_owner};
pub use view::{MAX_VISIBLE_TOASTS, render, tone_of};
