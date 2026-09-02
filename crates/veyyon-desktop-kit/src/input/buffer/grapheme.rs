//! Unicode grapheme cluster segmentation and navigation helpers (§8.25).

use std::ops::Range;

use unicode_segmentation::UnicodeSegmentation;

/// Snaps an arbitrary byte offset to the nearest grapheme cluster boundary.
#[must_use]
pub fn snap_to_grapheme(text: &str, offset: usize) -> usize {
	if text.is_empty() || offset == 0 {
		return 0;
	}
	if offset >= text.len() {
		return text.len();
	}

	let mut prev_bound = 0;
	for (idx, cluster) in text.grapheme_indices(true) {
		if idx == offset {
			return idx;
		}
		if idx > offset {
			let dist_prev = offset.saturating_sub(prev_bound);
			let dist_next = idx.saturating_sub(offset);
			return if dist_prev <= dist_next {
				prev_bound
			} else {
				idx
			};
		}
		prev_bound = idx + cluster.len();
	}

	let dist_prev = offset.saturating_sub(prev_bound);
	let dist_next = text.len().saturating_sub(offset);
	if dist_prev <= dist_next {
		prev_bound
	} else {
		text.len()
	}
}

/// Returns the preceding grapheme cluster byte offset before `offset`.
#[must_use]
pub fn prev_grapheme_offset(text: &str, offset: usize) -> usize {
	let snapped = snap_to_grapheme(text, offset);
	if snapped == 0 || text.is_empty() {
		return 0;
	}

	text
		.grapheme_indices(true)
		.rev()
		.find_map(|(idx, _)| (idx < snapped).then_some(idx))
		.unwrap_or(0)
}

/// Returns the succeeding grapheme cluster byte offset after `offset`.
#[must_use]
pub fn next_grapheme_offset(text: &str, offset: usize) -> usize {
	let snapped = snap_to_grapheme(text, offset);
	if snapped >= text.len() || text.is_empty() {
		return text.len();
	}

	for (idx, cluster) in text.grapheme_indices(true) {
		if idx > snapped {
			return idx;
		}
		if idx == snapped {
			return idx + cluster.len();
		}
	}
	text.len()
}

/// Helper to check if a grapheme cluster consists entirely of whitespace.
fn is_whitespace_cluster(cluster: &str) -> bool {
	cluster.chars().all(char::is_whitespace)
}

/// Helper to check if a grapheme cluster consists of word/alphanumeric
/// characters.
fn is_word_cluster(cluster: &str) -> bool {
	cluster.chars().any(char::is_alphanumeric)
}

/// Returns the byte offset of the word boundary preceding `offset`.
#[must_use]
pub fn prev_word_offset(text: &str, offset: usize) -> usize {
	let mut current = snap_to_grapheme(text, offset);
	if current == 0 || text.is_empty() {
		return 0;
	}

	let clusters: Vec<(usize, &str)> = text.grapheme_indices(true).collect();
	let mut idx = clusters
		.iter()
		.position(|(byte_idx, _)| *byte_idx >= current)
		.unwrap_or(clusters.len());

	// Skip trailing whitespace backwards
	while idx > 0 && is_whitespace_cluster(clusters[idx - 1].1) {
		idx -= 1;
		current = clusters[idx].0;
	}

	if idx == 0 {
		return 0;
	}

	let is_word = is_word_cluster(clusters[idx - 1].1);
	while idx > 0 {
		let prev = &clusters[idx - 1];
		if is_whitespace_cluster(prev.1) || is_word_cluster(prev.1) != is_word {
			break;
		}
		idx -= 1;
		current = prev.0;
	}

	current
}

/// Returns the byte offset of the word boundary succeeding `offset`.
#[must_use]
pub fn next_word_offset(text: &str, offset: usize) -> usize {
	let mut current = snap_to_grapheme(text, offset);
	if current >= text.len() || text.is_empty() {
		return text.len();
	}

	let clusters: Vec<(usize, &str)> = text.grapheme_indices(true).collect();
	let mut idx = clusters
		.iter()
		.position(|(byte_idx, _)| *byte_idx >= current)
		.unwrap_or(clusters.len());

	if idx >= clusters.len() {
		return text.len();
	}

	let is_word = is_word_cluster(clusters[idx].1);
	let is_ws = is_whitespace_cluster(clusters[idx].1);

	// Skip current cluster category
	while idx < clusters.len() {
		let curr = &clusters[idx];
		if is_ws {
			if !is_whitespace_cluster(curr.1) {
				break;
			}
		} else if is_whitespace_cluster(curr.1) || is_word_cluster(curr.1) != is_word {
			break;
		}
		current = curr.0 + curr.1.len();
		idx += 1;
	}

	// Skip following whitespace
	while idx < clusters.len() && is_whitespace_cluster(clusters[idx].1) {
		let curr = &clusters[idx];
		current = curr.0 + curr.1.len();
		idx += 1;
	}

	current
}

/// Returns the byte offset range of the word at or surrounding `offset`.
#[must_use]
pub fn word_range_at(text: &str, offset: usize) -> Range<usize> {
	let snapped = snap_to_grapheme(text, offset);
	if text.is_empty() {
		return 0..0;
	}

	for (start, word) in text.split_word_bound_indices() {
		let end = start + word.len();
		if snapped >= start && snapped <= end {
			return start..end;
		}
	}
	0..text.len()
}

/// Returns the byte offset of the start of the line containing `offset`.
#[must_use]
pub fn line_start_offset(text: &str, offset: usize) -> usize {
	let snapped = snap_to_grapheme(text, offset);
	if snapped == 0 || text.is_empty() {
		return 0;
	}

	text[..snapped]
		.rfind('\n')
		.map_or(0, |newline_idx| newline_idx + 1)
}

/// Returns the byte offset of the end of the line containing `offset`.
#[must_use]
pub fn line_end_offset(text: &str, offset: usize) -> usize {
	let snapped = snap_to_grapheme(text, offset);
	if snapped >= text.len() || text.is_empty() {
		return text.len();
	}

	text[snapped..]
		.find('\n')
		.map_or(text.len(), |newline_idx| snapped + newline_idx)
}

/// Returns (0-indexed line, 0-indexed column byte offset) for byte offset.
#[must_use]
pub fn line_col_for_offset(text: &str, offset: usize) -> (usize, usize) {
	let snapped = snap_to_grapheme(text, offset);
	let mut line = 0;
	let mut line_start = 0;

	for (idx, ch) in text.char_indices() {
		if idx >= snapped {
			break;
		}
		if ch == '\n' {
			line += 1;
			line_start = idx + 1;
		}
	}

	(line, snapped.saturating_sub(line_start))
}

/// Returns the byte offset for (0-indexed line, 0-indexed column byte offset).
#[must_use]
pub fn offset_for_line_col(text: &str, line: usize, col: usize) -> usize {
	let mut current_line = 0;
	let mut line_start = 0;

	for (idx, ch) in text.char_indices() {
		if current_line == line {
			let line_end = text[line_start..]
				.find('\n')
				.map_or(text.len(), |n| line_start + n);
			let target = (line_start + col).min(line_end);
			return snap_to_grapheme(text, target);
		}
		if ch == '\n' {
			current_line += 1;
			line_start = idx + 1;
		}
	}

	if current_line == line {
		let line_end = text.len();
		let target = (line_start + col).min(line_end);
		return snap_to_grapheme(text, target);
	}

	text.len()
}
