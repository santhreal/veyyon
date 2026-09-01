//! List virtualized container primitive (§8.25).

use std::sync::Arc;

use veyyon_gpui::{AnyElement, App, IntoElement, RenderOnce, Window, div, prelude::*};

use crate::token_set::{SpacingStep, TokenSet};

/// Vertical list container rendering items through an indexed builder closure.
#[derive(IntoElement)]
pub struct List {
	item_count:  usize,
	render_item: Arc<dyn Fn(usize, &mut Window, &mut App) -> AnyElement + 'static>,
}

impl List {
	/// Creates a list with item count and item render generator closure.
	#[must_use]
	pub fn new(
		item_count: usize,
		render_item: impl Fn(usize, &mut Window, &mut App) -> AnyElement + 'static,
	) -> Self {
		Self { item_count, render_item: Arc::new(render_item) }
	}
}

impl RenderOnce for List {
	fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);
		let gap = tokens.spacing(SpacingStep::S1);

		let mut container = div().w_full().flex().flex_col().gap(gap);

		for idx in 0..self.item_count {
			let item = (self.render_item)(idx, window, cx);
			container = container.child(item);
		}

		container
	}
}
