//! Registry-driven settings pages over typed core replicas.

mod appearance;
mod context;
pub mod controls;
mod fields;
mod general;
mod keybinding_view;
pub mod keybindings;
pub mod registry;
pub mod remote;
mod schema;
mod view;

pub use registry::{PageRegistration, pages, registration};
pub use view::{SettingsSearch, center, inspector, navigation, render, route_toolbar};
