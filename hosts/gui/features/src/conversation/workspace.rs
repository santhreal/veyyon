//! Stable center-column composition.

use gpui::{Div, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_kit::theme::{layout, space};

/// Compose the virtual timeline and long-lived composer without remounting
/// either handle when surrounding panels change presentation.
pub fn work_surface(
	timeline: impl IntoElement,
	composer: impl IntoElement,
	overlay: impl IntoElement,
) -> Div {
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
				.child(timeline),
		)
		.child(overlay)
		.child(
			div()
				.flex_none()
				.w_full()
				.px(px(space::WIDE))
				.pb(px(space::WIDE))
				.child(
					div()
						.w_full()
						.max_w(px(layout::reading()))
						.mx_auto()
						.child(composer),
				),
		)
}
