//! How the palette draws: a card [`size::PALETTE`] wide, a fifth of the way
//! down the window, with the query on top and the ranked rows below, one
//! heading per section.
//!
//! The list is a [`uniform_list`] of [`Line`]s, each [`size::MENU_ROW`] tall,
//! so a frame lays out only the lines scrolled into view whatever the number
//! of rows.

use std::ops::Range;

use veyyon_desktop_ui::{
	controls::{Divider, Tooltip},
	editor::actions::{MoveDown, MoveUp},
	icons::{Icon, IconName},
	theme::{ActiveTheme, Palette, TypeStyled, radius, size, space, text},
};
use veyyon_gpui::{
	AnyElement, App, Context, IntoElement, ListSizingBehavior, Pixels, Render, SharedString, Window,
	deferred, div, prelude::*, uniform_list,
};

use super::{CommandPalette, Group, Hint, Item, Phase, Scope};
use crate::driver;

/// How far down the window the card's top edge sits.
const TOP_FRACTION: f32 = 0.18;
/// The tallest the row list grows, as a share of the window height.
const LIST_FRACTION: f32 = 0.56;
/// How many sections, so how many headings, a list can hold.
const SECTIONS: usize = 5;

/// One line of the list: the heading above a section, or the shown row at an
/// index.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Line {
	Heading(Group),
	Row(usize),
}

/// The lines that list the `shown` rows of `items`, a heading above each
/// section.
pub(super) fn lines(shown: &[usize], items: &[Item]) -> Vec<Line> {
	let mut lines = Vec::with_capacity(shown.len() + SECTIONS);
	let mut section = None;
	for (row, ix) in shown.iter().enumerate() {
		let Some(item) = items.get(*ix) else {
			continue;
		};
		if section != Some(item.group) {
			section = Some(item.group);
			lines.push(Line::Heading(item.group));
		}
		lines.push(Line::Row(row));
	}
	lines
}

impl Render for CommandPalette {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		self.renders += 1;
		let (opacity, travel) = self.presence.step(window, cx);
		let closed = self.presence.phase() == Phase::Closed;
		if closed || matches!(self.scope, Scope::Argument { .. }) || self.lines.is_empty() {
			forget_undrawn(&mut self.drawn, 0..0, window, cx);
		}
		if closed {
			driver::forget(window, "palette", cx);
			return div().into_any_element();
		}
		let palette = cx.theme().palette;
		let height = window.viewport_size().height;
		let body = match &self.scope {
			Scope::Argument { line, .. } => Self::argument_hint(line, &palette),
			Scope::Root | Scope::Subcommands(_) => self.list(&palette, height * LIST_FRACTION, cx),
		};
		let card = div()
			.id("palette")
			.occlude()
			.w(size::PALETTE)
			.opacity(opacity)
			.mt(height * TOP_FRACTION - space::S1 * travel)
			.bg(palette.bg.elevated)
			.rounded(radius::XL)
			.border_1()
			.border_color(palette.border.default)
			.shadow_lg()
			.overflow_hidden()
			.key_context("Palette")
			.capture_action(cx.listener(|this, _: &MoveUp, _, cx| {
				this.move_selection(false, cx);
				cx.stop_propagation();
			}))
			.capture_action(cx.listener(|this, _: &MoveDown, _, cx| {
				this.move_selection(true, cx);
				cx.stop_propagation();
			}))
			.on_mouse_down_out(cx.listener(|this, _, window, cx| this.close(window, cx)))
			.child(
				div()
					.flex()
					.items_center()
					.gap(space::S2)
					.h(size::HEADER)
					.px(space::S3)
					.child(
						Icon::new(IconName::Search)
							.size(size::ICON)
							.color(palette.text.muted),
					)
					.child(div().flex_1().min_w_0().child(self.input.clone())),
			)
			.child(Divider::horizontal())
			.child(body);
		deferred(
			div()
				.absolute()
				.top_0()
				.left_0()
				.size_full()
				.flex()
				.justify_center()
				.items_start()
				.child(driver::target("palette", card)),
		)
		.with_priority(2)
		.into_any_element()
	}
}

