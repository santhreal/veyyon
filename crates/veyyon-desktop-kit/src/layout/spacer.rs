//! Spacer and Divider layout primitives (§8.25).

use veyyon_gpui::{App, IntoElement, RenderOnce, Window, div, prelude::*};

use crate::{
	geometry::Orientation,
	token_set::{ColorRole, SpacingStep, StrokeStep, TokenSet},
};

/// Empty space layout element providing tokenized gaps.
#[derive(IntoElement)]
pub struct Spacer {
	step: SpacingStep,
}

impl Spacer {
	/// Creates a spacer with discrete spacing step.
	#[must_use]
	pub fn new(step: SpacingStep) -> Self {
		Self { step }
	}

	/// Creates a flexible expanding spacer.
	#[must_use]
	pub fn flex() -> Self {
		Self { step: SpacingStep::S0 }
	}
}

impl RenderOnce for Spacer {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);
		let size = tokens.spacing(self.step);

		if self.step == SpacingStep::S0 {
			div().flex_1()
		} else {
			div().size(size)
		}
	}
}

/// 1px Hairline boundary line element for surface sections.
#[derive(IntoElement)]
pub struct Divider {
	orientation: Orientation,
	margin:      SpacingStep,
}

impl Divider {
	/// Creates a horizontal divider.
	#[must_use]
	pub fn horizontal() -> Self {
		Self { orientation: Orientation::Horizontal, margin: SpacingStep::S0 }
	}

	/// Creates a vertical divider.
	#[must_use]
	pub fn vertical() -> Self {
		Self { orientation: Orientation::Vertical, margin: SpacingStep::S0 }
	}

	/// Sets margin surrounding the divider line.
	#[must_use]
	pub fn margin(mut self, margin: SpacingStep) -> Self {
		self.margin = margin;
		self
	}
}

impl RenderOnce for Divider {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);
		let line_color = tokens.color(ColorRole::Hairline);
		let stroke_px = tokens.stroke(StrokeStep::Hairline);
		let margin_px = tokens.spacing(self.margin);

		match self.orientation {
			Orientation::Horizontal => div()
				.w_full()
				.min_w(tokens.spacing(SpacingStep::S13))
				.h(stroke_px)
				.min_h(stroke_px)
				.flex_shrink_0()
				.bg(line_color)
				.my(margin_px),
			Orientation::Vertical => div()
				.h_full()
				.min_h(tokens.spacing(SpacingStep::S13))
				.w(stroke_px)
				.min_w(stroke_px)
				.flex_shrink_0()
				.bg(line_color)
				.mx(margin_px),
		}
	}
}
