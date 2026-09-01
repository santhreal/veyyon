//! Palette command palette overlay container primitive (§8.25).

use veyyon_gpui::{AnyElement, App, IntoElement, RenderOnce, Window, div, prelude::*};

use crate::token_set::{ColorRole, RadiusStep, SpacingStep, TokenSet};

/// Command palette floating modal container with search header and results
/// list.
#[derive(IntoElement)]
pub struct Palette {
	search:  AnyElement,
	results: AnyElement,
}

impl Palette {
	/// Creates a palette container with search element and results element.
	#[must_use]
	pub fn new(search: impl IntoElement, results: impl IntoElement) -> Self {
		Self { search: search.into_any_element(), results: results.into_any_element() }
	}
}

impl RenderOnce for Palette {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let bg = tokens.color(ColorRole::Float);
		let border_color = tokens.color(ColorRole::Hairline);
		let radius = tokens.radius(RadiusStep::Xl);
		let pad = tokens.spacing(SpacingStep::S4);
		let gap = tokens.spacing(SpacingStep::S3);

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
			.flex()
			.flex_col()
			.gap(gap)
			.child(div().w_full().min_w_0().overflow_hidden().child(self.search))
			.child(div().w_full().min_w_0().overflow_hidden().child(self.results))
	}
}
