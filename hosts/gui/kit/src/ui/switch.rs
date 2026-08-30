//! On or off, and which it is at a glance.
//!
//! The knob travels; it does not appear at the other end. The travel is the
//! whole of what a switch says, and a knob that teleports leaves a reader
//! checking the colour to find out what happened.
//!
//! A switch is for a setting that takes effect the moment it changes. A choice
//! that needs confirming is a [`Button`](super::Button), and a choice between
//! more than two things is a [`Select`](super::Select) or
//! [`Tabs`](super::Tabs).

use gpui::{
	App, ClickEvent, ElementId, InteractiveElement, IntoElement, ParentElement, RenderOnce,
	SharedString, StatefulInteractiveElement, Styled, Window, div, px,
};

use crate::{
	motion::{self, Channel, Key},
	paint,
	theme::Theme,
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

const TRACK_W: f32 = 34.0;
const TRACK_H: f32 = 20.0;
const KNOB: f32 = 16.0;

/// A setting that is on or off.
#[derive(IntoElement)]
pub struct Switch {
	id:       SharedString,
	on:       bool,
	on_click: Option<Click>,
}

impl Switch {
	pub fn new(id: impl Into<SharedString>, on: bool) -> Switch {
		Switch { id: id.into(), on, on_click: None }
	}

	pub fn on_click(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Switch {
		self.on_click = Some(Box::new(listener));
		self
	}
}

impl RenderOnce for Switch {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let key = Key::named(Channel::Control, self.id.as_ref());
		let travel = paint::toward(cx, key, motion::GLIDE, f32::from(u8::from(self.on)));

		let track = motion::mix(theme.sunken, theme.accent, travel);
		let knob = if self.on {
			theme.text_on_accent
		} else {
			theme.text_muted
		};
		let slide = motion::lerp(2.0, TRACK_W - KNOB - 2.0, travel);

		let element = div()
			.id(ElementId::from(self.id.clone()))
			.flex()
			.flex_none()
			.relative()
			.w(px(TRACK_W))
			.h(px(TRACK_H))
			.rounded_full()
			.bg(track)
			.border_1()
			.border_color(if self.on {
				gpui::transparent_black()
			} else {
				theme.stroke
			})
			.child(
				div()
					.absolute()
					.top(px((TRACK_H - KNOB) / 2.0 - 1.0))
					.left(px(slide))
					.size(px(KNOB))
					.rounded_full()
					.bg(knob)
					.shadow(theme.shadow_card()),
			);

		match self.on_click {
			Some(listener) => element
				.cursor_pointer()
				.on_click(move |event, window, cx| listener(event, window, cx)),
			None => element,
		}
	}
}
