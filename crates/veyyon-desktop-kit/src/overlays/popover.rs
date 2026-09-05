//! Popover floating container primitive (§8.25).
//!
//! The container is drawn through GPUI's `anchored` element inside a
//! `deferred` layer, so it floats above the surface that opened it, sits at the
//! window-space origin the caller measured, and flips its corner rather than
//! overflowing the window edge.

use veyyon_gpui::{
	Anchor, AnyElement, App, IntoElement, Pixels, Point, RenderOnce, Window, anchored, deferred,
	div, prelude::*,
};

use crate::{
	geometry::AnchorCorner,
	token_set::{ColorRole, RadiusStep, SpacingStep, TokenSet},
};

/// Maps a kit anchor corner onto the renderer's anchor.
const fn renderer_anchor(corner: AnchorCorner) -> Anchor {
	match corner {
		AnchorCorner::TopLeft => Anchor::TopLeft,
		AnchorCorner::TopRight => Anchor::TopRight,
		AnchorCorner::BottomLeft => Anchor::BottomLeft,
		AnchorCorner::BottomRight => Anchor::BottomRight,
	}
}

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
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;

		let bg = tokens.color(ColorRole::Float);
		let border_color = tokens.color(ColorRole::Hairline);
		let radius = tokens.radius(RadiusStep::Xl);
		let pad = tokens.spacing(SpacingStep::S4);
		let margin = tokens.spacing(SpacingStep::S2);

		let card = div()
			.occlude()
			.bg(bg)
			.rounded(radius)
			.border_1()
			.border_color(border_color)
			.p(pad)
			.shadow_lg()
			.child(div().min_w_0().overflow_hidden().child(self.child));

		deferred(
			anchored()
				.position(self.origin)
				.anchor(renderer_anchor(self.anchor))
				.snap_to_window_with_margin(margin)
				.child(card),
		)
		.with_priority(1)
	}
}
