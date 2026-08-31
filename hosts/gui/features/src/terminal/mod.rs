//! Bottom-dock terminal presentation.
//!
//! Tabs and split topology are frontend state. Process/session payloads are
//! replicas from core, while renderer state is supplied as a long-lived handle
//! so moving the surface between dock and inspector does not remount it.

pub mod adapter;
mod chrome;
pub(crate) mod control;
pub mod frame;
pub mod interaction;
mod logic;
pub mod render;
mod topology;
mod view;

#[cfg(test)]
mod every_terminal_cell_draws_through_the_adapter_palette;

pub use adapter::{
	DamageRect, GridSize, RendererAdapter, RendererDamage, RendererFont, RendererPalette,
	ViewportState, resize_command, write_command,
};
pub use frame::{FrameCoalescer, FrameRequest};
pub use interaction::{SelectionRequest, SelectionRequestGuard};
pub use logic::{ConnectionPresentation, LifecyclePresentation, lifecycle};
pub use render::{RetainedTerminalRenderer, RetainedTerminalSession};
pub use view::render;
