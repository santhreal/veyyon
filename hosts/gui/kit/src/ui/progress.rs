//! Determinate progress and non-animated loading skeleton.
//!
//! Progress samples one retained width property; updates retarget with the
//! catalog meter tween. Skeleton geometry is static, so loading does not create
//! an ornamental idle clock and reduced motion is visually equivalent.

use gpui::{App, IntoElement, ParentElement, RenderOnce, Styled, Window, div, px};

use super::{Meter, Tone};
use crate::{
	motion::{MotionKey, Property, RetainedKey},
	paint,
	theme::{Theme, radius, row, space},
};

#[derive(IntoElement)]
pub struct Progress {
	owner:  RetainedKey,
	value:  f32,
	label:  Option<gpui::SharedString>,
	figure: Option<gpui::SharedString>,
	tone:   Tone,
}
impl Progress {
	pub fn new(owner: RetainedKey, value: f32) -> Self {
		Self { owner, value: value.clamp(0.0, 1.0), label: None, figure: None, tone: Tone::Accent }
	}

	pub fn label(mut self, label: impl Into<gpui::SharedString>) -> Self {
		self.label = Some(label.into());
		self
	}

	pub fn figure(mut self, figure: impl Into<gpui::SharedString>) -> Self {
		self.figure = Some(figure.into());
		self
	}

	pub fn tone(mut self, tone: Tone) -> Self {
		self.tone = tone;
		self
	}
}
impl RenderOnce for Progress {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let value =
			paint::sample(cx, MotionKey::new(self.owner, Property::Width), self.value).clamp(0.0, 1.0);
		let mut meter = Meter::new(value).tone(self.tone);
		if let Some(label) = self.label {
			meter = meter.what(label);
		}
		if let Some(figure) = self.figure {
			meter = meter.figure(figure);
		}
		meter
	}
}

#[derive(IntoElement)]
pub struct Skeleton {
	rows: u8,
}
impl Skeleton {
	pub fn new(rows: u8) -> Self {
		Self { rows: rows.clamp(1, 8) }
	}
}
impl RenderOnce for Skeleton {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let mut root = div().flex().flex_col().gap(px(space::X6)).w_full();
		for index in 0..self.rows {
			let width = match index % 3 {
				0 => 0.84,
				1 => 0.66,
				_ => 0.74,
			};
			root = root.child(
				div()
					.h(px(row::compact()))
					.w(gpui::relative(width))
					.rounded(px(radius::ROW))
					.bg(theme.hover()),
			);
		}
		root
	}
}
