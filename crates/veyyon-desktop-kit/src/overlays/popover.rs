//! Popover floating container primitive (§8.25).

use veyyon_gpui::{
	AnyElement, App, IntoElement, Pixels, Point, RenderOnce, Window, div, prelude::*,
};

use crate::{
	geometry::AnchorCorner,
	token_set::{ColorRole, RadiusStep, SpacingStep, TokenSet},
};

/// Anchored floating popover container with elevation level 4 glass styling.
#[derive(IntoElement)]
pub struct Popover {
	origin: Point<Pixels>,
	anchor: AnchorCorner,
	child:  AnyElement,
}

impl Popover {
	/// Creates a popover with origin point and anchor corner.
	#[must_use]
	pub fn new(origin: Point<Pixels>, anchor: AnchorCorner, child: impl IntoElement) -> Self {
		Self { origin, anchor, child: child.into_any_element() }
	}

	/// Returns anchor origin point.
	#[must_use]
	pub fn origin(&self) -> Point<Pixels> {
		self.origin
	}

	/// Returns anchor corner.
	#[must_use]
	pub fn anchor(&self) -> AnchorCorner {
		self.anchor
	}
}

impl RenderOnce for Popover {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let bg = tokens.color(ColorRole::Float);
		let border_color = tokens.color(ColorRole::Hairline);
		let radius = tokens.radius(RadiusStep::Xl);
		let pad = tokens.spacing(SpacingStep::S4);

		div()
			.w_full()
			.max_w_full()
			.overflow_hidden()
			.bg(bg)
			.rounded(radius)
			.border_1()
			.border_color(border_color)
			.p(pad)
			.shadow_lg()
			.child(div().w_full().min_w_0().overflow_hidden().child(self.child))
	}
}
