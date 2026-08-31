//! Markdown block quotes with a nested, width-bounded content column.

use gpui::{App, Div, ParentElement, Styled, div, px};
use veyyon_gui_core::text::markdown::Md;
use veyyon_gui_kit::{
	theme::{Theme, radius, space},
	ui::text,
};

use super::markdown;

/// A quote. Nested blocks retain their own renderer and cannot widen the row.
pub fn quote(inner: &[Md], id: &str, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	div()
		.flex()
		.w_full()
		.min_w(px(0.0))
		.overflow_hidden()
		.gap(px(space::BASE))
		.child(
			div()
				.flex_none()
				.w(px(space::PAIR))
				.rounded(px(radius::PILL))
				.bg(theme.text_muted),
		)
		.child(
			text::stack(space::BASE)
				.flex_1()
				.min_w(px(0.0))
				.children(markdown::blocks(inner, id, cx)),
		)
}
