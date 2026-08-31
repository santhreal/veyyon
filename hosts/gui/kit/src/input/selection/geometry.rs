//! Hit testing and range boundary math for text runs.

use std::ops::Range;

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
