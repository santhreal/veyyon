//! Which edges of a scroll region have content past them.
//!
//! Pure: the whole decision of what to draw, with no gpui element in it, so the
//! suites state offsets and read back edges. Split from the element in
//! `edge_fade.rs` so neither file passes the four-hundred-line ceiling.

use gpui::{Pixels, Point, px};

/// Which edges of a scroll region have content past them.
///
/// Pure: the whole decision of what to draw, with no gpui element in it, so the
/// suite states offsets and reads back edges.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FadedEdges {
	pub top:    bool,
	pub bottom: bool,
	pub left:   bool,
	pub right:  bool,
}

impl FadedEdges {
	/// The edges a scroll offset has content past.
	///
	/// gpui counts a scroll offset down and right from zero as negative, and
	/// `max` is the positive distance the content exceeds the viewport by. An
	/// offset of zero on an axis is therefore the start of the content, and
	/// `-max` is its end. A `max` of zero means the content fits, so neither
	/// edge of that axis fades however the offset reads.
	pub fn of(offset: Point<Pixels>, max: Point<Pixels>) -> Self {
		Self {
			top:    max.y > px(0.0) && offset.y < px(0.0),
			bottom: max.y > px(0.0) && offset.y > -max.y,
			left:   max.x > px(0.0) && offset.x < px(0.0),
			right:  max.x > px(0.0) && offset.x > -max.x,
		}
	}

	/// The edges of one axis, for a region that scrolls vertically only.
	pub fn vertical(self) -> Self {
		Self { left: false, right: false, ..self }
	}

	/// The edges of a [`ListState`] region, which counts its offset in rows
	/// rather than in pixels.
	///
	/// `scrolled_to_end` is `None` until the list has been laid out once, and a
	/// region nobody has measured is not scrolled: an unmeasured list fading
	/// its bottom edge would put a band over the first frame of every
	/// conversation.
	pub fn of_list(
		top_item: usize,
		offset_in_item: Pixels,
		scrolled_to_end: Option<bool>,
		items: usize,
	) -> Self {
		Self {
			top:    items > 0 && (top_item > 0 || offset_in_item > px(0.0)),
			bottom: items > 0 && scrolled_to_end == Some(false),
			left:   false,
			right:  false,
		}
	}

	pub fn any(self) -> bool {
		self.top || self.bottom || self.left || self.right
	}
}

#[cfg(test)]
mod tests {
	use gpui::{Point, px};

	use super::FadedEdges;

	fn at(x: f32, y: f32) -> Point<gpui::Pixels> {
		Point { x: px(x), y: px(y) }
	}

	#[test]
	fn content_that_fits_fades_at_neither_edge() {
		let edges = FadedEdges::of(at(0.0, 0.0), at(0.0, 0.0));
		assert_eq!(edges, FadedEdges::default());
		assert!(!edges.any());
	}

	#[test]
	fn the_top_of_the_content_fades_below_only() {
		let edges = FadedEdges::of(at(0.0, 0.0), at(0.0, 400.0));
		assert!(!edges.top, "nothing is above the first row");
		assert!(edges.bottom);
	}

	#[test]
	fn the_end_of_the_content_fades_above_only() {
		let edges = FadedEdges::of(at(0.0, -400.0), at(0.0, 400.0));
		assert!(edges.top);
		assert!(!edges.bottom, "nothing is below the last row");
	}

	#[test]
	fn the_middle_of_the_content_fades_at_both_edges() {
		let edges = FadedEdges::of(at(0.0, -120.0), at(0.0, 400.0));
		assert!(edges.top && edges.bottom);
	}

	#[test]
	fn an_offset_past_the_end_still_reads_as_the_end() {
		// A momentum overscroll can hand back an offset beyond the clamp for
		// one frame. Past the end is the end, not both edges at once.
		let edges = FadedEdges::of(at(0.0, -420.0), at(0.0, 400.0));
		assert!(edges.top);
		assert!(!edges.bottom);
	}

	#[test]
	fn a_horizontal_overflow_fades_only_the_axis_that_has_it() {
		let edges = FadedEdges::of(at(-40.0, 0.0), at(200.0, 0.0));
		assert!(edges.left && edges.right);
		assert!(!edges.top && !edges.bottom);
	}

	#[test]
	fn a_vertical_region_ignores_a_horizontal_offset() {
		let edges = FadedEdges::of(at(-40.0, -40.0), at(200.0, 400.0)).vertical();
		assert!(edges.top && edges.bottom);
		assert!(!edges.left && !edges.right);
	}
}

#[cfg(test)]
mod list_tests {
	use gpui::px;

	use super::FadedEdges;

	#[test]
	fn a_list_nobody_has_laid_out_fades_at_neither_edge() {
		// `is_scrolled_to_end` is `None` before the first layout, and the
		// first frame of a conversation must not open under a band.
		let edges = FadedEdges::of_list(0, px(0.0), None, 40);
		assert_eq!(edges, FadedEdges::default());
	}

	#[test]
	fn an_empty_list_fades_at_neither_edge() {
		assert_eq!(FadedEdges::of_list(0, px(0.0), Some(false), 0), FadedEdges::default());
	}

	#[test]
	fn a_list_emptied_while_scrolled_fades_at_neither_edge() {
		// A splice to zero rows leaves the state reporting the row that was at
		// the top for one more frame, and a band over an empty transcript is a
		// smudge on nothing.
		assert_eq!(FadedEdges::of_list(12, px(6.0), Some(false), 0), FadedEdges::default());
	}

	#[test]
	fn the_first_row_of_a_longer_list_fades_below_only() {
		let edges = FadedEdges::of_list(0, px(0.0), Some(false), 40);
		assert!(!edges.top, "nothing is above the first row");
		assert!(edges.bottom);
	}

	#[test]
	fn a_view_part_way_into_the_first_row_fades_above_it() {
		// The row index is still zero while the view has moved into that row,
		// so the index alone would call this the top of the content.
		let edges = FadedEdges::of_list(0, px(12.0), Some(false), 40);
		assert!(edges.top && edges.bottom);
	}

	#[test]
	fn the_end_of_the_list_fades_above_only() {
		let edges = FadedEdges::of_list(37, px(4.0), Some(true), 40);
		assert!(edges.top);
		assert!(!edges.bottom, "nothing is below the last row");
	}

	#[test]
	fn a_list_that_fits_fades_at_neither_edge() {
		// One row at the top and already at the end: the content fits.
		assert_eq!(FadedEdges::of_list(0, px(0.0), Some(true), 3), FadedEdges::default());
	}
}
