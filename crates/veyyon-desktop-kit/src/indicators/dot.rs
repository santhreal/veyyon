//! Status dot indicator primitive (§8.25).
//!
//! A 6px mark (§5.6) in a tint's ink or a colour role, or an empty slot of the
//! same size so a column of rows whose first entry has no state keeps its
//! titles aligned. A surface that authors the mark's size states it with
//! `sized`, and the dot draws at the spacing step otherwise.

use veyyon_gpui::{App, IntoElement, Pixels, RenderOnce, Window, div, prelude::*};

use crate::token_set::{ColorRole, RadiusStep, SpacingStep, TintRole, TokenSet};

/// What the dot is inked with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DotInk {
	Tint(TintRole),
	Role(ColorRole),
	Empty,
}

/// Status indicator dot.
#[derive(IntoElement)]
pub struct Dot {
	ink:  DotInk,
	size: Option<Pixels>,
}

impl Dot {
	/// A dot in the ink of a semantic tint.
	#[must_use]
	pub const fn new(tint: TintRole) -> Self {
		Self { ink: DotInk::Tint(tint), size: None }
	}

	/// A dot in a colour role, for a state that has no tint pair.
	#[must_use]
	pub const fn role(role: ColorRole) -> Self {
		Self { ink: DotInk::Role(role), size: None }
	}

	/// The dot's slot with nothing drawn in it.
	#[must_use]
	pub const fn empty() -> Self {
		Self { ink: DotInk::Empty, size: None }
	}

	/// The mark at the size the surface authored, rather than the spacing
	/// step the kit falls back to.
	#[must_use]
	pub const fn sized(mut self, size: Pixels) -> Self {
		self.size = Some(size);
		self
	}
}

impl RenderOnce for Dot {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;
		let fill = match self.ink {
			DotInk::Tint(tint) => tokens.tint(tint).ink,
			DotInk::Role(role) => tokens.color(role),
			DotInk::Empty => tokens.transparent(),
		};
		let size = self.size.unwrap_or_else(|| tokens.spacing(SpacingStep::S3));
		let radius = tokens.radius(RadiusStep::Full);

		div().flex_shrink_0().size(size).rounded(radius).bg(fill)
	}
}
