//! One glyph of the icon set, drawn as a mask in a color.

use veyyon_gpui::{
	App, Hsla, IntoElement, Pixels, Radians, RenderOnce, Styled, Transformation, Window, svg,
};

use super::IconName;
use crate::theme::size;

/// A square glyph of the icon set.
///
/// The glyph paints in `color`, or in the inherited text color when no color
/// is set. It is [`size::ICON`] on each edge unless [`Self::size`] sets
/// another edge.
#[derive(Clone, Copy, Debug, IntoElement)]
pub struct Icon {
	name:   IconName,
	size:   Pixels,
	color:  Option<Hsla>,
	rotate: Option<Radians>,
}

impl Icon {
	/// The glyph `name` at [`size::ICON`] in the inherited text color.
	pub const fn new(name: IconName) -> Self {
		Self { name, size: size::ICON, color: None, rotate: None }
	}

	/// Sets the edge of the square the glyph fills.
	pub const fn size(mut self, size: Pixels) -> Self {
		self.size = size;
		self
	}

	/// Sets the color the glyph paints in.
	pub const fn color(mut self, color: Hsla) -> Self {
		self.color = Some(color);
		self
	}

	/// Rotates the glyph about its center. Layout and hit testing keep the
	/// unrotated square.
	pub const fn rotate(mut self, angle: Radians) -> Self {
		self.rotate = Some(angle);
		self
	}
}

impl RenderOnce for Icon {
	fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
		let mut glyph = svg().path(self.name.path()).size(self.size).flex_none();
		if let Some(color) = self.color {
			glyph = glyph.text_color(color);
		}
		if let Some(angle) = self.rotate {
			glyph = glyph.with_transformation(Transformation::rotate(angle));
		}
		glyph
	}
}
