//! Virtualized transcript surface.
//!
//! `Timeline` is a long-lived GPUI handle supplied by the app shell. It retains
//! list measurements, per-session semantic anchors, revision caches, and the
//! end-follow state while `render` remains a function over canonical core data.

pub mod banners;
pub mod logic;
pub mod timeline;
pub mod view;

pub use timeline::Timeline;
pub use view::render;

#[cfg(test)]
mod tests;
