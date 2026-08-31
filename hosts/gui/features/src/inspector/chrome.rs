//! Compact definition rows used by every inspector tab.

use gpui::{App, Div, ParentElement, SharedString, Styled, div, px};
use veyyon_gui_kit::{
	theme::{Theme, size, space, weight},
	ui::{Badge, Tone, text},
};

pub fn definition(
	label: impl Into<SharedString>,
	value: impl Into<SharedString>,
	cx: &mut App,
) -> Div {
	let theme = Theme::get(cx);
	div()
		.flex()
		.items_baseline()
		.gap(px(space::BASE))
		.w_full()
		.min_w(px(0.0))
		.child(
			text::line(label)
				.w(px(space::HUGE * 4.0))
				.flex_none()
				.text_size(px(size::meta()))
				.text_color(theme.text_faint),
		)
		.child(
			text::line(value)
				.flex_1()
				.min_w(px(0.0))
				.text_size(px(size::meta()))
				.font_weight(weight::MEDIUM)
				.text_color(theme.text_muted),
		)
}

pub fn state(label: impl Into<SharedString>, tone: Tone) -> Badge {
	Badge::new(label).tone(tone)
}
