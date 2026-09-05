//! List virtualized container primitive (§8.25).

use std::sync::Arc;

use veyyon_gpui::{AnyElement, App, ElementId, IntoElement, RenderOnce, Window, div, prelude::*};

use crate::token_set::{SpacingStep, TokenSet};

/// Vertical list container rendering items through an indexed builder closure.
#[derive(IntoElement)]
pub struct List {
	id:          Option<ElementId>,
	item_count:  usize,
	gap:         SpacingStep,
	render_item: Arc<dyn Fn(usize, &mut Window, &mut App) -> AnyElement + 'static>,
}

impl List {
	/// Creates a list with item count and item render generator closure.
	#[must_use]
	pub fn new(
		item_count: usize,
		render_item: impl Fn(usize, &mut Window, &mut App) -> AnyElement + 'static,
	) -> Self {
		Self { id: None, item_count, gap: SpacingStep::S1, render_item: Arc::new(render_item) }
	}

	/// Sets an element id, which makes the list a vertically scrolling
	/// container that fills its parent rather than a stack that clips.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = Some(id.into());
		self
	}

	/// Sets the gap between rows.
	#[must_use]
	pub fn gap(mut self, gap: SpacingStep) -> Self {
		self.gap = gap;
		self
	}
}

impl RenderOnce for List {
	fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);
		let gap = tokens.spacing(self.gap);

		let items: Vec<AnyElement> = (0..self.item_count)
			.map(|idx| (self.render_item)(idx, window, cx))
			.collect();
		let container = div().w_full().flex().flex_col().gap(gap);
		match self.id {
			Some(id) => container
				.id(id)
				.flex_1()
				.overflow_y_scroll()
				.children(items)
				.into_any_element(),
			None => container.children(items).into_any_element(),
		}
	}
}
