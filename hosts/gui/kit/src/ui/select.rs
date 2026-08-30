//! A choice, showing what is chosen.
//!
//! The model in the composer, the mode, a theme, a font. A select says the
//! current value on its face, because a control that says only "Model" makes a
//! reader open it to find out what is set.
//!
//! WHAT OPENS IS THE CALLER'S. This is the face; the list is a
//! [`Menu`](super::Menu) the surface anchors under it, because the surface owns
//! whether it is open and what it holds. A select with no `on_click` is a value
//! that cannot be changed, which is what a select for a fixed value looks like.

use gpui::{
	App, ClickEvent, ElementId, InteractiveElement, IntoElement, MouseButton, ParentElement,
	RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use super::{Icon, Size, Tone, icon, square, text};
use crate::{
	motion::{Channel, Key},
	paint,
	theme::{Theme, radius, size, space, weight},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// The face of a choice.
#[derive(IntoElement)]
pub struct Select {
	id:       SharedString,
	value:    SharedString,
	/// What the value is of, in front of it: for a select whose value is not
	/// self-describing.
	what:     Option<SharedString>,
	icon:     Option<Icon>,
	tone:     Tone,
	size:     Size,
	/// Drawn as held, because its menu is open.
	open:     bool,
	on_click: Option<Click>,
}

impl Select {
	pub fn new(id: impl Into<SharedString>, value: impl Into<SharedString>) -> Select {
		Select {
			id:       id.into(),
			value:    value.into(),
			what:     None,
			icon:     None,
			tone:     Tone::Plain,
			size:     Size::Base,
			open:     false,
			on_click: None,
		}
	}

	pub fn what(mut self, what: impl Into<SharedString>) -> Select {
		self.what = Some(what.into());
		self
	}

	pub fn icon(mut self, icon: Icon) -> Select {
		self.icon = Some(icon);
		self
	}

	pub fn tone(mut self, tone: Tone) -> Select {
		self.tone = tone;
		self
	}

	pub fn size(mut self, size: Size) -> Select {
		self.size = size;
		self
	}

	pub fn open(mut self, open: bool) -> Select {
		self.open = open;
		self
	}

	pub fn on_click(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Select {
		self.on_click = Some(Box::new(listener));
		self
	}
}

impl RenderOnce for Select {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let key = Key::named(Channel::Control, self.id.as_ref());
		// A select with nothing to open is a value being shown. It takes the
		// same face and none of the feedback: a control that lights under the
		// pointer and does nothing when pressed is worse than a plain line.
		let live = self.on_click.is_some();
		let ground = if self.open {
			theme.hover()
		} else if live {
			paint::wash(cx, key, gpui::transparent_black(), theme.hover())
		} else {
			gpui::transparent_black()
		};

		let face = div()
			.id(ElementId::from(self.id.clone()))
			.flex()
			.flex_none()
			.items_center()
			.gap(px(self.size.gap()))
			.h(px(self.size.height()))
			.px(px(self.size.pad() - 2.0))
			.rounded(px(radius::CHIP))
			.bg(ground)
			.text_size(px(self.size.text()))
			.text_color(self.tone.ink(&theme))
			.children(self.icon.map(|glyph| {
				square(self.size.glyph()).child(icon::at(glyph, self.size.glyph(), theme.text_faint))
			}))
			.children(self.what.map(|what| {
				text::line(what)
					.text_size(px(size::META))
					.text_color(theme.text_faint)
			}))
			.child(text::line(self.value).font_weight(weight::MEDIUM))
			.child(div().ml(px(space::TIGHT - 2.0)).child(icon::at(
				Icon::Folded,
				self.size.glyph() - 2.0,
				theme.text_faint,
			)));

		let Some(listener) = self.on_click else {
			return face.cursor_default();
		};
		face
			.cursor_pointer()
			.on_hover(move |over, _window, cx| {
				paint::hover(cx, key, *over);
				cx.refresh_windows();
			})
			.on_mouse_down(MouseButton::Left, |_event, _window, cx| cx.stop_propagation())
			.on_click(move |event, window, cx| listener(event, window, cx))
	}
}
