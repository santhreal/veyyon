//! The words a changed line changed: each run of removed lines is paired,
//! line for line, with the run of added lines that follows it, and the two
//! lines of a pair are aligned word by word. The words that differ are what
//! the diff marks inside the line's own tint.
//!
//! A pair that shares no word is a rewrite, not an edit: marking every word
//! of it would say no more than the line's tint already does, so it is left
//! unmarked.

use std::ops::Range;

use veyyon_diff_kernel::{DiffTag, align_words};

use super::parse::{DiffFile, LineKind};

/// The changed words of one file's paired lines: `(line, range)` with
/// `line` an index into the file's lines and `range` a byte range of that
/// line's text, sorted by line.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Emphasis(Vec<(usize, Range<usize>)>);

impl Emphasis {
	/// Aligns every pair of `file`, whose line texts are ranges of `source`.
	pub fn of(source: &str, file: &DiffFile) -> Self {
		let mut marked = Vec::new();
		let (mut removed, mut added) = (Vec::new(), Vec::new());
		for (ix, line) in file.lines.iter().enumerate() {
			match line.kind {
				// A missing final newline sits between the two runs it belongs to.
				LineKind::Note => {},
				LineKind::Removed if added.is_empty() => removed.push(ix),
				LineKind::Added if !removed.is_empty() => added.push(ix),
				kind => {
					pair(source, file, &removed, &added, &mut marked);
					removed.clear();
					added.clear();
					if kind == LineKind::Removed {
						removed.push(ix);
					}
				},
			}
		}
		pair(source, file, &removed, &added, &mut marked);
		// Stable, so each line keeps its ranges in the order they run.
		marked.sort_by_key(|(line, _)| *line);
		Self(marked)
	}

	/// The changed byte ranges of line `line`'s text, in order.
	pub fn of_line(&self, line: usize) -> impl Iterator<Item = Range<usize>> + '_ {
		let first = self.0.partition_point(|(at, _)| *at < line);
		self.0[first..]
			.iter()
			.take_while(move |(at, _)| *at == line)
			.map(|(_, range)| range.clone())
	}
}

/// Aligns `removed[i]` with `added[i]` for every `i` both runs hold, pushing
/// the ranges each line changed onto `marked`.
fn pair(
	source: &str,
	file: &DiffFile,
	removed: &[usize],
	added: &[usize],
	marked: &mut Vec<(usize, Range<usize>)>,
) {
	let text = |ix: usize| {
		file
			.lines
			.get(ix)
			.and_then(|line| source.get(line.text.clone()))
			.unwrap_or_default()
	};
	for (&old, &new) in removed.iter().zip(added) {
		let (old_text, new_text) = (text(old), text(new));
		let ops = align_words(old_text, new_text);
		let shares_a_word = ops.iter().any(|(tag, range, _)| {
			*tag == DiffTag::Equal
				&& old_text
					.get(range.clone())
					.is_some_and(|equal| !equal.trim().is_empty())
		});
		if !shares_a_word {
			continue;
		}
		for (tag, old_range, new_range) in ops {
			if tag == DiffTag::Equal {
				continue;
			}
			if !old_range.is_empty() {
				marked.push((old, old_range));
			}
			if !new_range.is_empty() {
				marked.push((new, new_range));
			}
		}
	}
}

#[cfg(test)]
#[path = "words_tests.rs"]
mod tests;
