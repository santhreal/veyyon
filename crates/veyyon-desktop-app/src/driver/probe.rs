//! What the window reports about its frames, for the `wait` requests.
//!
//! `wait: "idle"` reads `Window::frame_pending` and `wait: "text"` reads
//! `Window::rendered_text_runs`. The pinned `santh-gpui` revision has
//! neither, so both answer [`UNSUPPORTED`] until the pin moves to the
//! revision that adds them; each function then returns the window's answer.

use gpui::{Bounds, Pixels, SharedString, Window};

/// The error both probes answer on the pinned framework revision.
pub(super) const UNSUPPORTED: &str = "unsupported by pinned gpui";

/// Whether `window` has requested a frame it has not painted yet.
pub(super) const fn frame_pending(_window: &Window) -> Result<bool, &'static str> {
	Err(UNSUPPORTED)
}

/// The text of every glyph run the last presented frame painted inside
/// `bounds`, in paint order.
pub(super) const fn rendered_text(
	_window: &Window,
	_bounds: Bounds<Pixels>,
) -> Result<Vec<SharedString>, &'static str> {
	Err(UNSUPPORTED)
}
