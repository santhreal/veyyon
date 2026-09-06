//! Requesting a frame scoped to what a host batch changed (P5).
//!
//! The renderer fork keeps the previous frame's pixels outside the rectangle a
//! frame declares. A batch of host events, once projected, is diffed against
//! the state the window drew last; the regions that differ are looked up in
//! the boxes the last frame laid them out in, and one frame is requested
//! inside their union. A region with no box yet, or a change that moves
//! layout, requests a whole-window frame instead, so a scoped frame is never
//! guessed.

use veyyon_desktop_surface::{
	ShellView,
	damage::{Invalidation, Region},
};
use veyyon_gpui::{Bounds, Context, Pixels};

/// The frame a batch of host events asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Repaint {
	/// The batch changed no pixels; no frame was requested.
	Nothing,
	/// One frame, repainting only inside this rectangle, in window
	/// coordinates.
	Within(Bounds<Pixels>),
	/// One frame repainting the whole window.
	Full,
}

/// Requests the frame `invalidation` calls for, scoped to the boxes the last
/// frame laid the changed regions out in.
pub fn request_frame(
	view: &ShellView,
	invalidation: &Invalidation,
	cx: &mut Context<ShellView>,
) -> Repaint {
	match invalidation {
		Invalidation::Nothing => Repaint::Nothing,
		Invalidation::Full => {
			cx.notify();
			Repaint::Full
		},
		Invalidation::Within(regions) => {
			if let Some(bounds) = union_of(view, regions) {
				cx.notify_within(bounds);
				Repaint::Within(bounds)
			} else {
				cx.notify();
				Repaint::Full
			}
		},
	}
}

/// The union of the boxes `regions` were last laid out in, or `None` when one
/// of them has no box yet.
fn union_of(view: &ShellView, regions: &[Region]) -> Option<Bounds<Pixels>> {
	let laid_out = view.laid_out();
	let mut union: Option<Bounds<Pixels>> = None;
	for region in regions {
		let bounds = laid_out.bounds(*region)?;
		union = Some(union.map_or(bounds, |union| union.union(&bounds)));
	}
	union
}
