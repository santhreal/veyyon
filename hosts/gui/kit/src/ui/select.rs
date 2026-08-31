//! Current-value select trigger.
//!
//! The menu and open state remain parent values. A select with no listener is a
//! read-only value; a disabled select requires and displays a reason.

use gpui::{
	App, ClickEvent, ElementId, InteractiveElement, IntoElement, MouseButton, ParentElement,
	RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use super::{Icon, Size, Tone, icon, square, text};
use crate::{
	motion::{Damage, MotionKey, Priority, Property, RetainedKey, mix, spec},
	paint,
	theme::{Theme, radius, size, space, weight},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

#[derive(IntoElement)]
pub struct Select {
	id:              SharedString,
	owner:           RetainedKey,
	value:           SharedString,
	what:            Option<SharedString>,
	icon:            Option<Icon>,
	tone:            Tone,
	size:            Size,
	open:            bool,
	disabled_reason: Option<SharedString>,
	on_click:        Option<Click>,
}

impl Select {
	pub fn new(
		id: impl Into<SharedString>,
		owner: RetainedKey,
		value: impl Into<SharedString>,
	) -> Self {
		Self {
			id: id.into(),
			owner,
			value: value.into(),
			what: None,
			icon: None,
			tone: Tone::Plain,
			size: Size::Base,
			open: false,
			disabled_reason: None,
			on_click: None,
		}
	}

	pub fn what(mut self, what: impl Into<SharedString>) -> Self {
		self.what = Some(what.into());
		self
	}

	pub fn icon(mut self, icon: Icon) -> Self {
		self.icon = Some(icon);
		self
	}

	pub fn tone(mut self, tone: Tone) -> Self {
		self.tone = tone;
		self
	}

	pub fn size(mut self, size: Size) -> Self {
		self.size = size;
		self
	}

	pub fn open(mut self, open: bool) -> Self {
		self.open = open;
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

impl RenderOnce for Select {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let key = MotionKey::new(self.owner, Property::ColorMix);
		let live = self.on_click.is_some() && self.disabled_reason.is_none();
		let blend = if self.open {
			1.0
		} else if live {
			paint::sample(cx, key, 0.0)
		} else {
			0.0
		};
		let ground = mix(gpui::transparent_black(), theme.hover(), blend);
		let face = div()
			.id(ElementId::from(self.id.clone()))
			.flex()
			.flex_none()
			.items_center()
			.gap(px(self.size.gap()))
			.h(px(self.size.height()))
			.px(px(self.size.pad()))
			.rounded(px(radius::CONTROL))
			.bg(ground)
			.text_size(px(self.size.text()))
			.text_color(if self.disabled_reason.is_some() {
				theme.text_faint
			} else {
				self.tone.ink(&theme)
			})
			.children(self.icon.map(|glyph| {
				square(self.size.glyph()).child(icon::at(glyph, self.size.glyph(), theme.text_faint))
			}))
			.children(self.what.map(|what| {
				text::line(what)
					.text_size(px(size::meta()))
					.text_color(theme.text_faint)
			}))
			.child(text::line(self.value).font_weight(weight::MEDIUM))
			.child(div().ml(px(space::TIGHT)).child(icon::at(
				Icon::Folded,
				self.size.glyph(),
				theme.text_faint,
			)));
		let face = match self.disabled_reason {
			Some(reason) => face.tooltip(move |_window, cx| super::Tip::view(reason.clone(), cx)),
			None => face,
		};
		let Some(listener) = self.on_click.filter(|_| live) else {
			return face.cursor_default();
		};
		face
			.cursor_pointer()
			.on_hover(move |over, _window, cx| {
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
			})
			.on_mouse_down(MouseButton::Left, |_event, _window, cx| cx.stop_propagation())
			.on_click(move |event, window, cx| listener(event, window, cx))
	}
}
