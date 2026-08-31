//! Assistant thinking and redacted-thinking markers.

use gpui::{App, Div, ParentElement, Styled, div, px};
use veyyon_gui_core::text::markdown::Md;
use veyyon_gui_kit::{
	theme::{Theme, radius, space},
	ui::{Badge, Tone, text},
};

use super::markdown;

pub fn thinking(id: &str, blocks: &[Md], cx: &mut App) -> Div {
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
		.child(Badge::new("Thinking").tone(Tone::Muted).bare())
		.child(
			text::stack(space::TIGHT)
				.mt(px(space::TIGHT))
				.w_full()
				.min_w(px(0.0))
				.text_color(theme.text_muted)
				.children(markdown::blocks(blocks, id, cx)),
		)
}

pub fn redacted(marker: &str, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	div().w_full().min_w(px(0.0)).child(
		text::note(
			if marker.trim().is_empty() {
				"Thinking was redacted"
			} else {
				marker
			},
			&theme,
		)
		.text_color(theme.text_faint),
	)
}
