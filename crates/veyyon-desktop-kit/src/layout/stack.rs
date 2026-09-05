//! Stack and Row layout container primitives (§8.25).

use veyyon_gpui::{AnyElement, App, IntoElement, RenderOnce, Window, div, prelude::*};

use crate::{
	geometry::{Axis, VerticalAlignment},
	token_set::{SpacingStep, TokenSet},
};

/// Flex container stacking children along a primary axis with tokenized spacing
/// gaps.
#[derive(IntoElement)]
pub struct Stack {
	axis:     Axis,
	gap:      SpacingStep,
	children: Vec<AnyElement>,
}

impl Stack {
	/// Creates a vertical stack with a discrete gap step.
	#[must_use]
	pub fn vertical(gap: SpacingStep) -> Self {
		Self { axis: Axis::Vertical, gap, children: Vec::new() }
	}

	/// Creates a horizontal stack with a discrete gap step.
	#[must_use]
	pub fn horizontal(gap: SpacingStep) -> Self {
		Self { axis: Axis::Horizontal, gap, children: Vec::new() }
	}

	/// Appends a child element to the stack.
	#[must_use]
	pub fn child(mut self, child: impl IntoElement) -> Self {
		self.children.push(child.into_any_element());
		self
	}

	/// Appends multiple child elements to the stack.
	#[must_use]
	pub fn children(mut self, children: impl IntoIterator<Item = impl IntoElement>) -> Self {
		for c in children {
			self.children.push(c.into_any_element());
		}
		self
	}
}

impl RenderOnce for Stack {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;
		let gap_px = tokens.spacing(self.gap);

		let mut el = div().flex().gap(gap_px);

		match self.axis {
			Axis::Vertical => {
				el = el.flex_col();
			},
			Axis::Horizontal => {
				el = el.flex_row().items_center();
			},
		}

		el.children(self.children)
	}
}

/// Horizontal row layout container with vertical alignment options.
#[derive(IntoElement)]
pub struct Row {
	gap:       SpacingStep,
	alignment: VerticalAlignment,
	children:  Vec<AnyElement>,
}

impl Row {
	/// Creates a horizontal row with discrete gap step.
	#[must_use]
	pub fn new(gap: SpacingStep) -> Self {
		Self { gap, alignment: VerticalAlignment::Center, children: Vec::new() }
	}

	/// Sets vertical item alignment.
	#[must_use]
	pub fn alignment(mut self, alignment: VerticalAlignment) -> Self {
		self.alignment = alignment;
		self
	}

	/// Appends a child element to the row.
	#[must_use]
	pub fn child(mut self, child: impl IntoElement) -> Self {
		self.children.push(child.into_any_element());
		self
	}

	/// Appends multiple child elements to the row.
	#[must_use]
	pub fn children(mut self, children: impl IntoIterator<Item = impl IntoElement>) -> Self {
		for c in children {
			self.children.push(c.into_any_element());
		}
		self
	}
}

impl RenderOnce for Row {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;
		let gap_px = tokens.spacing(self.gap);

		let mut el = div().flex().flex_row().gap(gap_px);

		match self.alignment {
			VerticalAlignment::Top => {
				el = el.items_start();
			},
			VerticalAlignment::Center => {
				el = el.items_center();
			},
			VerticalAlignment::Bottom => {
				el = el.items_end();
			},
		}

		el.children(self.children)
	}
}
