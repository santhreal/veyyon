//! Status Dot indicator primitive (§8.25).

use veyyon_gpui::{App, IntoElement, RenderOnce, Window, div, prelude::*};

use crate::token_set::{RadiusStep, SpacingStep, TintRole, TokenSet};

/// Status indicator dot with semantic tint fill.
#[derive(IntoElement)]
pub struct Dot {
	tint:    TintRole,
	pulsing: bool,
}

impl Dot {
	/// Creates a status dot with semantic tint.
	#[must_use]
	pub fn new(tint: TintRole) -> Self {
		Self { tint, pulsing: false }
	}

	/// Configures whether the dot has active pulsing motion.
	#[must_use]
	pub fn pulsing(mut self, pulsing: bool) -> Self {
		self.pulsing = pulsing;
		self
	}
}

impl RenderOnce for Dot {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);
		let tint_pair = tokens.tint(self.tint);
		let size = tokens.spacing(SpacingStep::S2);
		let radius = tokens.radius(RadiusStep::Full);

		div().size(size).rounded(radius).bg(tint_pair.fill)
	}
}
