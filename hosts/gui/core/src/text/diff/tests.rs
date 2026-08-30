//! WHY THIS SUITE EXISTS.
//! This suite tests unified diff parsing across standard git output, plain
//! diffs, hand-edited patches, adversarial malformed text, and boundary
//! line numbering.
//!
//! WHAT IT DOES NOT CATCH.
//! It does not catch rendering discrepancies in graphical front ends or
//! downstream layout bugs.

mod headers;

use super::*;

#[test]
fn no_newline_at_end_of_file_marks_preceding_line() {
	let patch = "--- a/file.txt\n+++ b/file.txt\n@@ -1,1 +1,1 @@\n-removed text\n\\ No newline at \
	             end of file\n+added text\n\\ No newline at end of file\n";

	assert!(looks_like_a_patch(patch));
	let diffs = parse(patch);
	assert_eq!(diffs.len(), 1);
	let diff = &diffs[0];
	assert_eq!(diff.path(), "file.txt");
	assert_eq!(diff.change, Change::Modified);
	assert_eq!(diff.added(), 1);
	assert_eq!(diff.removed(), 1);
	let hunk = &diff.hunks[0];
	assert_eq!(hunk.lines.len(), 2);
	assert_eq!(hunk.lines[0].kind, LineKind::Removed);
	assert_eq!(hunk.lines[0].text, "removed text");
	assert!(hunk.lines[0].no_newline);
	assert_eq!(hunk.lines[1].kind, LineKind::Added);
	assert_eq!(hunk.lines[1].text, "added text");
	assert!(hunk.lines[1].no_newline);
}

#[test]
fn diff_u_patch_with_tab_and_timestamp_parses_paths() {
	let patch = "--- a/test.c\t2026-08-30 10:00:00.000000000 +0000\n+++ b/test.c\t2026-08-30 \
	             10:05:00.000000000 +0000\n@@ -1,2 +1,2 @@\n-int a;\n+int b;\n int c;\n";

	assert!(looks_like_a_patch(patch));
	let diffs = parse(patch);
	assert_eq!(diffs.len(), 1);
	let diff = &diffs[0];
	assert_eq!(diff.old_path, "test.c");
	assert_eq!(diff.new_path, "test.c");
	assert_eq!(diff.change, Change::Modified);
	assert_eq!(diff.path(), "test.c");
	assert_eq!(diff.added(), 1);
	assert_eq!(diff.removed(), 1);
}

#[test]
fn quoted_path_containing_space_is_unquoted() {
	let patch =
		"--- \"a/path with space.txt\"\n+++ \"b/path with space.txt\"\n@@ -1,1 +1,1 @@\n-old\n+new\n";

	assert!(looks_like_a_patch(patch));
	let diffs = parse(patch);
	assert_eq!(diffs.len(), 1);
	let diff = &diffs[0];
	assert_eq!(diff.old_path, "path with space.txt");
	assert_eq!(diff.new_path, "path with space.txt");
	assert_eq!(diff.change, Change::Modified);
	assert_eq!(diff.path(), "path with space.txt");
	assert_eq!(diff.added(), 1);
	assert_eq!(diff.removed(), 1);
}

#[test]
fn malformed_hunk_header_between_good_hunks_is_skipped() {
	let patch = "--- a/doc.txt\n+++ b/doc.txt\n@@ -1,2 +1,2 @@\n line 1\n-line 2\n+line 2 mod\n@@ \
	             not a valid header @@\nsome random text\n@@ -20,2 +20,2 @@\n line 20\n+line 21\n";

	assert!(looks_like_a_patch(patch));
	let diffs = parse(patch);
	assert_eq!(diffs.len(), 1);
	let diff = &diffs[0];
	assert_eq!(diff.path(), "doc.txt");
	assert_eq!(diff.change, Change::Modified);
	assert_eq!(diff.added(), 2);
	assert_eq!(diff.removed(), 1);
	assert_eq!(diff.hunks.len(), 2);
	assert_eq!(diff.hunks[0].old_start, 1);
	assert_eq!(diff.hunks[1].old_start, 20);
}

#[test]
fn bare_hunk_with_no_file_header_parses() {
	let patch = "@@ -1,2 +1,2 @@\n-before\n+after\n context\n";

	assert!(looks_like_a_patch(patch));
	let diffs = parse(patch);
	assert_eq!(diffs.len(), 1);
	let diff = &diffs[0];
	assert_eq!(diff.old_path, "");
	assert_eq!(diff.new_path, "");
	assert_eq!(diff.change, Change::Modified);
	assert_eq!(diff.path(), "");
	assert_eq!(diff.added(), 1);
	assert_eq!(diff.removed(), 1);
}

