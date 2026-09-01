//! Plain-data layout box tree captured from layout passes.
//!
//! WHY THIS TYPE LIVES HERE: gpui layout trees are tied to the window and
//! renderer context. To evaluate clutter metrics without linking gpui or
//! creating a window, the tree is captured into plain arena-allocated data.

pub mod tree;

pub use tree::{LayoutBoxTree, LayoutBoxTreeBuilder, LayoutError};

use crate::frame::RgbaColor;

/// Identifier for a node in a [`LayoutBoxTree`].
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BoxId(pub u32);

/// Axis-aligned bounding rectangle in logical pixels.
#[derive(Copy, Clone, Debug, PartialEq, Default)]
pub struct BoxBounds {
	pub left:   f32,
	pub top:    f32,
	pub right:  f32,
	pub bottom: f32,
}

impl BoxBounds {
	pub const ZERO: Self = Self { left: 0.0, top: 0.0, right: 0.0, bottom: 0.0 };

	pub const fn new(left: f32, top: f32, right: f32, bottom: f32) -> Self {
		Self { left, top, right, bottom }
	}

	pub fn width(&self) -> f32 {
		(self.right - self.left).max(0.0)
	}

	pub fn height(&self) -> f32 {
		(self.bottom - self.top).max(0.0)
	}

	pub fn area(&self) -> f32 {
		self.width() * self.height()
	}

	pub fn center(&self) -> (f32, f32) {
		((self.left + self.right) * 0.5, (self.top + self.bottom) * 0.5)
	}

	pub const fn is_empty(&self) -> bool {
		self.left >= self.right || self.top >= self.bottom
	}

	pub fn intersects(&self, other: &Self) -> bool {
		self.left < other.right
			&& self.right > other.left
			&& self.top < other.bottom
			&& self.bottom > other.top
	}

	pub const fn union(&self, other: &Self) -> Self {
		let left = if self.left < other.left {
			self.left
		} else {
			other.left
		};
		let top = if self.top < other.top {
			self.top
		} else {
			other.top
		};
		let right = if self.right > other.right {
			self.right
		} else {
			other.right
		};
		let bottom = if self.bottom > other.bottom {
			self.bottom
		} else {
			other.bottom
		};
		Self { left, top, right, bottom }
	}

	pub fn overlap_y(&self, other: &Self) -> f32 {
		(self.bottom.min(other.bottom) - self.top.max(other.top)).max(0.0)
	}

	pub fn overlap_x(&self, other: &Self) -> f32 {
		(self.right.min(other.right) - self.left.max(other.left)).max(0.0)
	}
}
/// Border styling for a layout box.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct BorderPaint {
	pub width: f32,
	pub color: RgbaColor,
}

/// Divider orientation for a layout box.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum DividerAxis {
	Vertical,
	Horizontal,
}

/// Text styling and font size for a layout box.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct TextPaint {
	pub font_size: f32,
}

/// An individual layout node in a [`LayoutBoxTree`].
#[derive(Clone, Debug, PartialEq)]
pub struct LayoutBox {
	pub id:          BoxId,
	pub parent:      Option<BoxId>,
	pub children:    Vec<BoxId>,
	pub bounds:      BoxBounds,
	pub visible:     bool,
	pub interactive: bool,
	pub fill:        Option<RgbaColor>,
	pub border:      Option<BorderPaint>,
	pub divider:     Option<DividerAxis>,
	pub text:        Option<TextPaint>,
}

impl LayoutBox {
	/// True when the box renders visible ink.
	pub fn is_painted(&self) -> bool {
		if !self.visible {
			return false;
		}
		let has_fill = self.fill.is_some_and(|f| !f.is_invisible());
		let has_border = self
			.border
			.is_some_and(|b| b.width > 0.0 && !b.color.is_invisible());
		let has_divider = self.divider.is_some();
		let has_text = self.text.is_some();
		has_fill || has_border || has_divider || has_text
	}
}

/// Specification used to construct a [`LayoutBox`].
#[derive(Clone, Debug, PartialEq)]
pub struct LayoutBoxSpec {
	pub bounds:      BoxBounds,
	pub visible:     bool,
	pub interactive: bool,
	pub fill:        Option<RgbaColor>,
	pub border:      Option<BorderPaint>,
	pub divider:     Option<DividerAxis>,
	pub text:        Option<TextPaint>,
}

impl Default for LayoutBoxSpec {
	fn default() -> Self {
		Self {
			bounds:      BoxBounds::ZERO,
			visible:     true,
			interactive: false,
			fill:        None,
			border:      None,
			divider:     None,
			text:        None,
		}
	}
}

impl LayoutBoxSpec {
	pub const fn new() -> Self {
		Self {
			bounds:      BoxBounds::ZERO,
			visible:     true,
			interactive: false,
			fill:        None,
			border:      None,
			divider:     None,
			text:        None,
		}
	}

	pub const fn bounds(mut self, bounds: BoxBounds) -> Self {
		self.bounds = bounds;
		self
	}

	pub const fn rect(mut self, left: f32, top: f32, right: f32, bottom: f32) -> Self {
		self.bounds = BoxBounds::new(left, top, right, bottom);
		self
	}

	pub const fn visible(mut self, visible: bool) -> Self {
		self.visible = visible;
		self
	}

	pub const fn interactive(mut self, interactive: bool) -> Self {
		self.interactive = interactive;
		self
	}

	pub const fn fill(mut self, color: RgbaColor) -> Self {
		self.fill = Some(color);
		self
	}

	pub const fn border(mut self, width: f32, color: RgbaColor) -> Self {
		self.border = Some(BorderPaint { width, color });
		self
	}

	pub const fn divider(mut self, axis: DividerAxis) -> Self {
		self.divider = Some(axis);
		self
	}

	pub const fn text(mut self, font_size: f32) -> Self {
		self.text = Some(TextPaint { font_size });
		self
	}
}
