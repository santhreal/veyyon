//! Palette command palette overlay container primitive (§8.25).
//!
//! The float: search on top, results filling the middle, an optional footer
//! of key hints. The slots bring their own insets, so the surface's palette
//! tokens set the row heights and the primitive sets the float's edge.

use veyyon_gpui::{
	AnyElement, App, ElementId, IntoElement, Pixels, RenderOnce, Window, div, prelude::*,
};

use crate::token_set::{ColorRole, RadiusStep, TokenSet};

/// Command palette floating modal container with search header and results
/// list.
#[derive(IntoElement)]
pub struct Palette {
	id:         Option<ElementId>,
	search:     AnyElement,
	results:    AnyElement,
	footer:     Option<AnyElement>,
	width:      Option<Pixels>,
	max_height: Option<Pixels>,
}

impl Palette {
	/// Creates a palette container with search element and results element.
	#[must_use]
	pub fn new(search: impl IntoElement, results: impl IntoElement) -> Self {
		Self {
			id:         None,
			search:     search.into_any_element(),
			results:    results.into_any_element(),
			footer:     None,
			width:      None,
			max_height: None,
		}
	}

	/// Sets the element id.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = Some(id.into());
		self
	}

	/// Sets the footer slot, drawn under the results behind a hairline.
	#[must_use]
	pub fn footer(mut self, footer: impl IntoElement) -> Self {
		self.footer = Some(footer.into_any_element());
		self
	}

	/// Sets a fixed width; unset, the float fills its parent.
	#[must_use]
	pub fn width(mut self, width: Pixels) -> Self {
		self.width = Some(width);
		self
	}

	/// Sets the height the float stops growing at.
	#[must_use]
	pub fn max_height(mut self, max_height: Pixels) -> Self {
		self.max_height = Some(max_height);
		self
	}
}

impl RenderOnce for Palette {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let bg = tokens.color(ColorRole::Float);
		let border_color = tokens.color(ColorRole::Hairline);
		let radius = tokens.radius(RadiusStep::Xl);

		let mut el = div()
			.max_w_full()
			.overflow_hidden()
			.bg(bg)
			.rounded(radius)
			.border_1()
			.border_color(border_color)
			.shadow_lg()
			.flex()
			.flex_col();
		el = match self.width {
			Some(width) => el.w(width),
			None => el.w_full(),
		};
		if let Some(max_height) = self.max_height {
			el = el.max_h(max_height);
		}

		el = el
			.child(
				div()
					.w_full()
					.min_w_0()
					.flex_shrink_0()
					.overflow_hidden()
					.border_b_1()
					.border_color(border_color)
					.child(self.search),
			)
			.child(
				div()
					.w_full()
					.min_w_0()
					.flex_1()
					.overflow_hidden()
					.child(self.results),
			);
		if let Some(footer) = self.footer {
			el = el.child(
				div()
					.w_full()
					.min_w_0()
					.flex_shrink_0()
					.overflow_hidden()
					.border_t_1()
					.border_color(border_color)
					.child(footer),
			);
		}

		match self.id {
			Some(id) => el.id(id).into_any_element(),
			None => el.into_any_element(),
		}
	}
}
