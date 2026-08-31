//! Fixed-row virtualization math.
//!
//! Large product collections keep their data outside kit. This module
//! calculates visible fixed-row ranges without constructing an intermediate
//! collection.

use std::ops::Range;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VirtualListMetrics {
	pub row_height:    f32,
	pub overscan_rows: usize,
}
impl VirtualListMetrics {
	pub fn visible(self, scroll_y: f32, viewport_height: f32, item_count: usize) -> Range<usize> {
		if item_count == 0 || self.row_height <= 0.0 {
			return 0..0;
		}
		let first = (scroll_y.max(0.0) / self.row_height).floor() as usize;
		let visible = (viewport_height.max(0.0) / self.row_height).ceil() as usize;
		let start = first.saturating_sub(self.overscan_rows).min(item_count);
		let end = first
			.saturating_add(visible)
			.saturating_add(self.overscan_rows)
			.min(item_count);
		start..end.max(start)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn calculates_visible_range() {
		let metrics = VirtualListMetrics { row_height: 20.0, overscan_rows: 2 };
		assert_eq!(metrics.visible(0.0, 100.0, 50), 0..7);
		assert_eq!(metrics.visible(40.0, 100.0, 50), 0..9);
		assert_eq!(metrics.visible(100.0, 100.0, 50), 3..12);
	}

	#[test]
	fn empty_or_zero_height() {
		let metrics = VirtualListMetrics { row_height: 0.0, overscan_rows: 2 };
		assert_eq!(metrics.visible(0.0, 100.0, 50), 0..0);
		let metrics = VirtualListMetrics { row_height: 20.0, overscan_rows: 2 };
		assert_eq!(metrics.visible(0.0, 100.0, 0), 0..0);
	}
}
