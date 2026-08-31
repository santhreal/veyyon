//! Geometry, flip, and alignment placement for anchored popovers.
//!
//! Measures content against available window space, flipping to the opposite
//! side when the preferred placement would overflow the window margins.

use gpui::{Bounds, Pixels, Point, Size, px};

use crate::theme::{layout, space};

/// The preferred edge of an anchor where the popover should appear.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Side {
	Top,
	Bottom,
	Left,
	Right,
}

impl Side {
	/// Every side variant, swept by tests at run time.
	pub const ALL: [Side; 4] = [Side::Top, Side::Bottom, Side::Left, Side::Right];

	/// The opposite edge of the anchor.
	pub const fn opposite(self) -> Self {
		match self {
			Self::Top => Self::Bottom,
			Self::Bottom => Self::Top,
			Self::Left => Self::Right,
			Self::Right => Self::Left,
		}
	}

	/// Whether this side positions along the vertical axis.
	pub const fn is_vertical(self) -> bool {
		matches!(self, Self::Top | Self::Bottom)
	}

	/// Whether this side positions along the horizontal axis.
	pub const fn is_horizontal(self) -> bool {
		matches!(self, Self::Left | Self::Right)
	}
}

/// Alignment along the anchor's transverse axis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Alignment {
	Start,
	Center,
	End,
}

impl Alignment {
	/// Every alignment variant, swept by tests at run time.
	pub const ALL: [Alignment; 3] = [Alignment::Start, Alignment::Center, Alignment::End];
}

/// Computed layout and positioning metadata for an anchored popover.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PopoverBounds {
	pub bounds:          Bounds<Pixels>,
	pub side:            Side,
	pub flipped:         bool,
	pub clamped:         bool,
	pub scroll_required: bool,
}

impl PopoverBounds {
	/// Whether the resulting bounds remain adjacent to the anchor along the
	/// chosen side.
	pub fn is_adjacent_to_anchor(&self, anchor: Bounds<Pixels>, offset: Pixels) -> bool {
		let eps = px(0.5);
		match self.side {
			Side::Bottom => {
				(self.bounds.origin.y - (anchor.bottom() + offset)).abs() <= eps
					|| (self.bounds.origin.y >= anchor.bottom() - eps)
			},
			Side::Top => {
				(self.bounds.bottom() - (anchor.top() - offset)).abs() <= eps
					|| (self.bounds.bottom() <= anchor.top() + eps)
			},
			Side::Right => {
				(self.bounds.origin.x - (anchor.right() + offset)).abs() <= eps
					|| (self.bounds.origin.x >= anchor.right() - eps)
			},
			Side::Left => {
				(self.bounds.right() - (anchor.left() - offset)).abs() <= eps
					|| (self.bounds.right() <= anchor.left() + eps)
			},
		}
	}
}

