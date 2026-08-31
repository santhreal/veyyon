//! Hit testing and range boundary math for text runs.

use std::ops::Range;

use gpui::{Bounds, Pixels, Point, point, px, size};
use unicode_segmentation::UnicodeSegmentation;

use crate::input::text;

/// Snap byte offset to the nearest grapheme cluster boundary so multi-byte
/// characters and grapheme clusters are never split.
pub fn snap_to_grapheme(text: &str, offset: usize) -> usize {
	let offset = offset.min(text.len());
	let mut prev = 0;
	for (idx, cluster) in text.grapheme_indices(true) {
		let next = idx + cluster.len();
		if offset <= idx {
			return if (offset - prev) < (idx - offset) {
				prev
			} else {
				idx
			};
		}
		if offset < next {
			return if (offset - idx) < (next - offset) {
				idx
			} else {
				next
			};
		}
		prev = next;
	}
	text.len()
}

/// Calculate word boundary around `offset`.
pub fn word_range(text: &str, offset: usize) -> Range<usize> {
	let (start, end) = text::word_at(text, offset);
	let start = snap_to_grapheme(text, start);
	let end = snap_to_grapheme(text, end).max(start);
	start..end
}

/// Calculate line boundary around `offset`.
pub fn line_range(text: &str, offset: usize) -> Range<usize> {
	let offset = text::clamp(text, offset);
	let start = text[..offset].rfind('\n').map_or(0, |i| i + 1);
	let end = text[offset..].find('\n').map_or(text.len(), |i| offset + i);
	start..end
}

/// Hit test an x position against cumulative glyph advances.
pub fn hit_test_advance(text: &str, advances: &[f32], local_x: f32) -> usize {
	if advances.is_empty() || local_x <= 0.0 {
		return 0;
	}
	let mut offset = text.len();
	for (idx, &advance) in advances.iter().enumerate() {
		if local_x < advance {
			let prev = if idx == 0 { 0.0 } else { advances[idx - 1] };
			let mid = prev + (advance - prev) * 0.5;
			let raw = if local_x < mid { idx } else { idx + 1 };
			offset = raw;
			break;
		}
	}
	snap_to_grapheme(text, offset)
}

/// Calculate selection wash bounding rectangles across wrapped rows.
pub fn range_rects_with_positions(
	bounds: Bounds<Pixels>,
	line_height: Pixels,
	range: &Range<usize>,
	position_for_index: impl Fn(usize) -> Option<Point<Pixels>>,
) -> Vec<Bounds<Pixels>> {
	let mut rects = Vec::new();
	let mut cur = range.start;
	let mut guard = 0;
	while cur < range.end && guard < 256 {
		guard += 1;
		let Some(mut p1) = position_for_index(cur) else {
			break;
		};
		if let Some(after) = position_for_index(cur.saturating_add(1))
			&& after.y > p1.y
		{
			p1 = point(bounds.left(), after.y);
		}
		let seg_end = match position_for_index(range.end) {
			Some(pe) if pe.y == p1.y => range.end,
			_ => {
				let (mut lo, mut hi) = (cur, range.end);
				while hi - lo > 1 {
					let mid = lo + (hi - lo) / 2;
					match position_for_index(mid) {
						Some(pm) if pm.y == p1.y => lo = mid,
						_ => hi = mid,
					}
				}
				lo
			},
		};
		if let Some(p2) = position_for_index(seg_end)
			&& p2.x > p1.x
		{
			rects.push(Bounds::new(point(p1.x, p1.y), size((p2.x - p1.x).max(px(2.0)), line_height)));
		}
		if seg_end <= cur {
			break;
		}
		cur = seg_end;
	}
	rects
}
