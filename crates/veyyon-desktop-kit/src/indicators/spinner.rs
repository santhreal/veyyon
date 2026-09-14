//! Spinner indeterminate progress indicator primitive (§8.25).

use veyyon_gpui::{App, IntoElement, Pixels, RenderOnce, Window, div, prelude::*};

use crate::token_set::{ColorRole, RadiusStep, SpacingStep, TokenSet};

/// Size ramp for spinner indicators.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum SpinnerSize {
	Small,
	#[default]
	Medium,
	Large,
}

impl SpinnerSize {
	/// Resolves spinner dimension in spacing steps.
	#[must_use]
	pub const fn to_spacing_step(self) -> SpacingStep {
		match self {
			Self::Small => SpacingStep::S4,
			Self::Medium => SpacingStep::S6,
			Self::Large => SpacingStep::S8,
		}
	}
}

/// Indeterminate activity indicator spinner element.
#[derive(IntoElement)]
pub struct Spinner {
	size: SpinnerSize,
}

impl Spinner {
	/// Creates a spinner with default medium size.
	#[must_use]
	pub fn new() -> Self {
		Self { size: SpinnerSize::default() }
	}

	/// Sets spinner size.
	#[must_use]
	pub fn size(mut self, size: SpinnerSize) -> Self {
		self.size = size;
		self
	}
}

impl Default for Spinner {
	fn default() -> Self {
		Self::new()
	}
}

impl RenderOnce for Spinner {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;

		let size: Pixels = tokens.spacing(self.size.to_spacing_step());
		let radius = tokens.radius(RadiusStep::Full);
		let color = tokens.color(ColorRole::Accent);

		div()
			.size(size)
			.rounded(radius)
			.border_2()
			.border_color(color)
			.opacity(0.85)
	}
}