/// Computes the popover bounds given anchor, content, and window dimensions.
pub fn compute_bounds(
	anchor: Bounds<Pixels>,
	content_size: Size<Pixels>,
	window_size: Size<Pixels>,
	preferred_side: Side,
	preferred_alignment: Alignment,
	offset: Pixels,
	margin: Pixels,
) -> PopoverBounds {
	let max_w = (window_size.width - margin * 2.0).max(px(0.0));
	let max_h = (window_size.height - margin * 2.0).max(px(0.0));
	let clamped_w = content_size.width.min(max_w);
	let clamped_h = content_size.height.min(max_h);
	let scroll_required = content_size.height > max_h || content_size.width > max_w;

	let (chosen_side, origin_primary, flipped) = match preferred_side {
		Side::Bottom => {
			let y_pref = anchor.bottom() + offset;
			if y_pref + clamped_h <= window_size.height - margin {
				(Side::Bottom, y_pref, false)
			} else {
				let y_opp = anchor.top() - offset - clamped_h;
				if y_opp >= margin {
					(Side::Top, y_opp, true)
				} else {
					let space_below = window_size.height - margin - (anchor.bottom() + offset);
					let space_above = anchor.top() - offset - margin;
					if space_above > space_below {
						(Side::Top, y_opp, true)
					} else {
						(Side::Bottom, y_pref, false)
					}
				}
			}
		},
		Side::Top => {
			let y_pref = anchor.top() - offset - clamped_h;
			if y_pref >= margin {
				(Side::Top, y_pref, false)
			} else {
				let y_opp = anchor.bottom() + offset;
				if y_opp + clamped_h <= window_size.height - margin {
					(Side::Bottom, y_opp, true)
				} else {
					let space_above = anchor.top() - offset - margin;
					let space_below = window_size.height - margin - (anchor.bottom() + offset);
					if space_below > space_above {
						(Side::Bottom, y_opp, true)
					} else {
						(Side::Top, y_pref, false)
					}
				}
			}
		},
		Side::Right => {
			let x_pref = anchor.right() + offset;
			if x_pref + clamped_w <= window_size.width - margin {
				(Side::Right, x_pref, false)
			} else {
				let x_opp = anchor.left() - offset - clamped_w;
				if x_opp >= margin {
					(Side::Left, x_opp, true)
				} else {
					let space_right = window_size.width - margin - (anchor.right() + offset);
					let space_left = anchor.left() - offset - margin;
					if space_left > space_right {
						(Side::Left, x_opp, true)
					} else {
						(Side::Right, x_pref, false)
					}
				}
			}
		},
		Side::Left => {
			let x_pref = anchor.left() - offset - clamped_w;
			if x_pref >= margin {
				(Side::Left, x_pref, false)
			} else {
				let x_opp = anchor.right() + offset;
				if x_opp + clamped_w <= window_size.width - margin {
					(Side::Right, x_opp, true)
				} else {
					let space_left = anchor.left() - offset - margin;
					let space_right = window_size.width - margin - (anchor.right() + offset);
					if space_right > space_left {
						(Side::Right, x_opp, true)
					} else {
						(Side::Left, x_pref, false)
					}
				}
			}
		},
	};

	let (mut x, mut y) = if chosen_side.is_vertical() {
		let align_x = match preferred_alignment {
			Alignment::Start => anchor.left(),
			Alignment::Center => anchor.left() + (anchor.size.width - clamped_w) / 2.0,
			Alignment::End => anchor.right() - clamped_w,
		};
		(align_x, origin_primary)
	} else {
		let align_y = match preferred_alignment {
			Alignment::Start => anchor.top(),
			Alignment::Center => anchor.top() + (anchor.size.height - clamped_h) / 2.0,
			Alignment::End => anchor.bottom() - clamped_h,
		};
		(origin_primary, align_y)
	};

	let mut clamped = false;
	let min_x = margin;
	let max_x = (window_size.width - margin - clamped_w).max(min_x);
	if x < min_x {
		x = min_x;
		clamped = true;
	} else if x > max_x {
		x = max_x;
		clamped = true;
	}

	let min_y = margin;
	let max_y = (window_size.height - margin - clamped_h).max(min_y);
	if y < min_y {
		y = min_y;
		clamped = true;
	} else if y > max_y {
		y = max_y;
		clamped = true;
	}

	if content_size.width > max_w || content_size.height > max_h {
		clamped = true;
	}

	PopoverBounds {
		bounds: Bounds {
			origin: Point { x, y },
			size:   Size { width: clamped_w, height: clamped_h },
		},
		side: chosen_side,
		flipped,
		clamped,
		scroll_required,
	}
}

/// Default margin from window edges, taken from layout tokens.
pub fn default_margin() -> Pixels {
	px(layout::OVERLAY_MARGIN)
}

/// Default offset between popover and anchor, taken from space tokens.
pub fn default_offset() -> Pixels {
	px(space::SNUG)
}
