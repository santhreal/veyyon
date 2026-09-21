//! Animated reveal container for expanding transcript blocks (§5.2, §5.3).
//!
//! Provides dynamic height measurement via GPUI `on_children_prepainted` and
//! animated height clipping and opacity fading driven by `RevealMotion`.

use veyyon_gpui::{Div, ParentElement, Styled, WeakEntity, div, px};

use crate::{ShellView, transcript::state::TranscriptViewportState};

/// Wraps block details in an animated clipping container with height and
/// opacity transitions.
///
/// Returns `None` if the block is collapsed and at rest (`progress <= 0.0`),
/// unmounting the details content entirely.
///
/// When revealing or expanded (`is_expanded || progress > 0.0`), wraps the
/// details content in a clipped container sized by `progress * natural_height`
/// with opacity set to `progress`. Prepaint measurement dynamically records the
/// child's natural height using `record_reveal_height` on
/// `TranscriptViewportState`, ensuring `.flex_shrink_0()` prevents the clipping
/// container from distorting intrinsic measurement.
pub fn render_reveal_container(
	turn_ix: usize,
	block_ix: usize,
	is_expanded: bool,
	viewport_state: &TranscriptViewportState,
	view: Option<&WeakEntity<ShellView>>,
	content: Div,
) -> Option<Div> {
	let (progress, natural_height) = viewport_state.current_reveal_frame(turn_ix, block_ix);
	let is_revealing = is_expanded || progress > 0.0;

	if !is_revealing {
		return None;
	}

	let clamped_progress = progress.clamp(0.0, 1.0);
	let clipped_height =
		viewport_state.reveal_clip_height(turn_ix, block_ix, clamped_progress, natural_height);
	let opacity = clamped_progress;

	let state_measure = viewport_state.clone();
	let view_measure = view.cloned();

	let measured_child = content.flex_shrink_0().w_full();

	let mut wrapper = div().w_full().overflow_hidden().opacity(opacity);
	if clamped_progress < 1.0 && clipped_height > 0.0 {
		wrapper = wrapper.h(px(clipped_height));
	}
	let wrapper = wrapper
		.on_children_prepainted(move |children, _window, cx| {
			if let Some(bounds) = children.first() {
				let height = f32::from(bounds.size.height);
				if height > 0.0
					&& state_measure.record_reveal_height(turn_ix, block_ix, height)
					&& let Some(v) = &view_measure
				{
					// The measure the reveal grew to changes this block and
					// what sits under it, and each region below declares the
					// box it leaves as it re-records, so the frame is asked
					// for inside the block rather than over the window.
					let bounds = *bounds;
					let _ = v.update(cx, |_view, cx| cx.notify_within(bounds));
				}
			}
		})
		.child(measured_child);

	Some(wrapper)
}
