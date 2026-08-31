//! Byte-accurate query highlighting for palette labels.
//!
//! Matching is case-insensitive without lowercasing the rendered label. Ranges
//! always land on UTF-8 boundaries in the original text, including when a
//! Unicode lowercase mapping expands to more than one character.

use std::ops::Range;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Highlight {
	pub range: Range<usize>,
}

#[derive(Debug)]
struct FoldedUnit {
	folded: Range<usize>,
	source: Range<usize>,
}

/// Find every non-overlapping occurrence of `query` in `text`.
///
/// An empty or whitespace-only query has no highlight. The caller owns ranking;
/// this function only maps the visible match back to the bytes that are drawn.
pub fn ranges(text: &str, query: &str) -> Vec<Highlight> {
	let query = query.trim();
	if query.is_empty() || text.is_empty() {
		return Vec::new();
	}

	let mut folded = String::with_capacity(text.len());
	let mut units = Vec::with_capacity(text.chars().count());
	for (source_start, character) in text.char_indices() {
		let folded_start = folded.len();
		folded.extend(character.to_lowercase());
		units.push(FoldedUnit {
			folded: folded_start..folded.len(),
			source: source_start..source_start + character.len_utf8(),
		});
	}

	let folded_query: String = query.chars().flat_map(char::to_lowercase).collect();
	if folded_query.is_empty() {
		return Vec::new();
	}

	folded
		.match_indices(&folded_query)
		.filter_map(|(start, _)| {
			let end = start + folded_query.len();
			let first = units.iter().find(|unit| unit.folded.end > start)?;
			let last = units.iter().rev().find(|unit| unit.folded.start < end)?;
			Some(Highlight { range: first.source.start..last.source.end })
		})
		.fold(Vec::new(), |mut highlights, next| {
			if highlights
				.last()
				.is_none_or(|previous: &Highlight| previous.range.end <= next.range.start)
			{
				highlights.push(next);
			}
			highlights
		})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn highlights_case_folded_occurrences_without_changing_drawn_bytes() {
		assert_eq!(ranges("Open Session, open file", "OPEN"), vec![
			Highlight { range: 0..4 },
			Highlight { range: 14..18 }
		]);
	}

	#[test]
	fn unicode_expansion_still_selects_whole_source_characters() {
		assert_eq!(ranges("İstanbul", "i"), vec![Highlight { range: 0..2 }]);
	}

	#[test]
	fn whitespace_only_queries_do_not_mark_every_label() {
		assert!(ranges("Settings", "  ").is_empty());
	}
}
