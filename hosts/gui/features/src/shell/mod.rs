//! Stable desktop shell composition.
//!
//! Feature state remains in core and retained gpui handles remain in app. This
//! module places the elements those handles render into, so a breakpoint
//! changes presentation without replacing an editor, scroll viewport, panel, or
//! terminal.

mod activity_rail;
mod compositor;
mod hosts;
mod layout;
mod navigation;
mod slots;
mod status;
mod titlebar;
mod toolbar;

pub use compositor::{FrameSlots, render_body};
pub use layout::{
	LayoutPlan, PanelSizes, Placement, bottom_height, inspector_width, sidebar_width,
};
pub use navigation::escape_command;
pub use slots::{SurfaceRefs, compose};
pub use titlebar::render as titlebar;

#[cfg(test)]
mod a_closing_panel_keeps_its_place_until_it_has_no_width;
