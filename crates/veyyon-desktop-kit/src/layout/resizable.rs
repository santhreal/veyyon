//! Resizable container primitive with splitter handle (§8.25).

use std::sync::Arc;

use veyyon_gpui::{AnyElement, App, ElementId, IntoElement, RenderOnce, Window, div, prelude::*};

use crate::{
	geometry::Axis,
	token_set::{ColorRole, StrokeStep, TokenSet},
};

/// Resizable split container with draggable separator handle.
#[derive(IntoElement)]
pub struct Resizable {
	axis:          Axis,
	first:         AnyElement,
	second:        AnyElement,
	initial_ratio: f32,
	on_resize:     Option<Arc<dyn Fn(f32, &mut Window, &mut App) + Send + Sync + 'static>>,
}

impl Resizable {
	/// Creates a resizable split container.
	#[must_use]
	pub fn new(axis: Axis, first: impl IntoElement, second: impl IntoElement) -> Self {
		Self {
			axis,
			first: first.into_any_element(),
			second: second.into_any_element(),
			initial_ratio: 0.5,
			on_resize: None,
		}
	}

	/// Sets initial split ratio in range [0.0, 1.0].
	#[must_use]
	pub fn ratio(mut self, ratio: f32) -> Self {
		self.initial_ratio = ratio.clamp(0.05, 0.95);
		self
	}

	/// Sets split resize callback.
	#[must_use]
	pub fn on_resize(
		mut self,
		handler: impl Fn(f32, &mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_resize = Some(Arc::new(handler));
		self
	}
}

impl RenderOnce for Resizable {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let handle_color = tokens.color(ColorRole::Hairline);
		let stroke_px = tokens.stroke(StrokeStep::Hairline);

		let handle = match self.axis {
			Axis::Horizontal => div()
				.id(ElementId::from("resize-handle-h"))
				.w(stroke_px)
				.h_full()
				.bg(handle_color)
				.cursor_col_resize(),
			Axis::Vertical => div()
				.id(ElementId::from("resize-handle-v"))
				.h(stroke_px)
				.w_full()
				.bg(handle_color)
				.cursor_row_resize(),
		};

		let mut container = div().w_full().h_full().flex();

		match self.axis {
			Axis::Horizontal => {
				container = container
					.flex_row()
					.child(div().flex_1().child(self.first))
					.child(handle)
					.child(div().flex_1().child(self.second));
			},
			Axis::Vertical => {
				container = container
					.flex_col()
					.child(div().flex_1().child(self.first))
					.child(handle)
					.child(div().flex_1().child(self.second));
			},
		}

		container
	}
}
