//! Numeric stepper with stable button geometry.

use gpui::{
	App, ClickEvent, IntoElement, ParentElement, RenderOnce, SharedString, Styled, Window, div, px,
};

use super::{Button, Fill, Icon, Size, Tone, text};
use crate::{
	motion::RetainedKey,
	theme::{Theme, control, radius, size, space, weight},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

#[derive(IntoElement)]
pub struct Stepper {
	id:         SharedString,
	down_owner: RetainedKey,
	up_owner:   RetainedKey,
	value:      SharedString,
	unit:       Option<SharedString>,
	down:       bool,
	up:         bool,
	size:       Size,
	on_down:    Option<Click>,
	on_up:      Option<Click>,
}
impl Stepper {
	pub fn new(
		id: impl Into<SharedString>,
		down_owner: RetainedKey,
		up_owner: RetainedKey,
		value: impl Into<SharedString>,
	) -> Self {
		Self {
			id: id.into(),
			down_owner,
			up_owner,
			value: value.into(),
			unit: None,
			down: true,
			up: true,
			size: Size::Base,
			on_down: None,
			on_up: None,
		}
	}

	pub fn unit(mut self, unit: impl Into<SharedString>) -> Self {
		self.unit = Some(unit.into());
		self
	}

	pub fn limits(mut self, down: bool, up: bool) -> Self {
		self.down = down;
		self.up = up;
		self
	}

	pub fn size(mut self, size: Size) -> Self {
		self.size = size;
		self
	}

	pub fn on_down(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_down = Some(Box::new(listener));
		self
	}

	pub fn on_up(mut self, listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
		self.on_up = Some(Box::new(listener));
		self
	}
}
impl RenderOnce for Stepper {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let mut less = Button::new(format!("{}-less", self.id), self.down_owner, Icon::Less)
			.tone(Tone::Muted)
			.fill(Fill::Ghost)
			.size(self.size)
			.tip("Decrease");
		less = match (self.down, self.on_down) {
			(true, Some(listener)) => less.on_click(listener),
			(false, _) => less.disabled("Minimum reached"),
			_ => less.disabled("This value cannot be decreased"),
		};
		let mut more = Button::new(format!("{}-more", self.id), self.up_owner, Icon::MoreValue)
			.tone(Tone::Muted)
			.fill(Fill::Ghost)
			.size(self.size)
			.tip("Increase");
		more = match (self.up, self.on_up) {
			(true, Some(listener)) => more.on_click(listener),
			(false, _) => more.disabled("Maximum reached"),
			_ => more.disabled("This value cannot be increased"),
		};
		text::line_of(space::X4)
			.flex_none()
			.p(px(space::X2))
			.rounded(px(radius::POPOVER))
			.bg(theme.sunken)
			.border_1()
			.border_color(theme.stroke)
			.child(less)
			.child(
				div()
					.flex()
					.items_center()
					.justify_center()
					.gap(px(space::X4))
					.min_w(px(control::stepper_value_width()))
					.child(
						div()
							.font_family(theme.font_mono)
							.text_size(px(self.size.text()))
							.font_weight(weight::MEDIUM)
							.text_color(theme.text)
							.child(self.value),
					)
					.children(self.unit.map(|unit| {
						div()
							.text_size(px(size::meta()))
							.text_color(theme.text_faint)
							.child(unit)
					})),
			)
			.child(more)
	}
}
