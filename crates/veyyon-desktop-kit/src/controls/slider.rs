//! Slider continuous value input primitive (§8.25).

use std::sync::Arc;

use veyyon_gpui::{App, ElementId, IntoElement, RenderOnce, Window, div, prelude::*};

use crate::token_set::{ColorRole, RadiusStep, SpacingStep, TokenSet};

/// Continuous range slider primitive element.
#[derive(IntoElement)]
pub struct Slider {
	id:        Option<ElementId>,
	value:     f32,
	min:       f32,
	max:       f32,
	on_change: Option<Arc<dyn Fn(f32, &mut Window, &mut App) + Send + Sync + 'static>>,
}

impl Slider {
	/// Creates a slider with current value and bounds.
	#[must_use]
	pub fn new(value: f32, min: f32, max: f32) -> Self {
		Self { id: None, value, min, max, on_change: None }
	}

	/// Sets element ID.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = Some(id.into());
		self
	}

	/// Sets value change callback.
	#[must_use]
	pub fn on_change(
		mut self,
		handler: impl Fn(f32, &mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_change = Some(Arc::new(handler));
		self
	}
}

impl RenderOnce for Slider {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let track_height = tokens.spacing(SpacingStep::S1);
		let thumb_size = tokens.spacing(SpacingStep::S4);
		let radius = tokens.radius(RadiusStep::Full);

		let track_bg = tokens.color(ColorRole::Inset);
		let fill_bg = tokens.color(ColorRole::Accent);
		let thumb_bg = tokens.color(ColorRole::Foreground);

		let thumb = div()
			.size(thumb_size)
			.rounded(radius)
			.bg(thumb_bg)
			.shadow_sm();

		let track = div()
			.w_full()
			.h(track_height)
			.rounded(radius)
			.bg(track_bg)
			.relative()
			.child(
				div()
					.h_full()
					.rounded(radius)
					.bg(fill_bg)
					.w(tokens.spacing(SpacingStep::S10)),
			);

		let id = self.id.unwrap_or_else(|| ElementId::from("slider"));
		let mut container = div()
			.id(id)
			.w_full()
			.py(tokens.spacing(SpacingStep::S2))
			.flex()
			.items_center()
			.cursor_pointer()
			.child(track)
			.child(thumb);

		if let Some(handler) = self.on_change {
			let next_val = (self.value + (self.max - self.min) * 0.1).min(self.max);
			container = container.on_click(move |_, window, cx| handler(next_val, window, cx));
		}

		container
	}
}
