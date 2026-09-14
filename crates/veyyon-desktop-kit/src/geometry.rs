//! Geometry and layout calculation helpers.
//!
//! Provides orientation, alignment, and coordinate math across kit primitives.

use veyyon_gpui::{Pixels, Point, Size, px};

/// Axis alignment for stack and layout primitives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Axis {
	#[default]
	Vertical,
	Horizontal,
}

/// Vertical alignment within horizontal rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum VerticalAlignment {
	Top,
	#[default]
	Center,
	Bottom,
}

/// Horizontal alignment within vertical stacks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum HorizontalAlignment {
	Left,
	#[default]
	Center,
	Right,
}

/// Orientation for dividers and separators.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Orientation {
	#[default]
	Horizontal,
	Vertical,
}

/// Scrollable axis direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum ScrollAxis {
	#[default]
	Vertical,
	Horizontal,
	Both,
}

/// Docked edge anchor for sheet overlay containers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum SheetAnchor {
	#[default]
	Bottom,
	Right,
	Left,
	Top,
}

/// Anchor corner for popovers and tooltips.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum AnchorCorner {
	#[default]
	TopLeft,
	TopRight,
	BottomLeft,
	BottomRight,
}

impl AnchorCorner {
	/// Whether a box anchored at this corner grows to the right of the
	/// anchor point rather than to its left.
	#[must_use]
	pub const fn extends_right(self) -> bool {
		matches!(self, Self::TopLeft | Self::BottomLeft)
	}

	/// Whether a box anchored at this corner grows below the anchor point
	/// rather than above it.
	#[must_use]
	pub const fn extends_down(self) -> bool {
		matches!(self, Self::TopLeft | Self::TopRight)
	}

	/// The corner a box grows right or left and down or up from.
	#[must_use]
	pub const fn from_edges(extends_right: bool, extends_down: bool) -> Self {
		match (extends_right, extends_down) {
			(true, true) => Self::TopLeft,
			(false, true) => Self::TopRight,
			(true, false) => Self::BottomLeft,
			(false, false) => Self::BottomRight,
		}
	}
}

/// Calculates bounding box dimensions with clamped ratios.
#[must_use]
pub fn split_dimensions(total: Pixels, ratio: f32, handle_size: Pixels) -> (Pixels, Pixels) {
	let clamped_ratio = ratio.clamp(0.05, 0.95);
	let available = (f32::from(total) - f32::from(handle_size)).max(0.0);
	let first = px(available * clamped_ratio);
	let second = px(available * (1.0 - clamped_ratio));
	(first, second)
}

/// Computes popover origin offset from anchor bounds.
#[must_use]
pub fn anchored_position(
	origin: Point<Pixels>,
	size: Size<Pixels>,
	anchor: AnchorCorner,
) -> Point<Pixels> {
	match anchor {
		AnchorCorner::TopLeft => origin,
		AnchorCorner::TopRight => {
			Point { x: px(f32::from(origin.x) - f32::from(size.width)), y: origin.y }
		},
		AnchorCorner::BottomLeft => {
			Point { x: origin.x, y: px(f32::from(origin.y) - f32::from(size.height)) }
		},
		AnchorCorner::BottomRight => Point {
			x: px(f32::from(origin.x) - f32::from(size.width)),
			y: px(f32::from(origin.y) - f32::from(size.height)),
		},
	}
}

/// The corner a box of `size` should be anchored at to stay inside
/// `viewport`, starting from the corner the caller asked for.
///
/// Each axis is decided on its own, and keeps the direction it was asked for
/// unless that direction overflows the margin and the opposite one does not. A
/// box too large for either direction keeps the corner it was given, which
/// leaves it to be slid in against the margin rather than flipped into an edge
/// it overflows just as far.
#[must_use]
pub fn flip_corner(
	requested: AnchorCorner,
	origin: Point<Pixels>,
	size: Size<Pixels>,
	viewport: Size<Pixels>,
	margin: Pixels,
) -> AnchorCorner {
	let margin = f32::from(margin);
	let room_right =
		f32::from(origin.x) + f32::from(size.width) <= f32::from(viewport.width) - margin;
	let room_left = f32::from(origin.x) - f32::from(size.width) >= margin;
	let room_below =
		f32::from(origin.y) + f32::from(size.height) <= f32::from(viewport.height) - margin;
	let room_above = f32::from(origin.y) - f32::from(size.height) >= margin;
	let extends_right = if requested.extends_right() {
		room_right || !room_left
	} else {
		!room_left && room_right
	};
	let extends_down = if requested.extends_down() {
		room_below || !room_above
	} else {
		!room_above && room_below
	};
	AnchorCorner::from_edges(extends_right, extends_down)
}
