//! Registry-driven settings pages over typed core replicas.

mod appearance;
mod context;
pub mod controls;
mod fields;
mod general;
mod keybinding_view;
pub mod keybindings;
pub mod notifications;
pub mod registry;
pub mod remote;
mod schema;
#[cfg(test)]
mod theme_selection_previews_on_hover_persists_on_press_and_falls_back_when_unknown;
mod view;

pub use registry::{PageRegistration, pages, registration};
pub use view::{SettingsSearch, center, inspector, navigation, render, route_toolbar};
