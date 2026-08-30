//! Changed lines, per file and per hunk.

use gpui::{App, Div, ParentElement, Styled};
use veyyon_gui_contract::view::{Diff, DiffFile, DiffHunk, DiffLine, DiffLineKind};
use veyyon_gui_kit::{
	Level,
	chrome::{column, row, wash},
	surface,
	text::{caption, mono, text_in},
	theme::ActiveTheme,
	tokens::{radius, space, text},
};
use veyyon_gui_theme::Role;

use crate::{fields::home, path};

/// How many path segments a file heading keeps.
const PATH_BUDGET: usize = 6;

/// The width the two line-number columns reserve, in characters.
///
/// Sized once for the whole diff rather than per hunk, so the text column does
/// not step left and right as the hunks change how many digits they need.
const GUTTER_DIGITS: usize = 4;

pub fn diff(value: &Diff, cx: &App) -> Div {
	let (added, removed) = value.totals();
	column(space::SNUG)
		.child(
			row(space::SNUG)
				.items_baseline()
				.child(text_in(value.title.clone(), Role::TextPrimary, text::BODY, cx))
				.child(caption(counts(added, removed), cx)),
		)
		.child(body(value, cx))
}

/// The files, without the title.
///
/// A page whose sheet already carries the diff's title draws this instead, so
/// there is one file renderer and not two: a second one drifts on the gutter
/// width, which is the part a reader notices last.
pub fn body(value: &Diff, cx: &App) -> Div {
	let stack = column(space::SNUG).children(value.files.iter().map(|file| self::file(file, cx)));
	match &value.footer {
		None => stack,
		Some(footer) => stack.child(caption(footer.clone(), cx)),
	}
}

/// One file: its heading, then its hunks or the reason its body is not shown.
fn file(value: &DiffFile, cx: &App) -> Div {
	let stack = column(space::TIGHT).child(
		row(space::SNUG)
			.items_baseline()
			.child(mono(heading(value, home(), PATH_BUDGET), Role::TextPrimary, cx))
			.child(caption(counts(value.added, value.removed), cx)),
	);
	match &value.collapsed {
		Some(reason) => stack.child(caption(reason.clone(), cx)),
		None => stack.children(value.hunks.iter().map(|hunk| self::hunk(hunk, cx))),
	}
}

/// A file's heading: the path, or both paths when it moved.
///
/// A rename with no line changes has nothing else to show, so a heading that
/// dropped the old path would draw it as an untouched file.
pub fn heading(value: &DiffFile, home: Option<&str>, budget: usize) -> String {
	let new = path::shorten(&value.path, home, budget);
	match &value.old_path {
		None => new,
		Some(old) => format!("{} → {new}", path::shorten(old, home, budget)),
	}
}

/// The `+N −M` a heading reports. An unchanged file reports neither rather than
/// two zeroes.
pub fn counts(added: usize, removed: usize) -> String {
	match (added, removed) {
		(0, 0) => String::new(),
		(added, 0) => format!("+{added}"),
		(0, removed) => format!("−{removed}"),
		(added, removed) => format!("+{added} −{removed}"),
	}
}

fn hunk(value: &DiffHunk, cx: &App) -> Div {
	surface(Level::Sunken, cx)
		.w_full()
		.rounded(radius::SMALL)
		.p(space::TIGHT)
		.flex()
		.flex_col()
		.child(mono(value.header.clone(), Role::DiffContext, cx))
		.children(value.lines.iter().map(|line| self::line(line, cx)))
}

fn line(value: &DiffLine, cx: &App) -> Div {
	let role = line_role(value.kind);
	let line_row = row(space::SNUG)
		.w_full()
		.child(mono(gutter(value.old), Role::TextMuted, cx))
		.child(mono(gutter(value.new), Role::TextMuted, cx))
		.child(mono(format!("{}{}", marker(value.kind), value.text), role, cx));
	match fill_role(value.kind) {
		None => line_row,
		Some(fill) => line_row.bg(wash(cx.color(fill))),
	}
}

/// One line-number column, right-aligned in a fixed width.
///
/// An absent number is blank rather than zero: an added line has no old number,
/// and drawing `0` there reads as line zero of the original file.
pub fn gutter(number: Option<u32>) -> String {
	match number {
		None => " ".repeat(GUTTER_DIGITS),
		Some(number) => format!("{number:>GUTTER_DIGITS$}"),
	}
}

