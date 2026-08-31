//! User-authored text, aligned to the sending edge without widening the column.

use gpui::{AnyElement, App, Div, ParentElement, Styled, div, px, relative};
use veyyon_gui_core::text::markdown::Md;
use veyyon_gui_kit::{
	theme::{Theme, layout, radius, space},
	ui::text,
};

use super::markdown;

pub fn text(id: &str, blocks: &[Md], cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let mut column = text::stack(space::BASE).items_end().w_full().min_w(px(0.0));
	let mut prose = Vec::new();
	for (index, block) in blocks.iter().enumerate() {
		let element = markdown::block(block, &format!("{id}-{index}"), cx);
		if standalone(block) {
			column = column.children(bubble(&mut prose, &theme)).child(
				div()
					.w(px(layout::measure()))
					.max_w(relative(1.0))
					.min_w(px(0.0))
					.overflow_hidden()
					.child(element),
			);
		} else {
			prose.push(element);
		}
	}
	column.children(bubble(&mut prose, &theme))
}

fn bubble(prose: &mut Vec<AnyElement>, theme: &Theme) -> Option<Div> {
	if prose.is_empty() {
		return None;
	}
	Some(
		text::stack(space::BASE)
			.w(px(layout::measure()))
			.max_w(relative(1.0))
			.min_w(px(0.0))
			.overflow_hidden()
			.px(px(space::WIDE))
			.py(px(space::BASE))
			.rounded(px(radius::CARD))
			.bg(theme.raised)
			.border_1()
			.border_color(theme.stroke)
			.text_color(theme.text)
			.children(prose.drain(..)),
	)
}

pub fn standalone(block: &Md) -> bool {
	match block {
		Md::Code { .. } | Md::Table { .. } => true,
		Md::Quote(inner) => inner.iter().any(standalone),
		Md::Heading { .. } | Md::Paragraph(_) | Md::List(_) | Md::Rule => false,
	}
}
