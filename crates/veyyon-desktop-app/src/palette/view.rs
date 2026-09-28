//! How the palette draws: a card [`size::PALETTE`] wide, a fifth of the way
//! down the window, with the query on top and the ranked rows below, one
//! heading per section.

use veyyon_desktop_ui::{
	controls::{Divider, Tooltip},
	editor::actions::{MoveDown, MoveUp},
	icons::{Icon, IconName},
	theme::{ActiveTheme, Palette, TypeStyled, radius, size, space, text},
};
use veyyon_gpui::{
	AnyElement, App, Context, IntoElement, Pixels, Render, SharedString, Window, deferred, div,
	prelude::*,
};

use super::{CommandPalette, Hint, Item, Phase, Scope};
use crate::driver;

/// How far down the window the card's top edge sits.
const TOP_FRACTION: f32 = 0.18;
/// The tallest the row list grows, as a share of the window height.
const LIST_FRACTION: f32 = 0.56;

impl Render for CommandPalette {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		self.renders += 1;
		let (opacity, travel) = self.presence.step(window, cx);
		let closed = self.presence.phase() == Phase::Closed;
		let listing = !closed && !matches!(self.scope, Scope::Argument { .. });
		let rows = if listing { self.shown.len() } else { 0 };
		self.forget_undrawn(rows, closed, window, cx);
		if closed {
			return div().into_any_element();
		}
		let palette = cx.theme().palette;
		let height = window.viewport_size().height;
		let body = match &self.scope {
			Scope::Argument { line, .. } => Self::argument_hint(line, &palette),
			Scope::Root | Scope::Subcommands(_) => self.rows(&palette, height * LIST_FRACTION, cx),
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
	/// Drops the driver targets of the rows past the `rows` this frame draws,
	/// and of the card once the palette is `closed`.
	fn forget_undrawn(&mut self, rows: usize, closed: bool, window: &Window, cx: &mut App) {
		if driver::is_enabled() {
			for row in rows..self.drawn_rows {
				driver::forget(window, &format!("palette.row:{row}"), cx);
			}
			if closed {
				driver::forget(window, "palette", cx);
			}
		}
		self.drawn_rows = rows;
	}

	/// The ranked rows, a heading above each section.
	fn rows(&self, palette: &Palette, max_height: Pixels, cx: &Context<Self>) -> AnyElement {
		let mut children: Vec<AnyElement> = Vec::with_capacity(self.shown.len() + 5);
		let mut section = None;
		for (row, ix) in self.shown.iter().enumerate() {
			let Some(item) = self.items.get(*ix) else {
				continue;
			};
			if section != Some(item.group) {
				section = Some(item.group);
				children.push(heading(item.group.label(), palette));
			}
			children.push(self.row(row, item, palette, cx));
		}
		if children.is_empty() {
			children.push(
				div()
					.px(space::S3)
					.py(space::S3)
					.type_style(text::UI)
					.text_color(palette.text.muted)
					.child("No matches")
					.into_any_element(),
			);
		}
		div()
			.id("palette-list")
			.max_h(max_height)
			.overflow_y_scroll()
			.track_scroll(&self.list)
			.p(space::S1)
			.children(children)
			.into_any_element()
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

fn heading(label: &'static str, palette: &Palette) -> AnyElement {
	div()
		.px(space::S2)
		.pt(space::S2)
		.pb(space::S1)
		.type_style(text::MICRO)
		.text_color(palette.text.faint)
		.child(label)
		.into_any_element()
}