/// The character that precedes a line's text.
pub fn marker(kind: DiffLineKind) -> &'static str {
	match kind {
		DiffLineKind::Context => " ",
		DiffLineKind::Added => "+",
		DiffLineKind::Removed => "-",
	}
}

/// The role a line's text reads in.
pub fn line_role(kind: DiffLineKind) -> Role {
	match kind {
		DiffLineKind::Context => Role::DiffContext,
		DiffLineKind::Added => Role::DiffAdded,
		DiffLineKind::Removed => Role::DiffRemoved,
	}
}

/// The role a line's ground is tinted from, or `None` for a context line, which
/// keeps the hunk's own ground.
pub fn fill_role(kind: DiffLineKind) -> Option<Role> {
	match kind {
		DiffLineKind::Context => None,
		DiffLineKind::Added => Some(Role::DiffAddedBg),
		DiffLineKind::Removed => Some(Role::DiffRemovedBg),
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! A diff line carries two line numbers, either of which can be absent, and
	//! that pair is what makes a diff readable. Drawing an absent number as zero
	//! reads as line zero of a file; drawing it in the wrong column reads as a
	//! line that moved. Both look like a diff.
	//!
	//! The counts are the other half: a rename with no line changes has nothing
	//! but its heading, and a heading reporting `+0 −0` reads as a file that was
	//! touched and then reverted.
	//!
	//! WHAT IT DOES NOT CATCH. Intra-line highlighting, which is not drawn, and
	//! whether the gutter is wide enough for a file with more than 9999 lines.

	use veyyon_gui_contract::fixtures;

	use super::*;

	#[test]
	fn an_added_line_has_no_old_number_and_a_removed_line_has_no_new_one() {
		let added = DiffLine::added(19, "use crate::page;");
		let removed = DiffLine::removed(19, "use crate::transcript;");
		let context = DiffLine::context(18, 18, "use crate::chrome::row;");

		assert_eq!(gutter(added.old), "    ");
		assert_eq!(gutter(added.new), "  19");
		assert_eq!(gutter(removed.old), "  19");
		assert_eq!(gutter(removed.new), "    ");
		assert_eq!(gutter(context.old), "  18");
		assert_eq!(gutter(context.new), "  18");
	}

	#[test]
	fn every_gutter_cell_is_the_same_width() {
		for number in [None, Some(0), Some(9), Some(4_242), Some(99_999)] {
			let cell = gutter(number);
			assert!(
				cell.chars().count() >= GUTTER_DIGITS,
				"{number:?} rendered narrower than the gutter"
			);
		}
	}

	#[test]
	fn the_three_line_kinds_never_collapse() {
		let kinds = [DiffLineKind::Context, DiffLineKind::Added, DiffLineKind::Removed];

		let mut roles: Vec<Role> = kinds.iter().copied().map(line_role).collect();
		let count = roles.len();
		roles.sort_by_key(|role| format!("{role:?}"));
		roles.dedup();
		assert_eq!(roles.len(), count, "two line kinds share a role");

		let mut markers: Vec<&str> = kinds.iter().copied().map(marker).collect();
		markers.sort_unstable();
		markers.dedup();
		assert_eq!(markers.len(), count, "two line kinds share a marker");

		assert_eq!(
			fill_role(DiffLineKind::Context),
			None,
			"a context line takes a ground of its own"
		);
	}

	#[test]
	fn an_unchanged_file_reports_no_counts() {
		assert_eq!(counts(0, 0), "");
		assert_eq!(counts(3, 0), "+3");
		assert_eq!(counts(0, 2), "−2");
		assert_eq!(counts(3, 2), "+3 −2");
	}

	#[test]
	fn a_renamed_file_states_both_paths() {
		let fixture = fixtures::views::diff();
		let renamed = fixture
			.files
			.iter()
			.find(|file| file.old_path.is_some())
			.expect("the fixture carries a rename");
		let text = heading(renamed, None, 8);
		assert!(text.contains(" → "), "the heading dropped one of the two paths: {text}");
		assert!(text.contains("capabilities.rs"));
	}

	#[test]
	fn a_plain_file_states_one_path() {
		let plain = DiffFile::new("hosts/gui/contract/src/lib.rs", Vec::new());
		assert_eq!(heading(&plain, None, 8), "hosts/gui/contract/src/lib.rs");
	}
}
