//! Scroll view container primitive (§8.25).

use veyyon_gpui::{AnyElement, App, IntoElement, RenderOnce, Window, div, prelude::*};

use crate::geometry::Axis;

/// Scroll view container primitive with directional scroll bars.
#[derive(IntoElement)]
pub struct ScrollView {
	axis:  Option<Axis>,
	child: AnyElement,
}

impl ScrollView {
	/// Creates a scroll view with child content.
	#[must_use]
	pub fn new(child: impl IntoElement) -> Self {
		Self { axis: None, child: child.into_any_element() }
	}

	/// Constrains scrolling to a single axis.
	#[must_use]
	pub fn axis(mut self, axis: Axis) -> Self {
		self.axis = Some(axis);
		self
	}
}

impl RenderOnce for ScrollView {
	fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
		let mut el = div().w_full().h_full();

		match self.axis {
			Some(Axis::Vertical) => {
				el = el.overflow_x_hidden();
			},
			Some(Axis::Horizontal) => {
				el = el.overflow_y_hidden();
			},
			None => {
				el = el.overflow_hidden();
			},
		}

		el.child(self.child)
	}
}
