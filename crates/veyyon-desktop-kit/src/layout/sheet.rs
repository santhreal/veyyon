//! Sheet docked edge overlay container primitive (§8.25).

use veyyon_gpui::{AnyElement, App, IntoElement, RenderOnce, Window, div, prelude::*};

use crate::{
	geometry::SheetAnchor,
	token_set::{ColorRole, RadiusStep, SpacingStep, TokenSet},
};

/// Docked edge-anchored overlay container with fixed elevation and border
/// treatment.
#[derive(IntoElement)]
pub struct Sheet {
	anchor: SheetAnchor,
	child:  AnyElement,
}

impl Sheet {
	/// Creates a bottom-docked sheet container.
	#[must_use]
	pub fn bottom(child: impl IntoElement) -> Self {
		Self { anchor: SheetAnchor::Bottom, child: child.into_any_element() }
	}

	/// Creates a right-docked sheet container.
	#[must_use]
	pub fn right(child: impl IntoElement) -> Self {
		Self { anchor: SheetAnchor::Right, child: child.into_any_element() }
	}

	/// Creates a left-docked sheet container.
	#[must_use]
	pub fn left(child: impl IntoElement) -> Self {
		Self { anchor: SheetAnchor::Left, child: child.into_any_element() }
	}

	/// Creates a top-docked sheet container.
	#[must_use]
	pub fn top(child: impl IntoElement) -> Self {
		Self { anchor: SheetAnchor::Top, child: child.into_any_element() }
	}
}

impl RenderOnce for Sheet {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let bg = tokens.color(ColorRole::Float);
		let border_color = tokens.color(ColorRole::Hairline);
		let radius = tokens.radius(RadiusStep::Xl);
		let pad = tokens.spacing(SpacingStep::S4);

		let mut el = div()
			.bg(bg)
			.p(pad)
			.border_1()
			.border_color(border_color)
			.shadow_lg();

		match self.anchor {
			SheetAnchor::Bottom => {
				el = el.w_full().rounded_t(radius);
			},
			SheetAnchor::Top => {
				el = el.w_full().rounded_b(radius);
			},
			SheetAnchor::Right => {
				el = el.h_full().rounded_l(radius);
			},
			SheetAnchor::Left => {
				el = el.h_full().rounded_r(radius);
			},
		}

		el.child(self.child)
	}
}
