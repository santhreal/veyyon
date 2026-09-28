//! What the window reports about its frames, for the `wait` requests.
//!
//! `wait: "idle"` reads `Window::frame_pending` and `wait: "text"` reads
//! `Window::rendered_text_runs`, which include the runs of cached views whose
//! paint the last frame reused.

use gpui::{Bounds, Pixels, SharedString, Window};

/// Whether `window` has requested a frame it has not presented yet.
pub(super) fn frame_pending(window: &Window) -> bool {
	window.frame_pending()
}

/// The text of every glyph run the last presented frame painted that
/// overlaps `bounds`, in paint order.
pub(super) fn rendered_text(window: &Window, bounds: Bounds<Pixels>) -> Vec<SharedString> {
	window
		.rendered_text_runs()
		.iter()
		.filter(|run| run.bounds.intersects(&bounds))
		.map(|run| run.text.clone())
		.collect()
}
