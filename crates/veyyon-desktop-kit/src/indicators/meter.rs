//! Meter determinate bounded capacity gauge primitive (§8.25).

use veyyon_gpui::{App, IntoElement, Pixels, RenderOnce, Window, div, prelude::*};

use crate::token_set::{ColorRole, RadiusStep, SpacingStep, TokenSet};

/// Determinate horizontal capacity bar meter.
#[derive(IntoElement)]
pub struct Meter {
	fraction: f32,
}

impl Meter {
	/// Creates a capacity meter with fraction [0.0, 1.0].
	#[must_use]
	pub fn new(fraction: f32) -> Self {
		Self { fraction: fraction.clamp(0.0, 1.0) }
	}

	/// Returns current gauge fraction.
	#[must_use]
	pub fn fraction(&self) -> f32 {
		self.fraction
	}
}

impl RenderOnce for Meter {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let track_h: Pixels = tokens.spacing(SpacingStep::S1);
		let radius = tokens.radius(RadiusStep::Full);
		let track_bg = tokens.color(ColorRole::Inset);
		let fill_bg = tokens.color(ColorRole::Accent);

		let fill_width = tokens.spacing(SpacingStep::S10) * self.fraction;

		div()
			.w_full()
			.h(track_h)
			.rounded(radius)
			.bg(track_bg)
			.overflow_hidden()
			.child(div().h_full().w(fill_width).rounded(radius).bg(fill_bg))
	}
}
