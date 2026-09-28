//! The rows the diff list draws, in order: each file's header, then its
//! lines unified or paired side by side, with the review threads anchored
//! under the lines they belong to.
//!
//! The rows are rebuilt when the host's changes, the layout, a file's
//! collapse or a thread change, never per frame: a row is a few indices, so
//! ten thousand of them cost a small allocation.

use std::{
	collections::{HashMap, HashSet},
	hash::BuildHasher,
};

use veyyon_desktop_model::DiffMode;

use super::parse::{LineKind, ParsedDiff};

/// One row of the diff list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Row {
	/// A file's header: status, path, counts and controls.
	File(usize),
	/// One line of a file, unified.
	Line { file: usize, line: usize },
	/// Two lines side by side. A hunk header or a note names the same line on
	/// both sides and spans the row.
	Pair { file: usize, left: Option<usize>, right: Option<usize> },
	/// A review thread, under the line it is anchored to or, for one whose
	/// line is gone, at the end of its file.
	Thread { file: usize, thread: u64 },
	/// The comment being written, under the line it will anchor to.
	Draft { file: usize },
	/// A file the diff string holds no lines for.
	NoText(usize),
	/// The notice that the host held part of the diff back.
	Truncated,
}

/// Where each thread of the displayed diff sits.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Placements {
	/// Threads under a line, by `(file, line)` index.
	pub at:       HashMap<(usize, usize), Vec<u64>>,
	/// Threads whose line the diff no longer holds, by file index.
	pub outdated: HashMap<usize, Vec<u64>>,
}

/// The rows and where each file's header is among them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Layout {
	pub rows:        Vec<Row>,
	/// The index of each file's header row.
	pub file_starts: Vec<usize>,
}

impl Layout {
	/// The file the row at `ix` belongs to.
	pub const fn file_of(row: Row) -> Option<usize> {
		match row {
			Row::File(file) | Row::NoText(file) => Some(file),
			Row::Line { file, .. }
			| Row::Pair { file, .. }
			| Row::Thread { file, .. }
			| Row::Draft { file } => Some(file),
			Row::Truncated => None,
		}
	}

	/// Whether the row at `ix` starts a hunk.
	pub fn is_hunk(&self, diff: &ParsedDiff, ix: usize) -> bool {
		let line = match self.rows.get(ix) {
			Some(Row::Line { file, line } | Row::Pair { file, left: Some(line), .. }) => (file, line),
			_ => return false,
		};
		diff
			.files
			.get(*line.0)
			.and_then(|file| file.lines.get(*line.1))
			.is_some_and(|line| line.kind == LineKind::Hunk)
	}
}

/// Lays out `diff` in `mode`, with the files in `collapsed` drawn as their
/// header alone. `draft` names the `(file, line)` a comment is being written
/// under.
pub fn layout<S: BuildHasher>(
	diff: &ParsedDiff,
	mode: DiffMode,
	collapsed: &HashSet<String, S>,
	placements: &Placements,
	draft: Option<(usize, usize)>,
) -> Layout {
	let mut layout = Layout::default();
	for (ix, file) in diff.files.iter().enumerate() {
		layout.file_starts.push(layout.rows.len());
		layout.rows.push(Row::File(ix));
		if collapsed.contains(&file.path) {
			continue;
		}
		if file.lines.is_empty() {
			layout.rows.push(Row::NoText(ix));
		}
		let under = |rows: &mut Vec<Row>, line: usize| {
			if let Some(threads) = placements.at.get(&(ix, line)) {
				rows.extend(
					threads
						.iter()
						.map(|&thread| Row::Thread { file: ix, thread }),
				);
			}
			if draft == Some((ix, line)) {
				rows.push(Row::Draft { file: ix });
			}
		};
		match mode {
			DiffMode::Unified => {
				for line in 0..file.lines.len() {
					layout.rows.push(Row::Line { file: ix, line });
					under(&mut layout.rows, line);
				}
			},
			DiffMode::Split => {
				for (left, right) in pairs(file.lines.iter().map(|line| line.kind)) {
					layout.rows.push(Row::Pair { file: ix, left, right });
					// A header, a note or a context line names one line on
					// both sides, whose threads sit under the row once.
					let right = if left == right { None } else { right };
					for line in [left, right].into_iter().flatten() {
						under(&mut layout.rows, line);
					}
				}
			},
		}
		if let Some(threads) = placements.outdated.get(&ix) {
			layout.rows.extend(
				threads
					.iter()
					.map(|&thread| Row::Thread { file: ix, thread }),
			);
		}
	}
	if diff.truncated || diff.withheld > 0 {
		layout.rows.push(Row::Truncated);
	}
	layout
}

/// Pairs a file's lines for a split layout: context on both sides, each run
/// of removals beside the run of additions that follows it, and a header or
/// note across both.
pub fn pairs(kinds: impl Iterator<Item = LineKind>) -> Vec<(Option<usize>, Option<usize>)> {
	let mut rows = Vec::new();
	let mut removed: Vec<usize> = Vec::new();
	let mut added: Vec<usize> = Vec::new();
	let flush = |rows: &mut Vec<_>, removed: &mut Vec<usize>, added: &mut Vec<usize>| {
		let len = removed.len().max(added.len());
		rows.extend((0..len).map(|ix| (removed.get(ix).copied(), added.get(ix).copied())));
		removed.clear();
		added.clear();
	};
	for (ix, kind) in kinds.enumerate() {
		match kind {
			LineKind::Removed => {
				if !added.is_empty() {
					flush(&mut rows, &mut removed, &mut added);
				}
				removed.push(ix);
			},
			LineKind::Added => added.push(ix),
			LineKind::Context | LineKind::Hunk | LineKind::Note => {
				flush(&mut rows, &mut removed, &mut added);
				rows.push((Some(ix), Some(ix)));
			},
		}
	}
	flush(&mut rows, &mut removed, &mut added);
	rows
}
