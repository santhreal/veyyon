//! Small pieces shared by the roster and the selected-agent page.

use gpui::{AnyElement, App, Div, ParentElement, SharedString, Styled, px};
use veyyon_gui_kit::{
	theme::{Theme, size, space, weight},
	ui::{Badge, Card, Icon, Tone, icon, text},
};

pub fn status_badge(label: impl Into<SharedString>, tone: Tone, icon: Icon) -> Badge {
	Badge::new(label).tone(tone).icon(icon)
}

pub fn section_heading(
	label: impl Into<SharedString>,
	trailing: impl IntoIterator<Item = AnyElement>,
	cx: &mut App,
) -> Div {
	let theme = Theme::get(cx);
	text::line_of(space::SNUG)
		.w_full()
		.min_w(px(0.0))
		.child(
			text::line(label)
				.flex_1()
				.min_w(px(0.0))
				.text_size(px(size::meta()))
				.font_weight(weight::MEDIUM)
				.text_color(theme.text_muted),
		)
		.children(trailing)
}

pub fn metric(
	label: impl Into<SharedString>,
	value: impl Into<SharedString>,
	cx: &mut App,
) -> Card {
	let theme = Theme::get(cx);
	Card::new()
		.child(
			text::line(value)
				.min_w(px(0.0))
				.text_size(px(size::body()))
				.font_weight(weight::MEDIUM)
				.text_color(theme.text),
		)
		.child(
			text::line(label)
				.text_size(px(size::meta()))
				.text_color(theme.text_faint),
		)
}

pub fn labelled_icon(icon_value: Icon, label: impl Into<SharedString>, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	text::line_of(space::SNUG)
		.min_w(px(0.0))
		.child(icon::at(icon_value, icon::scale::small(), theme.text_faint))
		.child(
			text::line(label)
				.min_w(px(0.0))
				.text_size(px(size::meta()))
				.text_color(theme.text_muted),
		)
}
