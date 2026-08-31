//! Activity-rail route item.
//!
//! The rail keeps a 48 px optical box. A selected route has both an accent
//! marker and held fill; icon-only presentation always includes the route name
//! as a tooltip.

use gpui::{
	App, ClickEvent, IntoElement, ParentElement, RenderOnce, SharedString, Styled, Window, div, px,
};

use super::{Button, Fill, Icon, Tone};
use crate::{
	motion::RetainedKey,
	theme::{Theme, layout, radius, space},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

#[derive(IntoElement)]
pub struct ActivityItem {
	id:       SharedString,
	owner:    RetainedKey,
	icon:     Icon,
	label:    SharedString,
	selected: bool,
	badge:    Option<gpui::AnyElement>,
	on_click: Option<Click>,
}
impl ActivityItem {
	pub fn new(
		id: impl Into<SharedString>,
		owner: RetainedKey,
		icon: Icon,
		label: impl Into<SharedString>,
	) -> Self {
		Self {
			id: id.into(),
			owner,
			icon,
			label: label.into(),
			selected: false,
			badge: None,
			on_click: None,
		}
	}

	pub fn selected(mut self, selected: bool) -> Self {
		self.selected = selected;
		self
	}

	pub fn badge(mut self, badge: impl IntoElement) -> Self {
		self.badge = Some(badge.into_any_element());
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
impl RenderOnce for ActivityItem {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let mut button = Button::new(self.id, self.owner, self.icon)
			.tip(self.label)
			.on(self.selected)
			.fill(if self.selected {
				Fill::Tinted
			} else {
				Fill::Ghost
			})
			.tone(if self.selected {
				Tone::Accent
			} else {
				Tone::Muted
			});
		if let Some(listener) = self.on_click {
			button = button.on_click(listener);
		}
		div()
			.relative()
			.flex()
			.items_center()
			.justify_center()
			.size(px(layout::activity_rail()))
			.children(self.selected.then(|| {
				div()
					.absolute()
					.left(px(0.0))
					.h(px(space::X20))
					.w(px(space::X2))
					.rounded(px(radius::CONTROL))
					.bg(theme.accent)
			}))
			.child(button)
			.children(self.badge.map(|badge| {
				div()
					.absolute()
					.right(px(space::X4))
					.top(px(space::X4))
					.child(badge)
			}))
	}
}
