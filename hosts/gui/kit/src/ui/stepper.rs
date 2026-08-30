//! A number, one step at a time.
//!
//! Text size, a width, a count of retries. A stepper is for a number whose
//! steps are the only values worth setting; a number typed freely is an input,
//! and a number with a ceiling worth seeing is a [`Meter`](super::Meter).
//!
//! The value sits between the two buttons and is drawn in the monospace family,
//! so it does not shift the buttons as it goes from 9 to 10.
//!
//! Each end reports whether it can still move, and a stepper at its limit draws
//! that end faint rather than removing it: a control that disappears at the
//! boundary takes the explanation with it.

use gpui::{
	App, ClickEvent, IntoElement, ParentElement, RenderOnce, SharedString, Styled, Window, div, px,
};

use super::{Button, Fill, Icon, Size, Tone, text};
use crate::theme::{Theme, radius, size, space, weight};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// A number with a step either side.
#[derive(IntoElement)]
pub struct Stepper {
	id:      SharedString,
	value:   SharedString,
	/// What the value is, under it: the unit, or nothing when the number speaks
	/// for itself.
	unit:    Option<SharedString>,
	down:    bool,
	up:      bool,
	size:    Size,
	on_down: Option<Click>,
	on_up:   Option<Click>,
}

impl Stepper {
	pub fn new(id: impl Into<SharedString>, value: impl Into<SharedString>) -> Stepper {
		Stepper {
			id:      id.into(),
			value:   value.into(),
			unit:    None,
			down:    true,
			up:      true,
			size:    Size::Base,
			on_down: None,
			on_up:   None,
		}
	}

	pub fn unit(mut self, unit: impl Into<SharedString>) -> Stepper {
		self.unit = Some(unit.into());
		self
	}

	/// Whether each end can still move. A stepper at its floor draws the down
	/// step faint and does nothing when it is pressed.
	pub fn limits(mut self, down: bool, up: bool) -> Stepper {
		self.down = down;
		self.up = up;
		self
	}

	pub fn size(mut self, size: Size) -> Stepper {
		self.size = size;
		self
	}

	pub fn on_down(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Stepper {
		self.on_down = Some(Box::new(listener));
		self
	}

	pub fn on_up(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Stepper {
		self.on_up = Some(Box::new(listener));
		self
	}
}

impl RenderOnce for Stepper {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let step = self.size;
		let mut less = Button::new(format!("{}-less", self.id), Icon::Less)
			.tone(Tone::Muted)
			.fill(Fill::Ghost)
			.size(step)
			.tip("Less")
			.enabled(self.down);
		if let Some(listener) = self.on_down {
			less = less.on_click(move |event, window, cx| listener(event, window, cx));
		}
		let mut more = Button::new(format!("{}-more", self.id), Icon::More)
			.tone(Tone::Muted)
			.fill(Fill::Ghost)
			.size(step)
			.tip("More")
			.enabled(self.up);
		if let Some(listener) = self.on_up {
			more = more.on_click(move |event, window, cx| listener(event, window, cx));
		}

		text::line_of(space::TIGHT)
			.flex_none()
			.p(px(2.0))
			.rounded(px(radius::CHIP + 2.0))
			.bg(theme.sunken)
			.child(less)
			.child(
				text::stack(0.0)
					.min_w(px(46.0))
					.items_center()
					.child(
						div()
							.font_family(theme.font_mono)
							.text_size(px(step.text()))
							.font_weight(weight::MEDIUM)
							.text_color(theme.text)
							.child(self.value),
					)
					.children(self.unit.map(|unit| {
						div()
							.text_size(px(size::META))
							.text_color(theme.text_faint)
							.child(unit)
					})),
			)
			.child(more)
	}
}
