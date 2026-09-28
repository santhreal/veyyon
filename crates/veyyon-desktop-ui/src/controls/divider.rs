//! A one-pixel rule between regions or groups.

use veyyon_gpui::{App, IntoElement, RenderOnce, Window, div, prelude::*};

use crate::theme::ActiveTheme;

/// The direction a [`Divider`] runs in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DividerAxis {
	/// Spans the width of its parent.
	Horizontal,
	/// Spans the height of its parent.
	Vertical,
}

/// A one-pixel rule in the subtle border color.
#[derive(Clone, Copy, Debug, IntoElement)]
pub struct Divider {
	axis: DividerAxis,
}

impl Divider {
	/// A rule across the width of its parent.
	pub const fn horizontal() -> Self {
		Self { axis: DividerAxis::Horizontal }
	}

	/// A rule down the height of its parent.
	pub const fn vertical() -> Self {
		Self { axis: DividerAxis::Vertical }
	}
}

impl RenderOnce for Divider {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let rule = div().flex_none().bg(cx.theme().palette.border.subtle);
		match self.axis {
			DividerAxis::Horizontal => rule.w_full().h_px(),
			DividerAxis::Vertical => rule.h_full().w_px(),
		}
	}
}
