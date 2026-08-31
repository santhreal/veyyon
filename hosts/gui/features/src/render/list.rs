//! Markdown lists with fixed marker columns and bounded wrapping.

use gpui::{Div, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::text::markdown::{Item, ListKind};
use veyyon_gui_kit::{
	theme::{Theme, size, space},
	ui::{Icon, icon, square, text},
};

use super::markdown;

/// A complete list.
pub fn list(items: &[Item], theme: &Theme) -> Div {
	list_keyed("", items, theme)
}

/// A complete list with keyed items for selection.
pub fn list_keyed(id: &str, items: &[Item], theme: &Theme) -> Div {
	let mut column = text::stack(space::TIGHT).w_full().min_w(px(0.0));
	for (index, item) in items.iter().enumerate() {
		column = column.child(item_row(&format!("{id}-item-{index}"), item, theme));
	}
	column
}

/// One item. The fixed marker column keeps wrapped lines aligned with the text.
fn item_row(key: &str, item: &Item, theme: &Theme) -> Div {
	let marker = match (item.done, item.kind) {
		(Some(done), _) => square(icon::scale::small())
			.child(icon::at(
				if done { Icon::Check } else { Icon::Folded },
				icon::scale::small(),
				if done { theme.ok } else { theme.text },
			))
			.into_any_element(),
		(None, ListKind::Bullet) => text::line("•")
			.text_size(px(size::meta()))
			.text_color(theme.text)
			.into_any_element(),
		(None, ListKind::Ordered(number)) => text::line(format!("{number}."))
			.text_color(theme.text)
			.text_size(px(size::meta()))
			.into_any_element(),
	};

	div()
		.flex()
		.w_full()
		.min_w(px(0.0))
		.gap(px(space::SNUG))
		.pl(px(f32::from(item.depth) * space::WIDE))
		.child(
			div()
				.flex_none()
				.w(px(icon::scale::base()))
				.flex()
				.justify_end()
				.child(marker),
		)
		.child(
			markdown::runs_keyed(key, &item.spans, theme)
				.flex_1()
				.min_w(px(0.0)),
		)
}
