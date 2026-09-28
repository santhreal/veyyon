//! Headless rendering of the veyyon desktop views to PNG, for tests and
//! captures.
//!
//! [`headless`] rasterises a root view offscreen, one context at a time per
//! process; [`session`] keeps a window open across input and frames;
//! [`workspace`] renders the window the binary opens over a seeded store.
//! Nothing that ships links this crate.

pub mod frame;
pub mod headless;
mod renderer;
pub mod session;
pub mod workspace;

pub use frame::{FrameError, RgbaColor, RgbaFrame};
pub use headless::{
	Captured, Headless, RenderError, RenderOptions, capture_window, distinct_pixel_values,
	headless_context, render_view, renderer_is_software, write_png,
};
pub use renderer::NoOffscreenRenderer;
pub use session::HeadlessSession;
pub use workspace::{render_workspace, seeded_events};