impl CommandPalette {
	/// The ranked rows, a heading above each section, no taller than
	/// `max_height`.
	fn list(&self, palette: &Palette, max_height: Pixels, cx: &Context<Self>) -> AnyElement {
		if self.lines.is_empty() {
			return div()
				.p(space::S1)
				.child(
					div()
						.px(space::S3)
						.py(space::S3)
						.type_style(text::UI)
						.text_color(palette.text.muted)
						.child("No matches"),
				)
				.into_any_element();
		}
		uniform_list(
			"palette-list",
			self.lines.len(),
			cx.processor(|this, range, window, cx| this.lines_in(range, window, cx)),
		)
		.with_sizing_behavior(ListSizingBehavior::Infer)
		.track_scroll(&self.list)
		.max_h(max_height)
		.p(space::S1)
		.into_any_element()
	}

	/// The lines in `range`, which the list lays out this frame. Forgets the
	/// driver targets of the rows it laid out before and does not now.
	fn lines_in(
		&mut self,
		range: Range<usize>,
		window: &Window,
		cx: &mut Context<Self>,
	) -> Vec<AnyElement> {
		let lines = self.lines.get(range).unwrap_or_default();
		let mut rows = lines.iter().filter_map(|line| match line {
			Line::Row(row) => Some(*row),
			Line::Heading(_) => None,
		});
		let drawn = rows
			.next()
			.map_or(0..0, |first| first..rows.next_back().unwrap_or(first) + 1);
		forget_undrawn(&mut self.drawn, drawn, window, cx);
		let palette = cx.theme().palette;
		lines
			.iter()
			.filter_map(|line| match *line {
				Line::Heading(group) => Some(heading(group.label(), &palette)),
				Line::Row(row) => {
					let item = self.shown.get(row).and_then(|ix| self.items.get(*ix))?;
					Some(self.row(row, item, &palette, cx))
				},
			})
			.collect()
	}

	fn row(&self, row: usize, item: &Item, palette: &Palette, cx: &Context<Self>) -> AnyElement {
		let selected = row == self.selected;
		let blocked = item.blocked.clone();
		let label_color = if blocked.is_some() {
			palette.text.faint
		} else {
			palette.text.primary
		};
		let hint = match &item.hint {
			Hint::None => None,
			Hint::Shortcut(kbd) => Some(kbd.clone().into_any_element()),
			Hint::Text(word) => Some(
				div()
					.type_style(text::SMALL)
					.text_color(palette.text.faint)
					.child(word.clone())
					.into_any_element(),
			),
		};
		let element = div()
			.id(("palette-row", row))
			.flex()
			.items_center()
			.gap(space::S2)
			.w_full()
			.h(size::MENU_ROW)
			.px(space::S2)
			.rounded(radius::MD)
			.type_style(text::UI)
			.when(selected, |el| el.bg(palette.bg.selected))
			.when(!selected, |el| el.hover(|el| el.bg(palette.bg.hover)))
			.child(
				div()
					.flex_none()
					.text_color(label_color)
					.child(item.label.clone()),
			)
			.when_some(item.detail.clone(), |el, detail| {
				el.child(
					div()
						.flex_1()
						.min_w_0()
						.truncate()
						.text_color(palette.text.muted)
						.child(detail),
				)
			})
			.when(item.detail.is_none(), |el| el.child(div().flex_1()))
			.children(hint)
			.when_some(blocked, |el, reason: SharedString| el.tooltip(Tooltip::text(reason)))
			.on_click(cx.listener(move |this, _, window, cx| this.choose(row, window, cx)));
		driver::target(("palette.row", row), element)
	}

	/// What Enter runs while an argument is typed.
	fn argument_hint(line: &str, palette: &Palette) -> AnyElement {
		div()
			.px(space::S3)
			.py(space::S2_5)
			.type_style(text::SMALL)
			.text_color(palette.text.muted)
			.child(format!("Enter runs {line}…  Escape goes back"))
			.into_any_element()
	}
}

/// Drops the driver targets of the rows in `drawn` outside `rows`, and
/// records `rows` as the rows drawn.
fn forget_undrawn(drawn: &mut Range<usize>, rows: Range<usize>, window: &Window, cx: &mut App) {
	if driver::is_enabled() {
		for row in drawn.clone().filter(|row| !rows.contains(row)) {
			driver::forget(window, &format!("palette.row:{row}"), cx);
		}
	}
	*drawn = rows;
}

/// A section's heading, as tall as a row, its label at the bottom.
fn heading(label: &'static str, palette: &Palette) -> AnyElement {
	div()
		.flex()
		.items_end()
		.w_full()
		.h(size::MENU_ROW)
		.px(space::S2)
		.pb(space::S1)
		.type_style(text::MICRO)
		.text_color(palette.text.faint)
		.child(label)
		.into_any_element()
}
