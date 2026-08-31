//! Anchored popover positioning, dismissal lifecycle, and keyboard focus
//! containment.

pub mod placement;
pub mod state;
pub mod view;

#[cfg(test)]
mod an_anchored_popover_flips_clamps_and_dismisses_on_each_route;

pub use placement::{
	Alignment, PopoverBounds, Side, compute_bounds, default_margin, default_offset,
};
pub use state::{DismissalRoute, OpenPopover, PopoverState};
pub use view::AnchoredPopover;
