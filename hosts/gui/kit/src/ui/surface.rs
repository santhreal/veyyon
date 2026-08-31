//! Panel and inset well surfaces.
//!
//! These containers encode elevation and clipping without product state.
//! Panels separate by ground; wells add the one-alpha edge required by code,
//! diff, terminal, and preview content.

use gpui::{AnyElement, App, IntoElement, ParentElement, RenderOnce, Styled, Window, div, px};

use crate::theme::{Elevation, Theme, radius, space};

#[derive(IntoElement)]
pub struct Panel {
	children:  Vec<AnyElement>,
	elevation: Elevation,
	pad:       f32,
	gap:       f32,
}
impl Panel {
	pub fn new(elevation: Elevation) -> Self {
		Self { children: Vec::new(), elevation, pad: space::X12, gap: space::X8 }
	}

	pub fn pad(mut self, pad: f32) -> Self {
		self.pad = pad;
		self
	}

	pub fn gap(mut self, gap: f32) -> Self {
		self.gap = gap;
		self
	}
}
impl ParentElement for Panel {
	fn extend(&mut self, items: impl IntoIterator<Item = AnyElement>) {
		self.children.extend(items);
	}
}
impl RenderOnce for Panel {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		div()
			.size_full()
			.flex()
			.flex_col()
			.gap(px(self.gap))
			.p(px(self.pad))
			.bg(theme.elevation(self.elevation))
			.children(self.children)
	}
}

#[derive(IntoElement)]
pub struct Well {
	children: Vec<AnyElement>,
	pad:      f32,
}
impl Well {
	pub fn new() -> Self {
		Self { children: Vec::new(), pad: 0.0 }
	}

	pub fn pad(mut self, pad: f32) -> Self {
		self.pad = pad;
		self
	}
}
impl Default for Well {
	fn default() -> Self {
		Self::new()
	}
}
impl ParentElement for Well {
	fn extend(&mut self, items: impl IntoIterator<Item = AnyElement>) {
		self.children.extend(items);
	}
}
impl RenderOnce for Well {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		div()
			.flex()
			.flex_col()
			.overflow_hidden()
			.rounded(px(radius::CARD))
			.bg(theme.sunken)
			.border_1()
			.border_color(theme.stroke)
			.p(px(self.pad))
			.children(self.children)
	}
}

/// How far a floating surface is from what it covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Float {
	/// A menu, a popover, a toast, a tooltip: anchored to the thing it came
	/// from, and close to it.
	Menu,
	/// A sheet over the whole window, which is the furthest anything floats.
	Sheet,
}

/// The treatment every floating thing carries: a face lit from the top, an edge
/// that holds against a backdrop of any luminance, and the shadow its distance
/// earns.
///
/// One trait rather than a fill and a shadow restated at each float, because a
/// float that picks its own two reads as a card that happens to be on top: a
/// tooltip took the overlay ground flat, the same ground as the sheet under it,
/// and the two surfaces met with nothing between them.
pub trait Floating: Styled + Sized {
	fn floating(self, theme: &Theme, kind: Float, corner: f32) -> Self {
		self
			.rounded(px(corner))
			.bg(theme.float_face().background())
			.border_1()
			.border_color(theme.float_edge())
			.shadow(match kind {
				Float::Menu => theme.lift_menu(),
				Float::Sheet => theme.lift_sheet(),
			})
	}
}

impl<T: Styled + Sized> Floating for T {}
