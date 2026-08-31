//! Markdown tables constrained to the transcript reading column.

use gpui::{InteractiveElement, ParentElement, ScrollHandle, Styled, div, px};
use veyyon_gui_core::text::markdown::Span;
use veyyon_gui_kit::{
	theme::{Elevation, Theme, layout, space, weight},
	ui::{EdgeFade, Scrolls, card, text},
};

use super::markdown;

pub fn table(head: &[Vec<Span>], rows: &[Vec<Vec<Span>>], theme: &Theme) -> EdgeFade {
	let scroll = ScrollHandle::new();
	let columns = head
		.len()
		.max(rows.iter().map(Vec::len).max().unwrap_or_default());
	let compact: Vec<bool> = (0..columns)
		.map(|index| {
			let mut values = rows.iter().filter_map(|row| row.get(index)).peekable();
			values.peek().is_some() && values.all(|cell| compact_value(cell))
		})
		.collect();
	let cells = |cells: &[Vec<Span>], strong: bool| {
		let mut row = div().flex().w_full().min_w(px(0.0)).gap(px(space::BASE));
		for (index, cell) in cells.iter().enumerate() {
			let mut element = markdown::runs(cell, theme).min_w(px(layout::row_tall()));
			if compact.get(index).copied().unwrap_or(false) {
				element = element.flex_none().w(px(layout::row_tall()));
			} else {
				element = element.flex_1().min_w(px(0.0));
			}
			if strong {
				element = element.font_weight(weight::MEDIUM);
			}
			row = row.child(element);
		}
		row
	};

	let mut column = text::stack(space::TIGHT).w_full().min_w(px(0.0));
	if !head.is_empty() {
		column = column.child(cells(head, true)).child(text::hairline(theme));
	}
	for row in rows {
		column = column.child(cells(row, false));
	}
	card::well(theme)
		.w_full()
		.min_w(px(0.0))
		.id("render-table-scroll-1")
		.px(px(space::BASE))
		.py(px(space::SNUG))
		.child(column)
		.scrolls_x(&scroll, Elevation::Sunken)
}

fn compact_value(spans: &[Span]) -> bool {
	let mut text = String::new();
	for span in spans {
		match span {
			Span::Plain(value)
			| Span::Strong(value)
			| Span::Emphasis(value)
			| Span::Code(value)
			| Span::Link { text: value, .. } => text.push_str(value),
		}
	}
	let text = text.trim();
	!text.is_empty()
		&& text.chars().all(|character| {
			character.is_ascii_digit() || matches!(character, '+' | '-' | '.' | ',' | '%')
		})
}
