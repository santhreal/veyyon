//! Anchored action menu and stable menu rows.
//!
//! The parent controls anchoring, focus containment, and dismissal. Each item
//! takes a retained owner, exposes its disabled reason, reserves status and
//! shortcut columns, and uses the same interruptible wash as list rows.

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
	motion::{Damage, MotionKey, Priority, Property, RetainedKey, mix, spec},
	paint,
	theme::{Theme, control, layout, radius, size, space},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

#[derive(IntoElement)]
pub struct MenuItem {
	id:              SharedString,
	owner:           RetainedKey,
	what:            SharedString,
	icon:            Option<Icon>,
	keys:            Option<SharedString>,
	tone:            Tone,
	checked:         Option<bool>,
	selected:        bool,
	disabled_reason: Option<SharedString>,
	on_click:        Option<Click>,
}

impl MenuItem {
	pub fn new(
		id: impl Into<SharedString>,
		owner: RetainedKey,
		what: impl Into<SharedString>,
	) -> Self {
		Self {
			id: id.into(),
			owner,
			what: what.into(),
			icon: None,
			keys: None,
			tone: Tone::Plain,
			checked: None,
			selected: false,
			disabled_reason: None,
			on_click: None,
		}
	}

	pub fn icon(mut self, icon: Icon) -> Self {
		self.icon = Some(icon);
		self
	}

	pub fn keys(mut self, keys: impl Into<SharedString>) -> Self {
		self.keys = Some(keys.into());
		self
	}

	pub fn destructive(mut self) -> Self {
		self.tone = Tone::Danger;
		self
	}

	pub fn tone(mut self, tone: Tone) -> Self {
		self.tone = tone;
		self
	}

	pub fn checked(mut self, checked: bool) -> Self {
		self.checked = Some(checked);
		self
	}

	pub fn selected(mut self, selected: bool) -> Self {
		self.selected = selected;
		self
	}

	pub fn disabled(mut self, reason: impl Into<SharedString>) -> Self {
		self.disabled_reason = Some(reason.into());
		self
	}

	pub fn on_click(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_click = Some(Box::new(listener));
		self
	}
}

impl RenderOnce for MenuItem {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let key = MotionKey::new(self.owner, Property::ColorMix);
		let enabled = self.disabled_reason.is_none() && self.on_click.is_some();
		let ink = if enabled {
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
		} else {
			mix(gpui::transparent_black(), lit, paint::sample(cx, key, 0.0))
		};
		let row = div()
			.id(ElementId::from(self.id.clone()))
			.flex()
			.items_center()
			.gap(px(space::BASE))
			.w_full()
			.h(px(layout::row()))
			.px(px(space::SNUG))
			.rounded(px(radius::ROW))
			.bg(ground)
			.text_size(px(size::body()))
			.text_color(ink)
			.child(
				square(icon::scale::small()).children(
					self
						.icon
						.map(|glyph| icon::at(glyph, icon::scale::small(), ink)),
				),
			)
			.child(text::line(self.what).flex_1().min_w(px(0.0)))
			.child(square(icon::scale::small()).children(self.checked.and_then(|checked| {
				checked.then(|| icon::at(Icon::Check, icon::scale::small(), theme.accent))
			})))
			.children(self.keys.map(|keys| kbd::caps(&keys, &theme)));
		let row = match self.disabled_reason {
			Some(reason) => row.tooltip(move |_window, cx| super::Tip::view(reason.clone(), cx)),
			None => row,
		};
		if !enabled {
			return row.cursor_default();
		}
		let row = row.cursor_pointer().on_hover(move |over, _window, cx| {
			let program = if *over {
				spec::HOVER_IN
			} else {
				spec::HOVER_OUT
			};
			let _ = paint::retarget(
				cx,
				key,
				program,
				u8::from(*over) as f32,
				Priority::Content,
				Damage::Paint(0),
			);
			cx.refresh_windows();
		});
		match self.on_click {
			Some(listener) => row.on_click(move |event, window, cx| listener(event, window, cx)),
			None => row,
		}
	}
}

#[derive(IntoElement)]
pub struct Menu {
	items: Vec<gpui::AnyElement>,
	width: f32,
}
impl Menu {
	pub fn new() -> Self {
		Self { items: Vec::new(), width: control::menu_width() }
	}

	pub fn width(mut self, width: f32) -> Self {
		self.width = width;
		self
	}
}
impl Default for Menu {
	fn default() -> Self {
		Self::new()
	}
}
impl ParentElement for Menu {
	fn extend(&mut self, items: impl IntoIterator<Item = gpui::AnyElement>) {
		self.items.extend(items);
	}
}
impl RenderOnce for Menu {
	fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
		Card::new()
			.lift(Lift::Menu)
			.pad(space::TIGHT)
			.gap(space::ROWS)
			.width(self.width)
			.children(self.items)
	}
}

#[derive(IntoElement)]
pub struct Separator;
impl RenderOnce for Separator {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		div()
			.h(px(1.0))
			.mx(px(space::SNUG))
			.my(px(space::TIGHT))
			.bg(theme.stroke)
	}
}
