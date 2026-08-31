//! Assistant prose in the primary reading column.

use gpui::{App, Div, ParentElement, Styled, div, px};
use veyyon_gui_core::text::markdown::Md;
use veyyon_gui_kit::{
	theme::{Theme, space},
	ui::{Badge, Icon, Tone, icon, square, text},
};

use super::markdown;

pub fn text(id: &str, blocks: &[Md], streaming: bool, stale: bool, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let mut body = text::stack(space::BASE)
		.flex_1()
		.min_w(px(0.0))
		.overflow_hidden()
		.text_color(theme.text)
		.children(markdown::blocks_streamed(blocks, id, streaming, cx));
	if stale {
		body = body.child(Badge::new("Partial · disconnected").tone(Tone::Warn));
	} else if streaming {
		body = body.child(Badge::new("Streaming").tone(Tone::Accent));
	}

	div()
		.flex()
		.w_full()
		.min_w(px(0.0))
		.gap(px(space::BASE))
		.child(
			square(icon::scale::base())
				.flex_none()
				.child(icon::base(Icon::Engine, theme.text_muted)),
		)
		.child(body)
}
