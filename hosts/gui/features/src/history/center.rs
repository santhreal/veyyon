//! Center-column workspace for the History surface rendering the read-only
//! transcript.

use gpui::{App, Div, Entity, ParentElement, Styled, div, px};
use veyyon_gui_core::Store;

use crate::transcript::{self, Timeline};

/// Render the read-only session transcript in the history workspace.
pub fn render_center(store: &Store, timeline: &Entity<Timeline>, cx: &mut App) -> Div {
	div()
		.flex()
		.flex_col()
		.size_full()
		.min_h(px(0.0))
		.overflow_hidden()
		.child(
			div()
				.flex_1()
				.min_h(px(0.0))
				.overflow_hidden()
				.child(transcript::render(store, timeline, cx)),
		)
}
