//! Developer instructions shown as authored context, distinct from user prose.

use gpui::{App, Div, ParentElement, Styled, div, px};
use veyyon_gui_core::text::markdown::Md;
use veyyon_gui_kit::{
	theme::{Theme, radius, size, space, weight},
	ui::text,
};

use super::markdown;

pub fn text(id: &str, blocks: &[Md], cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	div()
		.w_full()
		.min_w(px(0.0))
		.overflow_hidden()
		.rounded(px(radius::ROW))
		.bg(theme.chrome)
		.border_1()
		.border_color(theme.stroke)
		.px(px(space::BASE))
		.py(px(space::SNUG))
		.child(
			text::meta("Developer", &theme)
				.text_size(px(size::meta()))
				.font_weight(weight::MEDIUM)
				.text_color(theme.text_faint),
		)
		.child(
			text::stack(space::BASE)
				.mt(px(space::TIGHT))
				.w_full()
				.min_w(px(0.0))
				.children(markdown::blocks(blocks, id, cx)),
		)
}
