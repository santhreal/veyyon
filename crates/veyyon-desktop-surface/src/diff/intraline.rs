//! Intraline word-level alignment for diff rows (§5.11).
//!
//! Pairs contiguous removed and added lines and computes word-level diff spans
//! using `veyyon_diff_kernel::align_words`.

use std::ops::Range;

use veyyon_diff_kernel::{DiffTag, align_words};

/// Computes word-level diff spans for a pair of removed and added lines.
///
/// Returns `(removed_spans, added_spans)` where each span is a byte range in
/// the corresponding line's text.
#[must_use]
pub fn pair_intraline(old: &str, new: &str) -> (Vec<Range<usize>>, Vec<Range<usize>>) {
	let ops = align_words(old, new);
	let mut old_spans = Vec::new();
	let mut new_spans = Vec::new();

	for (tag, old_range, new_range) in ops {
		match tag {
			DiffTag::Equal => {},
			DiffTag::Delete => {
				if !old_range.is_empty() {
					old_spans.push(old_range);
				}
			},
			DiffTag::Insert => {
				if !new_range.is_empty() {
					new_spans.push(new_range);
				}
			},
			DiffTag::Replace => {
				if !old_range.is_empty() {
					old_spans.push(old_range);
				}
				if !new_range.is_empty() {
					new_spans.push(new_range);
				}
			},
		}
	}

	(old_spans, new_spans)
}
