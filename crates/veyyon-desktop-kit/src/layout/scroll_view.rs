//! Scroll view container primitive (§8.25).

use veyyon_gpui::{
	AnyElement, App, Hsla, IntoElement, Pixels, RenderOnce, Window, div, linear_color_stop,
	linear_gradient, prelude::*, px,
};

use crate::{
	geometry::Axis,
	token_set::{ColorRole, TokenSet},
};

/// Scroll view container primitive with directional scroll bars and edge-fade
/// falloff.
#[derive(IntoElement)]
pub struct ScrollView {
	axis:       Option<Axis>,
	child:      AnyElement,
	edge_fade:  bool,
	fade_size:  Option<Pixels>,
	fade_color: Option<Hsla>,
}

impl ScrollView {
	/// Creates a scroll view with child content.
	#[must_use]
	pub fn new(child: impl IntoElement) -> Self {
		Self {
			axis:       None,
			child:      child.into_any_element(),
			edge_fade:  true,
			fade_size:  None,
			fade_color: None,
		}
	}

	/// Constrains scrolling to a single axis.
	#[must_use]
	pub fn axis(mut self, axis: Axis) -> Self {
		self.axis = Some(axis);
		self
	}

	/// Enables or disables edge-fade falloff at the scroll boundaries.
	#[must_use]
	pub fn edge_fade(mut self, enabled: bool) -> Self {
		self.edge_fade = enabled;
		self
	}

	/// Sets the depth of the edge-fade falloff in pixels.
	#[must_use]
	pub fn fade_size(mut self, size: Pixels) -> Self {
		self.fade_size = Some(size);
		self
	}

	/// Sets an explicit fade color (defaults to surrounding ground/canvas).
	#[must_use]
	pub fn fade_color(mut self, color: Hsla) -> Self {
		self.fade_color = Some(color);
		self
	}
}

impl RenderOnce for ScrollView {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
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

		let content = el.child(self.child);

		if !self.edge_fade {
			return div().relative().w_full().h_full().child(content);
		}

		let resolved_tokens = TokenSet::for_app(cx);
		let fade_c = self
			.fade_color
			.unwrap_or_else(|| resolved_tokens.color(ColorRole::Canvas));
		let fade_size = self
			.fade_size
			.unwrap_or_else(|| px(resolved_tokens.controls().scroll_fade_px));

		let mut container = div()
			.relative()
			.w_full()
			.h_full()
			.overflow_hidden()
			.child(content);

		match self.axis {
			Some(Axis::Vertical) | None => {
				container =
					container
						.child(div().absolute().top_0().left_0().right_0().h(fade_size).bg(
							linear_gradient(
								180.0,
								linear_color_stop(fade_c, 0.0),
								linear_color_stop(fade_c.opacity(0.0), 1.0),
							),
						))
						.child(
							div()
								.absolute()
								.bottom_0()
								.left_0()
								.right_0()
								.h(fade_size)
								.bg(linear_gradient(
									180.0,
									linear_color_stop(fade_c.opacity(0.0), 0.0),
									linear_color_stop(fade_c, 1.0),
								)),
						);
			},
			Some(Axis::Horizontal) => {
				container = container
					.child(
						div()
							.absolute()
							.top_0()
							.bottom_0()
							.left_0()
							.w(fade_size)
							.bg(linear_gradient(
								90.0,
								linear_color_stop(fade_c, 0.0),
								linear_color_stop(fade_c.opacity(0.0), 1.0),
							)),
					)
					.child(
						div()
							.absolute()
							.top_0()
							.bottom_0()
							.right_0()
							.w(fade_size)
							.bg(linear_gradient(
								90.0,
								linear_color_stop(fade_c.opacity(0.0), 0.0),
								linear_color_stop(fade_c, 1.0),
							)),
					);
			},
		}

		container
	}
}
