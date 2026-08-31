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
mod topology;
mod view;

pub use adapter::{
	DamageRect, GridSize, RendererAdapter, RendererDamage, RendererFont, RendererPalette,
	ViewportState, resize_command, write_command,
};
pub use frame::{FrameCoalescer, FrameRequest};
pub use interaction::{SelectionRequest, SelectionRequestGuard};
pub use logic::{ConnectionPresentation, LifecyclePresentation, lifecycle};
pub use view::render;
