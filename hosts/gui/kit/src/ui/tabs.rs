//! Tabs and segmented controls.
//!
//! Each tab has retained identity. Selection crossfades on an event-time track;
//! model state still supplies the final selected value. Stretch mode reserves
//! equal slots and clips long labels without changing neighboring geometry.

use gpui::{
	App, ClickEvent, ElementId, InteractiveElement, IntoElement, ParentElement, RenderOnce,
	SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use super::{Icon, Size, icon, text};
use crate::{
	motion::{Damage, MotionKey, Priority, Property, RetainedKey, mix, spec},
	paint,
	theme::{Theme, radius, space, weight},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

pub struct Tab {
	owner:           RetainedKey,
	what:            SharedString,
	icon:            Option<Icon>,
	selected:        bool,
	disabled_reason: Option<SharedString>,
	on_click:        Option<Click>,
}
impl Tab {
	pub fn new(owner: RetainedKey, what: impl Into<SharedString>, selected: bool) -> Self {
		Self { owner, what: what.into(), icon: None, selected, disabled_reason: None, on_click: None }
	}

	pub fn icon(mut self, icon: Icon) -> Self {
		self.icon = Some(icon);
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

#[derive(IntoElement)]
pub struct Tabs {
	id:      SharedString,
	tabs:    Vec<Tab>,
	size:    Size,
	stretch: bool,
}
impl Tabs {
	pub fn new(id: impl Into<SharedString>) -> Self {
		Self { id: id.into(), tabs: Vec::new(), size: Size::Small, stretch: false }
	}

	pub fn tab(mut self, tab: Tab) -> Self {
		self.tabs.push(tab);
		self
	}

	pub fn size(mut self, size: Size) -> Self {
		self.size = size;
		self
	}

	pub fn stretch(mut self) -> Self {
		self.stretch = true;
		self
	}
}

impl RenderOnce for Tabs {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let mut track = div()
			.id(ElementId::from(self.id))
			.flex()
			.items_center()
			.gap(px(space::X2))
			.p(px(space::X2))
			.rounded(px(radius::POPOVER))
			.bg(theme.sunken);
		for tab in self.tabs {
			let key = MotionKey::new(tab.owner, Property::ColorMix);
			let endpoint = u8::from(tab.selected) as f32;
			let selection = paint::sample(cx, key, endpoint);
			let live = tab.on_click.is_some() && tab.disabled_reason.is_none();
			let fill = mix(gpui::transparent_black(), theme.raised, selection);
			let mut pill = div()
				.id(ElementId::from(tab.what.clone()))
				.flex()
				.items_center()
				.justify_center()
				.gap(px(self.size.gap()))
				.h(px(self.size.height()))
				.px(px(self.size.pad()))
				.min_w(px(0.0))
				.rounded(px(radius::CONTROL))
				.bg(fill)
				.text_size(px(self.size.text()))
				.font_weight(weight::MEDIUM)
				.text_color(if live || tab.selected {
					theme.text
				} else {
					theme.text_faint
				})
				.children(
					tab.icon
						.map(|glyph| icon::at(glyph, self.size.glyph(), theme.text_muted)),
				)
				.child(text::line(tab.what).overflow_hidden());
			if self.stretch {
				pill = pill.flex_1().min_w(px(0.0));
			}
			if tab.selected {
				pill = pill.shadow(theme.shadow_card());
			}
			pill = match tab.disabled_reason {
				Some(reason) => pill.tooltip(move |_window, cx| super::Tip::view(reason.clone(), cx)),
				None => pill,
			};
			track = match tab.on_click.filter(|_| live) {
				Some(listener) => {
					track.child(pill.cursor_pointer().on_click(move |event, window, cx| {
						let _ = paint::retarget(
							cx,
							key,
							spec::SELECT,
							1.0,
							Priority::Selected,
							Damage::Paint(0),
						);
						listener(event, window, cx);
					}))
				},
				None => track.child(pill),
			};
		}
		track
	}
}
