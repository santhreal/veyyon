//! Source-control changes route, changed-files navigation, diff viewport, and
//! review context.

mod cache;
mod inspector;
mod lines;
mod logic;
mod owners;
mod paint;
mod rows;
mod sidebar;
mod tree;
mod view;
mod viewport;

pub use cache::ChangesCache;
pub use inspector::render as render_inspector;
pub use sidebar::render as render_sidebar;
pub use tree::{TreeRow, TreeRows};
pub use view::{render, render_center, render_toolbar};
pub use viewport::DiffViewport;

#[cfg(test)]
mod every_object_the_changes_route_draws_animates_on_its_own_track;
