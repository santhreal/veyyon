//! An indeterminate progress indicator.

use std::f32::consts::TAU;

use veyyon_gpui::{
	App, ElementId, Hsla, IntoElement, Pixels, RenderOnce, Window, div,
	motion::{Timestamp, loaders::cycle_phase},
	prelude::*,
	radians,
};

use crate::{
	icons::{Icon, IconName},
	theme::{ActiveTheme, motion, size},
};

/// The `loader-circle` glyph turning once every [`motion::SPIN_PERIOD`].
///
/// The angle is read from the frame clock at each render, and the spinner
/// requests the next animation frame of the view that draws it, so frames are
/// requested only while it is mounted. Under reduced motion it draws a static
/// [`size::DOT`] and requests no frame.
#[derive(IntoElement)]
pub struct Spinner {
	id:    ElementId,
	size:  Pixels,
	color: Option<Hsla>,
}

impl Spinner {
	/// A [`size::ICON`] spinner in the muted text color. `id` keys the instant
	/// the spinner started turning, so it is unique among its siblings.
	pub fn new(id: impl Into<ElementId>) -> Self {
		Self { id: id.into(), size: size::ICON, color: None }
	}

	/// Sets the edge of the square the glyph fills.
	pub const fn size(mut self, size: Pixels) -> Self {
		self.size = size;
		self
	}

	/// Sets the color of the glyph.
	pub const fn color(mut self, color: Hsla) -> Self {
		self.color = Some(color);
		self
	}
}

impl RenderOnce for Spinner {
	fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
		let color = self.color.unwrap_or_else(|| cx.theme().palette.text.muted);
		if cx.reduce_motion() {
			return div()
				.flex()
				.flex_none()
				.items_center()
				.justify_center()
				.size(self.size)
				.child(div().size(size::DOT).rounded_full().bg(color))
				.into_any_element();
		}
		let started = window.use_keyed_state(self.id, cx, |_, cx| cx.frame_instant());
		let elapsed = cx.frame_instant().seconds_since(*started.read(cx));
		window.request_animation_frame();
		let angle = radians(cycle_phase(elapsed, motion::SPIN_PERIOD) * TAU);
		Icon::new(IconName::LoaderCircle)
			.size(self.size)
			.color(color)
			.rotate(angle)
			.into_any_element()
	}
}
