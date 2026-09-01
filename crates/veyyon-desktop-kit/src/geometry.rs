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
