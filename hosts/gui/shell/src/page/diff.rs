//! A change as a page: the diff review screen.
//!
//! The files are drawn by `veyyon_gui_views::diff`, which is the same renderer
//! a diff inside the transcript goes through. This module adds what a page has
//! and a transcript card does not: the totals across every file, above the
//! body, so the size of the change is readable before scrolling it.

use gpui::{App, Div, ParentElement, Styled};
use veyyon_gui_contract::view::Diff;
use veyyon_gui_kit::{
	chrome::{chip, column, row},
	text::caption,
	tokens::space,
};
use veyyon_gui_theme::Role;

pub fn diff(value: &Diff, cx: &App) -> Div {
	column(space::SNUG)
		.child(totals_row(value, cx))
		.child(veyyon_gui_views::diff::body(value, cx))
}

/// The line the totals are read from.
fn totals_row(value: &Diff, cx: &App) -> Div {
	let (added, removed) = value.totals();
	row(space::SNUG)
		.items_baseline()
		.child(caption(file_line(value.files.len()), cx))
		.child(chip(format!("+{added}"), Role::DiffAdded, cx))
		.child(chip(format!("−{removed}"), Role::DiffRemoved, cx))
}

/// How many files the change touches.
pub fn file_line(files: usize) -> String {
	match files {
		1 => "1 file".to_owned(),
		files => format!("{files} files"),
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! The totals row above the body and the counts beside each file heading are
	//! two numbers a reader compares by eye, and they come from two calls. The
	//! test derives the totals from the line kinds in the hunks — the only place
	//! the information exists — and asserts the reported pair equals it, so a
	//! producer that set `added`/`removed` by hand cannot put a row on screen
	//! that contradicts the lines under it.
	//!
	//! WHAT IT DOES NOT CATCH. A collapsed file's lines, which nothing on this
	//! side of the wire knows: its body was not fetched, so it contributes zero
	//! and the totals are of what is shown. The body, which
	//! `veyyon_gui_views::diff` owns and tests.

	use veyyon_gui_contract::fixtures;

	use super::*;

	#[test]
	fn the_totals_row_equals_the_line_kinds_in_the_hunks() {
		use veyyon_gui_contract::view::DiffLineKind;

		let change = fixtures::routes::change();
		let counted = change.files.iter().flat_map(|file| file.hunks.iter()).fold(
			(0_usize, 0_usize),
			|(added, removed), hunk| {
				(
					added
						+ hunk
							.lines
							.iter()
							.filter(|l| l.kind == DiffLineKind::Added)
							.count(),
					removed
						+ hunk
							.lines
							.iter()
							.filter(|l| l.kind == DiffLineKind::Removed)
							.count(),
				)
			},
		);
		assert_eq!(change.totals(), counted, "the totals row contradicts the lines under it");
		assert_eq!(counted, (3, 2));
	}

	#[test]
	fn a_collapsed_file_is_counted_as_nothing_and_says_why() {
		let change = fixtures::routes::change();
		let collapsed = change
			.files
			.iter()
			.find(|file| file.collapsed.is_some())
			.expect("the fixture carries a collapsed file");
		assert_eq!((collapsed.added, collapsed.removed), (0, 0));
		assert!(collapsed.hunks.is_empty(), "a collapsed file drew a body");
		assert!(
			collapsed
				.collapsed
				.as_deref()
				.is_some_and(|reason| !reason.is_empty()),
			"a file with no body and no reason reads as an empty change"
		);
	}

	#[test]
	fn one_file_is_singular() {
		assert_eq!(file_line(1), "1 file");
		assert_eq!(file_line(0), "0 files");
		assert_eq!(file_line(3), "3 files");
	}
}
