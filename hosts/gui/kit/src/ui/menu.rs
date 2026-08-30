//! A short list of actions, next to the thing they act on.
//!
//! A row's context menu, a model picker, an attachment's options. A menu is for
//! actions; a menu of settings is a settings page, and a menu long enough to
//! scroll is the command palette.
//!
//! ANCHORING IS THE CALLER'S. This is the card and its rows. Where it opens,
//! and what closes it, belong to the surface that knows what it came from: it
//! wraps this in gpui's `anchored()` and `deferred()` so the menu escapes its
//! parent's clipping and draws over everything.
//!
//! Every row that has a keystroke shows it. A menu is where a reader learns the
//! chord for the thing they just did with the pointer.

use gpui::{
	App, ClickEvent, ElementId, InteractiveElement, IntoElement, ParentElement, RenderOnce,
	SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use super::{
	Icon, Tone,
	card::{Card, Lift},
	icon, kbd, square, text,
};
use crate::{
	motion::{Channel, Key},
	paint,
	theme::{Theme, layout, radius, size, space},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// One line in a menu.
#[derive(IntoElement)]
pub struct MenuItem {
	id:       SharedString,
	what:     SharedString,
	icon:     Option<Icon>,
	keys:     Option<SharedString>,
	tone:     Tone,
	/// A setting this row turns on, drawn with a check when it is on.
	checked:  Option<bool>,
	enabled:  bool,
	/// What the keyboard is on, as opposed to what the pointer is over.
	selected: bool,
	on_click: Option<Click>,
}

impl MenuItem {
	pub fn new(id: impl Into<SharedString>, what: impl Into<SharedString>) -> MenuItem {
		MenuItem {
			id:       id.into(),
			what:     what.into(),
			icon:     None,
			keys:     None,
			tone:     Tone::Plain,
			checked:  None,
			enabled:  true,
			selected: false,
			on_click: None,
		}
	}

	pub fn icon(mut self, icon: Icon) -> MenuItem {
		self.icon = Some(icon);
		self
	}

	/// The chord that does the same thing, as the keys table writes it.
	pub fn keys(mut self, keys: impl Into<SharedString>) -> MenuItem {
		self.keys = Some(keys.into());
		self
	}

	/// An action that cannot be undone, drawn in the tone that says so.
	pub fn destructive(mut self) -> MenuItem {
		self.tone = Tone::Danger;
		self
	}

	pub fn tone(mut self, tone: Tone) -> MenuItem {
		self.tone = tone;
		self
	}

	/// A row that reports a state as well as changing it.
	pub fn checked(mut self, checked: bool) -> MenuItem {
		self.checked = Some(checked);
		self
	}

	pub fn enabled(mut self, enabled: bool) -> MenuItem {
		self.enabled = enabled;
		self
	}

	pub fn selected(mut self, selected: bool) -> MenuItem {
		self.selected = selected;
		self
	}

	pub fn on_click(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> MenuItem {
		self.on_click = Some(Box::new(listener));
		self
	}
}

impl RenderOnce for MenuItem {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let key = Key::named(Channel::Row, self.id.as_ref());
		let ink = if self.enabled {
			self.tone.ink(&theme)
		} else {
			theme.text_faint
		};
		let lit = if self.tone == Tone::Danger {
			self.tone.tint(&theme)
		} else {
			theme.hover()
		};
		let ground = if self.selected {
			lit
		} else if self.enabled {
			paint::wash(cx, key, gpui::transparent_black(), lit)
		} else {
			gpui::transparent_black()
		};

		let row = div()
			.id(ElementId::from(self.id.clone()))
			.flex()
			.items_center()
			.gap(px(space::BASE))
			.w_full()
			.h(px(layout::ROW_TIGHT))
			.px(px(space::SNUG))
			.rounded(px(radius::CHIP))
			.bg(ground)
			.text_size(px(size::BODY))
			.text_color(ink)
			.children(self.icon.map(|glyph| {
				square(icon::scale::SMALL).child(icon::at(glyph, icon::scale::SMALL, ink))
			}))
			.child(text::line(self.what).flex_1())
			.children(self.checked.map(|checked| {
				square(icon::scale::SMALL).child(if checked {
					icon::at(Icon::Check, icon::scale::SMALL, theme.accent).into_any_element()
				} else {
					div().into_any_element()
				})
			}))
			.children(self.keys.map(|keys| kbd::caps(&keys, &theme)));

		if !self.enabled {
			return row.cursor_default();
		}

		let row = row.cursor_pointer().on_hover(move |over, _window, cx| {
			paint::hover(cx, key, *over);
			cx.refresh_windows();
		});
		match self.on_click {
			Some(listener) => row.on_click(move |event, window, cx| listener(event, window, cx)),
			None => row,
		}
	}
}

/// A card of actions.
#[derive(IntoElement)]
pub struct Menu {
	items: Vec<gpui::AnyElement>,
	width: f32,
}

impl Menu {
	pub fn new() -> Menu {
		Menu { items: Vec::new(), width: 220.0 }
	}

	pub fn width(mut self, width: f32) -> Menu {
		self.width = width;
		self
	}
}

/// A line between two runs of rows, for a menu whose last row is destructive.
#[derive(IntoElement)]
pub struct Separator;

impl RenderOnce for Separator {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		div()
			.h(px(1.0))
			.w_full()
			.my(px(space::TIGHT))
			.bg(theme.stroke)
	}
}

impl Default for Menu {
	fn default() -> Menu {
		Menu::new()
	}
}

impl ParentElement for Menu {
	fn extend(&mut self, elements: impl IntoIterator<Item = gpui::AnyElement>) {
		self.items.extend(elements);
	}
}

impl RenderOnce for Menu {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		Card::new()
			.lift(Lift::Menu)
			.ground(theme.overlay)
			.stroked()
			.radius(radius::ROW + 3.0)
			.pad(space::TIGHT + 1.0)
			.gap(1.0)
			.children(self.items)
			.min_width(self.width)
			.max_height(layout::SHEET)
	}
}
