//! A few choices, all of them visible.
//!
//! Unified or split in a diff, the pages of a settings sidebar's sub-section,
//! the two halves of a picker. Tabs are for a small closed set where seeing the
//! options is worth the width; anything longer is a [`Select`](super::Select),
//! and anything that is not a choice between views is a
//! [`Button`](super::Button).
//!
//! The selected tab is a raised pill inside a sunken track, which is the shape
//! every platform draws a segmented control as. Colour alone would leave the
//! control looking like a row of links.

use gpui::{
	App, ClickEvent, ElementId, InteractiveElement, IntoElement, ParentElement, RenderOnce,
	SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use super::{Icon, Size, icon, text};
use crate::{
	motion::{Channel, Key},
	paint,
	theme::{Theme, radius, space, weight},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// One choice in a segmented control.
pub struct Tab {
	what:     SharedString,
	icon:     Option<Icon>,
	selected: bool,
	on_click: Option<Click>,
}

impl Tab {
	pub fn new(what: impl Into<SharedString>, selected: bool) -> Tab {
		Tab { what: what.into(), icon: None, selected, on_click: None }
	}

	pub fn icon(mut self, icon: Icon) -> Tab {
		self.icon = Some(icon);
		self
	}

	pub fn on_click(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Tab {
		self.on_click = Some(Box::new(listener));
		self
	}
}

/// A closed set of choices, side by side.
#[derive(IntoElement)]
pub struct Tabs {
	id:      SharedString,
	tabs:    Vec<Tab>,
	size:    Size,
	/// Fill the width, splitting it evenly. For a control that heads a pane
	/// rather than sitting in a row.
	stretch: bool,
}

impl Tabs {
	pub fn new(id: impl Into<SharedString>) -> Tabs {
		Tabs { id: id.into(), tabs: Vec::new(), size: Size::Small, stretch: false }
	}

	pub fn tab(mut self, tab: Tab) -> Tabs {
		self.tabs.push(tab);
		self
	}

	pub fn size(mut self, size: Size) -> Tabs {
		self.size = size;
		self
	}

	pub fn stretch(mut self) -> Tabs {
		self.stretch = true;
		self
	}
}

impl RenderOnce for Tabs {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let size = self.size;
		let stretch = self.stretch;
		let id = self.id.clone();

		let mut track = div()
			.flex()
			.items_center()
			.gap(px(2.0))
			.p(px(2.0))
			.rounded(px(radius::CHIP + 2.0))
			.bg(theme.sunken)
			.border_1()
			.border_color(theme.stroke);
		if stretch {
			track = track.w_full();
		}

		for (index, tab) in self.tabs.into_iter().enumerate() {
			let key = Key::named(Channel::Control, &format!("{id}-{index}"));
			// A tab with nothing to run is the value being shown. It keeps the
			// face and loses the feedback, so the pointer never claims a press
			// that does nothing.
			let live = tab.on_click.is_some();
			let ground = if tab.selected {
				theme.raised
			} else if live {
				paint::wash(cx, key, gpui::transparent_black(), theme.hover())
			} else {
				gpui::transparent_black()
			};
			let ink = if tab.selected {
				theme.text
			} else {
				theme.text_muted
			};

			let mut pill = div()
				.id(ElementId::from(SharedString::from(format!("{id}-{index}"))))
				.flex()
				.items_center()
				.justify_center()
				.gap(px(space::TIGHT))
				.h(px(size.height() - 4.0))
				.px(px(size.pad()))
				.rounded(px(radius::CHIP))
				.bg(ground)
				.text_size(px(size.text()))
				.font_weight(weight::MEDIUM)
				.text_color(ink)
				.children(
					tab.icon
						.map(|glyph| icon::at(glyph, size.glyph() - 2.0, ink)),
				)
				.child(text::line(tab.what));

			if live {
				pill = pill.cursor_pointer().on_hover(move |over, _window, cx| {
					paint::hover(cx, key, *over);
					cx.refresh_windows();
				});
			}

			if stretch {
				pill = pill.flex_1().min_w(px(0.0));
			}
			if tab.selected {
				pill = pill.shadow(theme.shadow_card());
			}
			track = match tab.on_click {
				Some(listener) => {
					track.child(pill.on_click(move |event, window, cx| listener(event, window, cx)))
				},
				None => track.child(pill),
			};
		}
		track
	}
}