#[test]
fn crlf_line_endings_are_handled_correctly() {
	let patch = "--- a/crlf.txt\r\n+++ b/crlf.txt\r\n@@ -1,2 +1,2 @@\r\n-line 1\r\n+line 1 mod\r\n \
	             line 2\r\n";

	assert!(looks_like_a_patch(patch));
	let diffs = parse(patch);
	assert_eq!(diffs.len(), 1);
	let diff = &diffs[0];
	assert_eq!(diff.old_path, "crlf.txt");
	assert_eq!(diff.new_path, "crlf.txt");
	assert_eq!(diff.change, Change::Modified);
	assert_eq!(diff.path(), "crlf.txt");
	assert_eq!(diff.added(), 1);
	assert_eq!(diff.removed(), 1);
	assert_eq!(diff.hunks[0].lines[0].text, "line 1");
	assert_eq!(diff.hunks[0].lines[1].text, "line 1 mod");
	assert_eq!(diff.hunks[0].lines[2].text, "line 2");
}

#[test]
fn exact_diff_line_numbering_for_hunk_starting_at_40() {
	let patch = "@@ -40,4 +40,4 @@\n context 1\n-removed 1\n+added 1\n context 2\n";

	assert!(looks_like_a_patch(patch));
	let diffs = parse(patch);
	assert_eq!(diffs.len(), 1);
	let diff = &diffs[0];
	assert_eq!(diff.change, Change::Modified);
	assert_eq!(diff.added(), 1);
	assert_eq!(diff.removed(), 1);
	let lines = &diff.hunks[0].lines;
	assert_eq!(lines.len(), 4);

	assert_eq!(lines[0].kind, LineKind::Context);
	assert_eq!(lines[0].text, "context 1");
	assert_eq!(lines[0].old_no, Some(40));
	assert_eq!(lines[0].new_no, Some(40));

	assert_eq!(lines[1].kind, LineKind::Removed);
	assert_eq!(lines[1].text, "removed 1");
	assert_eq!(lines[1].old_no, Some(41));
	assert_eq!(lines[1].new_no, None);

	assert_eq!(lines[2].kind, LineKind::Added);
	assert_eq!(lines[2].text, "added 1");
	assert_eq!(lines[2].old_no, None);
	assert_eq!(lines[2].new_no, Some(41));

	assert_eq!(lines[3].kind, LineKind::Context);
	assert_eq!(lines[3].text, "context 2");
	assert_eq!(lines[3].old_no, Some(42));
	assert_eq!(lines[3].new_no, Some(42));
}

#[test]
fn looks_like_a_patch_returns_true_for_diff_and_false_for_prose() {
	assert!(looks_like_a_patch("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n"));
	assert!(looks_like_a_patch("@@ -1,2 +1,2 @@\n-a\n+b\n"));

	assert!(!looks_like_a_patch(""));
	assert!(!looks_like_a_patch("- bullet point 1\n- bullet point 2\n"));
	assert!(!looks_like_a_patch("| A | B |\n|---|---|\n| -1 | +2 |\n"));
	assert!(!looks_like_a_patch("const delta = a - b;\nconst sum = a + b;\n"));
}

#[test]
fn adversarial_inputs_do_not_panic_and_parse_reliably() {
	assert_eq!(parse(""), Vec::new());
	assert_eq!(parse("@@"), Vec::new());
	assert_eq!(parse("@@\n@@\n"), Vec::new());

	// 10k-line hunk
	let mut large_patch = String::from("@@ -1,10000 +1,10000 @@\n");
	for i in 0..10000 {
		large_patch.push_str(&format!(" line {}\n", i));
	}
	let diffs = parse(&large_patch);
	assert_eq!(diffs.len(), 1);
	assert_eq!(diffs[0].hunks[0].lines.len(), 10000);

	// Hunk claiming lengths that disagree with lines present
	let disagree = "@@ -1,100 +1,100 @@\n-only one\n+only two\n";
	let diffs = parse(disagree);
	assert_eq!(diffs.len(), 1);
	assert_eq!(diffs[0].hunks[0].old_len, 100);
	assert_eq!(diffs[0].hunks[0].new_len, 100);
	assert_eq!(diffs[0].hunks[0].lines.len(), 2);
	assert_eq!(diffs[0].hunks[0].lines[0].old_no, Some(1));
	assert_eq!(diffs[0].hunks[0].lines[1].new_no, Some(1));

	// Multibyte content and combining marks
	let multibyte = "--- a/日本語.txt\n+++ b/日本語.txt\n@@ -1,2 +1,2 @@\n-日本語 テスト \
	                 e\u{301}\n+日本語 改変 e\u{301}\n 継続\n";
	let diffs = parse(multibyte);
	assert_eq!(diffs.len(), 1);
	assert_eq!(diffs[0].path(), "日本語.txt");
	assert_eq!(diffs[0].change, Change::Modified);
	assert_eq!(diffs[0].added(), 1);
	assert_eq!(diffs[0].removed(), 1);
	assert_eq!(diffs[0].hunks[0].lines[0].text, "日本語 テスト e\u{301}");
	assert_eq!(diffs[0].hunks[0].lines[1].text, "日本語 改変 e\u{301}");

	// Line that is only backslash
	let lone_backslash = "@@ -1,1 +1,1 @@\n-before\n\\\n";
	let diffs = parse(lone_backslash);
	assert_eq!(diffs.len(), 1);
	assert!(diffs[0].hunks[0].lines[0].no_newline);
}
