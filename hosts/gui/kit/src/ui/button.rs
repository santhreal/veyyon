//! Labelled and icon buttons with retained interaction state.
//!
//! The caller supplies a stable [`RetainedKey`](crate::motion::RetainedKey).
//! Icon-only buttons always expose a tooltip; disabled buttons require a
//! reason, shown by the same tooltip rather than becoming unexplained inert
//! controls.

use gpui::{
	App, ClickEvent, ElementId, InteractiveElement, IntoElement, MouseButton, ParentElement,
	RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use super::{Fill, Icon, Size, Tone, icon, square, text};
use crate::{
	motion::{Damage, MotionKey, Priority, Property, RetainedKey, mix, spec},
	paint,
	theme::{Theme, radius, weight},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

#[derive(IntoElement)]
pub struct Button {
	id:              SharedString,
	owner:           RetainedKey,
	icon:            Option<Icon>,
	label:           Option<SharedString>,
	tone:            Tone,
	fill:            Fill,
	size:            Size,
	tip:             Option<SharedString>,
	keys:            Option<SharedString>,
	disabled_reason: Option<SharedString>,
	on:              bool,
	focused:         bool,
	pressed:         bool,
	on_click:        Option<Click>,
}

impl Button {
	pub fn new(id: impl Into<SharedString>, owner: RetainedKey, icon: Icon) -> Self {
		Self {
			id: id.into(),
			owner,
			icon: Some(icon),
			label: None,
			tone: Tone::Muted,
			fill: Fill::Ghost,
			size: Size::Base,
			tip: Some(icon.meaning().into()),
			keys: None,
			disabled_reason: None,
			on: false,
			focused: false,
			pressed: false,
			on_click: None,
		}
	}

	pub fn labelled(
		id: impl Into<SharedString>,
		owner: RetainedKey,
		label: impl Into<SharedString>,
	) -> Self {
		Self {
			id: id.into(),
			owner,
			icon: None,
			label: Some(label.into()),
			tone: Tone::Plain,
			fill: Fill::Ghost,
			size: Size::Base,
			tip: None,
			keys: None,
			disabled_reason: None,
			on: false,
			focused: false,
			pressed: false,
			on_click: None,
		}
	}

	pub fn label(mut self, label: impl Into<SharedString>) -> Self {
		self.label = Some(label.into());
		self
	}

	pub fn icon(mut self, icon: Icon) -> Self {
		self.icon = Some(icon);
		if self.tip.is_none() {
			self.tip = Some(icon.meaning().into());
		}
		self
	}

	pub fn tone(mut self, tone: Tone) -> Self {
		self.tone = tone;
		self
	}

	pub fn fill(mut self, fill: Fill) -> Self {
		self.fill = fill;
		self
	}

	pub fn size(mut self, size: Size) -> Self {
		self.size = size;
		self
	}

	pub fn tip(mut self, what: impl Into<SharedString>) -> Self {
		self.tip = Some(what.into());
		self
	}

	/// Show the chord the keymap gives `command`, if it has one.
	///
	/// The keymap is read rather than restated: a button that spells its own
	/// chord keeps advertising it after the row moves, and a tooltip promising
	/// a keystroke that does nothing is worse than no tooltip.
	pub fn chord(mut self, command: &veyyon_gui_core::UiCommand) -> Self {
		self.keys = veyyon_gui_core::keys::chord_for(command).map(SharedString::new_static);
		self
	}

	pub fn disabled(mut self, reason: impl Into<SharedString>) -> Self {
		self.disabled_reason = Some(reason.into());
		self
	}

	pub fn on(mut self, on: bool) -> Self {
		self.on = on;
		self
	}

	pub fn focused(mut self, focused: bool) -> Self {
		self.focused = focused;
		self
	}

	pub fn pressed(mut self, pressed: bool) -> Self {
		self.pressed = pressed;
		self
	}

	pub fn on_click(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_click = Some(Box::new(listener));
		self
	}

	fn grounds(&self, theme: &Theme, enabled: bool) -> (gpui::Hsla, gpui::Hsla, gpui::Hsla) {
		if !enabled {
			return (gpui::transparent_black(), gpui::transparent_black(), theme.text_faint);
		}
		match self.fill {
			Fill::Ghost => (gpui::transparent_black(), theme.hover(), self.tone.ink(theme)),
			Fill::Tinted => {
				let ink = self.tone.ink(theme);
				let rest = self.tone.tint(theme);
				(rest, mix(rest, ink, 0.14), ink)
			},
			Fill::Solid => {
				let (rest, ink) = self.tone.solid(theme);
				(rest, mix(rest, ink, 0.14), ink)
			},
		}
	}
}

impl RenderOnce for Button {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let enabled = self.disabled_reason.is_none() && self.on_click.is_some();
		let key = MotionKey::new(self.owner, Property::ColorMix);
		let glyph_only = self.label.is_none();
		let height = self.size.height();
		let (rest, hovered, ink) = self.grounds(&theme, enabled);
		let blend = if self.on {
			1.0
		} else {
			paint::sample(cx, key, 0.0)
		};
		let ground = if self.pressed {
			mix(rest, ink, 0.14)
		} else {
			mix(rest, hovered, blend)
		};
		let tooltip = self.disabled_reason.clone().or(self.tip.clone());
		let keys = self.keys.clone();

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
				radius::CONTROL
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
		if self.focused {
			element = element.shadow(theme.focus_ring());
		}
		let box_of = if glyph_only {
			height
		} else {
			self.size.glyph()
		};
		let element = element
			.children(
				self
					.icon
					.map(|glyph| square(box_of).child(icon::at(glyph, self.size.glyph(), ink))),
			)
			.children(self.label.map(text::line));
		let element = match (tooltip, keys) {
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
					Priority::Focused,
					Damage::Paint(0),
				);
				cx.refresh_windows();
			})
			.on_mouse_down(MouseButton::Left, |_event, _window, cx| cx.stop_propagation());
		match self.on_click {
			Some(listener) => element.on_click(move |event, window, cx| listener(event, window, cx)),
			None => element,
		}
	}
}
