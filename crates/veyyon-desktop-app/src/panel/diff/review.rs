//! The window-local review threads, anchored to the lines of the diff the
//! panel shows.
//!
//! A thread belongs to one repository, file and change scope. It sits under
//! the line its recorded text and neighbours match exactly once; a thread
//! whose line the diff no longer holds sits at the end of its file, and once
//! a complete diff has lost it the thread is orphaned for good.

use std::collections::HashMap;

use veyyon_desktop_model::{
	ChangeScope,
	review::{ReviewAnchor, ReviewLine, ReviewPlacement, ReviewSide, ReviewThread, ReviewsStore},
};

use super::{
	parse::{DiffFile, DiffLine, LineKind, ParsedDiff},
	rows::Placements,
};

/// The repository and scope the displayed diff was read from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReviewScope {
	pub repository: String,
	pub scope:      ChangeScope,
}

impl ReviewScope {
	/// Whether `thread` was left on this repository and scope.
	pub fn holds(&self, thread: &ReviewThread) -> bool {
		thread.anchor.repository == self.repository && thread.anchor.scope == self.scope
	}
}

/// The side and number a comment on `line` anchors to: a removed line's old
/// number, an added or context line's new one.
pub fn line_anchor(line: &DiffLine) -> Option<(ReviewSide, usize)> {
	match line.kind {
		LineKind::Removed => line.old.map(|number| (ReviewSide::Old, number as usize)),
		LineKind::Added | LineKind::Context => {
			line.new.map(|number| (ReviewSide::New, number as usize))
		},
		LineKind::Hunk | LineKind::Note => None,
	}
}

/// The lines of one side of `file`, numbered as that side numbers them.
pub fn source_lines<'a>(file: &DiffFile, source: &'a str, side: ReviewSide) -> Vec<ReviewLine<'a>> {
	file
		.lines
		.iter()
		.filter_map(|line| {
			let number = match (side, line.kind) {
				(ReviewSide::Old, LineKind::Removed | LineKind::Context) => line.old,
				(ReviewSide::New, LineKind::Added | LineKind::Context) => line.new,
				_ => None,
			}?;
			Some(ReviewLine { number: number as usize, text: source.get(line.text.clone())? })
		})
		.collect()
}

/// A new thread's anchor on line `line` of file `file`.
pub fn anchor(
	diff: &ParsedDiff,
	scope: &ReviewScope,
	file: usize,
	line: usize,
) -> Option<ReviewAnchor> {
	let diff_file = diff.files.get(file)?;
	let (side, number) = line_anchor(diff_file.lines.get(line)?)?;
	ReviewAnchor::capture(
		&scope.repository,
		&diff_file.path,
		scope.scope,
		side,
		number,
		&source_lines(diff_file, &diff.source, side),
	)
}

/// Where `thread` sits in `diff`: its file index and, when attached, the
/// index of its line in that file.
fn locate(diff: &ParsedDiff, thread: &ReviewThread) -> Option<(usize, Option<usize>)> {
	let file = diff
		.files
		.iter()
		.position(|file| file.path == thread.anchor.file)?;
	if thread.orphaned {
		return Some((file, None));
	}
	let diff_file = diff.files.get(file)?;
	let side = thread.anchor.side;
	let line = match thread
		.anchor
		.locate(&source_lines(diff_file, &diff.source, side))
	{
		ReviewPlacement::Attached(number) => diff_file
			.lines
			.iter()
			.position(|line| line_anchor(line) == Some((side, number))),
		ReviewPlacement::Missing | ReviewPlacement::Ambiguous => None,
	};
	Some((file, line))
}

/// Where each thread of `scope` sits in `diff`.
pub fn place(diff: &ParsedDiff, reviews: &ReviewsStore, scope: &ReviewScope) -> Placements {
	let mut at: HashMap<(usize, usize), Vec<u64>> = HashMap::new();
	let mut outdated: HashMap<usize, Vec<u64>> = HashMap::new();
	for thread in reviews.threads.iter().filter(|thread| scope.holds(thread)) {
		match locate(diff, thread) {
			Some((file, Some(line))) => at.entry((file, line)).or_default().push(thread.id),
			Some((file, None)) => outdated.entry(file).or_default().push(thread.id),
			None => {},
		}
	}
	Placements { at, outdated }
}

/// Orphans every thread of `scope` a complete diff no longer attaches.
/// A diff the host cut short proves nothing about a missing line. Returns
/// whether a thread changed.
pub fn reconcile(diff: &ParsedDiff, reviews: &mut ReviewsStore, scope: &ReviewScope) -> bool {
	if diff.truncated || diff.withheld > 0 {
		return false;
	}
	let mut changed = false;
	let lost: Vec<u64> = reviews
		.threads
		.iter()
		.filter(|thread| scope.holds(thread) && !thread.orphaned)
		.filter(|thread| !matches!(locate(diff, thread), Some((_, Some(_)))))
		.map(|thread| thread.id)
		.collect();
	for thread in &mut reviews.threads {
		if lost.contains(&thread.id) {
			thread.orphaned = true;
			changed = true;
		}
	}
	changed
}

/// Whether `thread` still wants attention: open, or lost from the diff.
pub const fn needs_attention(thread: &ReviewThread) -> bool {
	!thread.resolved || thread.orphaned || thread.anchor.ambiguous
}

/// The open and resolved threads of `scope`.
pub fn counts(reviews: &ReviewsStore, scope: &ReviewScope) -> (usize, usize) {
	reviews
		.threads
		.iter()
		.filter(|thread| scope.holds(thread))
		.fold((0, 0), |(open, resolved), thread| {
			if needs_attention(thread) {
				(open + 1, resolved)
			} else {
				(open, resolved + 1)
			}
		})
}
