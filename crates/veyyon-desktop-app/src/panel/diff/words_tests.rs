//! A diff marks the words a changed line changed: a run of removals pairs
//! line for line with the run of additions right after it, a pair marks the
//! words that differ on both sides, and a rewrite that shares no word, a
//! line left without a partner and lines split by context mark nothing.

use std::ops::Range;

use veyyon_desktop_model::{ChangeScope, ChangesView};

use super::Emphasis;
use crate::panel::diff::parse::parse;

/// Every `(line, range)` the first file of `hunks` marks, `hunks` being the
/// body of a diff of `f.rs` from its first hunk header on.
fn marks(hunks: &str) -> Vec<(usize, Range<usize>)> {
	let view = ChangesView {
		revision:       1,
		repository:     Some("/repo".to_owned()),
		scope:          ChangeScope::WorkingTree,
		files:          Vec::new(),
		diff:           format!("diff --git a/f.rs b/f.rs\n--- a/f.rs\n+++ b/f.rs\n{hunks}"),
		diff_truncated: false,
		files_withheld: 0,
	};
	let parsed = parse(&view);
	let file = &parsed.files[0];
	let emphasis = Emphasis::of(&parsed.source, file);
	(0..file.lines.len())
		.flat_map(|line| emphasis.of_line(line).map(move |range| (line, range)))
		.collect()
}

#[test]
fn a_run_of_removals_pairs_line_for_line_with_the_additions_after_it() {
	let marked = marks(
		"@@ -1,2 +1,2 @@\n-let total = a + b;\n-fn old_name() {\n+let total = a - b;\n+fn \
		 new_name() {\n",
	);
	assert_eq!(marked, [(1, 14..15), (2, 3..11), (3, 14..15), (4, 3..11)]);
}

#[test]
fn a_rewrite_sharing_no_word_marks_nothing() {
	assert_eq!(marks("@@ -1 +1 @@\n-alpha beta\n+gamma delta\n"), []);
}

#[test]
fn a_line_left_without_a_partner_marks_nothing() {
	assert_eq!(marks("@@ -1 +1,2 @@\n-a x\n+a y\n+extra line\n"), [(1, 2..3), (2, 2..3)]);
	assert_eq!(marks("@@ -1,2 +1 @@\n-a x\n-b z\n+a y\n"), [(1, 2..3), (3, 2..3)]);
}

#[test]
fn context_between_a_removal_and_an_addition_keeps_them_apart() {
	assert_eq!(marks("@@ -1,2 +1,2 @@\n-foo 1\n ctx\n+foo 2\n"), []);
}

#[test]
fn a_missing_final_newline_does_not_split_the_pair_around_it() {
	assert_eq!(marks("@@ -1 +1 @@\n-x = 1\n\\ No newline at end of file\n+x = 2\n"), [
		(1, 4..5),
		(3, 4..5)
	]);
}
