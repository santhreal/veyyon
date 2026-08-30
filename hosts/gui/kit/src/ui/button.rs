//! Something to press.
//!
//! One control, three fills, two sizes, six tones. A header's glyph, a
//! composer's send, a dialog's confirm and a row's trailing action are all
//! this, which is why they hover, press and round the same way.
//!
//! A glyph-only button always carries a tooltip, because an icon alone is a
//! guess. The tooltip names the action in the words the command palette uses,
//! and adds the keystroke when there is one, so the three ways to reach a thing
//! agree on what it is called.

use gpui::{
	App, ClickEvent, ElementId, InteractiveElement, IntoElement, MouseButton, ParentElement,
	RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use super::{Fill, Icon, Size, Tone, icon, square, text};
use crate::{
	motion::{self, Channel, Key},
	paint,
	theme::{Theme, radius, weight},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// A press.
#[derive(IntoElement)]
pub struct Button {
	id:       SharedString,
	icon:     Option<Icon>,
	label:    Option<SharedString>,
	tone:     Tone,
	fill:     Fill,
	size:     Size,
	tip:      Option<SharedString>,
	keys:     Option<SharedString>,
	enabled:  bool,
	/// Drawn as though the pointer were over it, for a control whose state is
	/// on: a panel toggle while the panel is open.
	on:       bool,
	on_click: Option<Click>,
}

impl Button {
	/// A button drawn as a glyph. `id` is the element id and the address of its
	/// hover, so two buttons with one id share a wash.
	pub fn new(id: impl Into<SharedString>, icon: Icon) -> Button {
		Button {
			id:       id.into(),
			icon:     Some(icon),
			label:    None,
			tone:     Tone::Muted,
			fill:     Fill::Ghost,
			size:     Size::Base,
			tip:      None,
			keys:     None,
			enabled:  true,
			on:       false,
			on_click: None,
		}
	}

	/// A button drawn as words.
	pub fn labelled(id: impl Into<SharedString>, label: impl Into<SharedString>) -> Button {
		Button {
			id:       id.into(),
			icon:     None,
			label:    Some(label.into()),
			tone:     Tone::Plain,
			fill:     Fill::Ghost,
			size:     Size::Base,
			tip:      None,
			keys:     None,
			enabled:  true,
			on:       false,
			on_click: None,
		}
	}

	/// Words next to the glyph. A glyph-only button is the default; this is for
	/// the one or two places where the action has to be spelled out.
	pub fn label(mut self, label: impl Into<SharedString>) -> Button {
		self.label = Some(label.into());
		self
	}

	pub fn icon(mut self, icon: Icon) -> Button {
		self.icon = Some(icon);
		self
	}

	pub fn tone(mut self, tone: Tone) -> Button {
		self.tone = tone;
		self
	}

	pub fn fill(mut self, fill: Fill) -> Button {
		self.fill = fill;
		self
	}

	pub fn size(mut self, size: Size) -> Button {
		self.size = size;
		self
	}

	/// What it does, in the palette's words.
	pub fn tip(mut self, what: impl Into<SharedString>) -> Button {
		self.tip = Some(what.into());
		self
	}

	/// The chord that does the same thing, written the way the keys table
	/// writes it.
	pub fn keys(mut self, keys: impl Into<SharedString>) -> Button {
		self.keys = Some(keys.into());
		self
	}

	/// A button that cannot be pressed: drawn faint, no hover, no click.
	///
	/// Not hidden. A control that disappears when it cannot be used takes its
	/// explanation with it.
	pub fn enabled(mut self, enabled: bool) -> Button {
		self.enabled = enabled;
		self
	}

	/// A toggle whose state is on, drawn as held rather than as hovered.
	pub fn on(mut self, on: bool) -> Button {
		self.on = on;
		self
	}

	pub fn on_click(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Button {
		self.on_click = Some(Box::new(listener));
		self
	}
}

impl RenderOnce for Button {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let key = Key::named(Channel::Control, self.id.as_ref());
		let glyph_only = self.label.is_none();
		let height = self.size.height();

		let (rest, hovered, ink) = self.grounds(&theme);
		let ground = if !self.enabled {
			rest
		} else if self.on {
			hovered
		} else {
			paint::wash(cx, key, rest, hovered)
		};

		let tip = self.tip.clone();
		let keys = self.keys.clone();
		let enabled = self.enabled;

		let mut element = div()
			.id(ElementId::from(self.id.clone()))
			.flex()
			.flex_none()
			.items_center()
			.justify_center()
			.h(px(height))
			.rounded(px(if glyph_only {
				radius::PILL
			} else {
				radius::ROW
			}))
			.bg(ground)
			.text_size(px(self.size.text()))
			.font_weight(weight::MEDIUM)
			.text_color(ink);

		element = if glyph_only {
			element.w(px(height))
		} else {
			element.px(px(self.size.pad())).gap(px(self.size.gap()))
		};

		let element = element
			.children(
				self
					.icon
					.map(|glyph| square(height).child(icon::at(glyph, self.size.glyph(), ink))),
			)
			.children(self.label.map(text::line));

		let element = match (tip, keys) {
			(Some(what), Some(keys)) => {
				element.tooltip(move |_window, cx| super::Tip::keyed(what.clone(), keys.clone(), cx))
			},
			(Some(what), None) => {
				element.tooltip(move |_window, cx| super::Tip::view(what.clone(), cx))
			},
			(None, _) => element,
		};

		if !enabled {
			return element.cursor_default();
		}

		let element = element
			.cursor_pointer()
			.on_hover(move |over, _window, cx| {
				paint::hover(cx, key, *over);
				cx.refresh_windows();
			})
			.on_mouse_down(MouseButton::Left, |_event, _window, cx| {
				// A press inside a row must not also select the row it sits in.
				cx.stop_propagation();
			});

		match self.on_click {
			Some(listener) => element.on_click(move |event, window, cx| {
				paint::flip(cx, key, false, motion::WASH);
				listener(event, window, cx);
			}),
			None => element,
		}
	}
}

impl Button {
	/// The three colours a fill decides: at rest, under the pointer, and the ink
	/// on top of both.
	fn grounds(&self, theme: &Theme) -> (gpui::Hsla, gpui::Hsla, gpui::Hsla) {
		if !self.enabled {
			return (gpui::transparent_black(), gpui::transparent_black(), theme.text_faint);
		}
		match self.fill {
			Fill::Ghost => {
				let ink = self.tone.ink(theme);
				(gpui::transparent_black(), theme.hover(), ink)
			},
			Fill::Tinted => {
				let ink = self.tone.ink(theme);
				let rest = self.tone.tint(theme);
				(rest, motion::mix(rest, ink, 0.14), ink)
			},
			Fill::Solid => {
				let (rest, ink) = self.tone.solid(theme);
				(rest, motion::mix(rest, ink, 0.14), ink)
			},
		}
	}
}
