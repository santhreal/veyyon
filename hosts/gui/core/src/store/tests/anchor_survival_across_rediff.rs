//! WHY THIS SUITE EXISTS: Review comments anchored to specific diff lines must
//! survive subsequent patch updates and re-diffs when lines shift due to edits
//! above them or renames. When anchored content is modified or deleted, the
//! thread must be explicitly marked orphaned with the exact reason rather than
//! silently dropped or pointing to mismatched code.
//!
//! WHAT IT DOES NOT CATCH: Pixel-level glyph rendering of diff lines in GPUI.

use crate::{
	model::{
		AnchorContext, LineRange, OrphanReason, ReviewComment, ReviewCommentId, ReviewThread,
		ReviewThreadId, remap_thread_anchor,
	},
	text::diff::{Change, DiffLine, FileDiff, Hunk, LineKind, parse},
};

fn make_thread(path: &str, start: u32, end: u32, context_lines: Vec<&str>) -> ReviewThread {
	ReviewThread::new(
		ReviewThreadId::new("t1"),
		path.to_string(),
		LineRange { start, end },
		AnchorContext::new(context_lines.into_iter().map(String::from).collect()),
		ReviewComment::new(ReviewCommentId::new("c1"), "You", "Comment body"),
	)
}

#[test]
fn anchor_survives_insertions_above() {
	let mut thread =
		make_thread("src/main.rs", 10, 12, vec!["fn target() {", "    println!(\"hello\");", "}"]);

	let diff_lines = [
		"diff --git a/src/main.rs b/src/main.rs",
		"--- a/src/main.rs",
		"+++ b/src/main.rs",
		"@@ -1,3 +1,8 @@",
		"+// added line 1",
		"+// added line 2",
		"+// added line 3",
		"+// added line 4",
		"+// added line 5",
		" fn top() {}",
		"@@ -10,3 +15,3 @@",
		" fn target() {",
		"     println!(\"hello\");",
		" }",
	];

	let files = parse(&diff_lines.join("\n"));
	remap_thread_anchor(&mut thread, &files);

	assert_eq!(thread.path, "src/main.rs");
	assert_eq!(thread.range, LineRange { start: 15, end: 17 });
	assert_eq!(thread.orphan, None);
}

#[test]
fn anchor_survives_deletions_above() {
	let mut thread =
		make_thread("src/main.rs", 10, 12, vec!["fn target() {", "    println!(\"hello\");", "}"]);

	let diff_lines = [
		"diff --git a/src/main.rs b/src/main.rs",
		"--- a/src/main.rs",
		"+++ b/src/main.rs",
		"@@ -1,5 +1,2 @@",
		"-// old 1",
		"-// old 2",
		"-// old 3",
		" fn top() {}",
		"@@ -10,3 +7,3 @@",
		" fn target() {",
		"     println!(\"hello\");",
		" }",
	];

	let files = parse(&diff_lines.join("\n"));
	remap_thread_anchor(&mut thread, &files);

	assert_eq!(thread.path, "src/main.rs");
	assert_eq!(thread.range, LineRange { start: 7, end: 9 });
	assert_eq!(thread.orphan, None);
}

#[test]
fn anchor_survives_file_rename() {
	let mut thread = make_thread("src/old.rs", 5, 6, vec!["let x = 1;", "let y = 2;"]);

	let diff_lines = [
		"diff --git a/src/old.rs b/src/new.rs",
		"similarity index 90%",
		"rename from src/old.rs",
		"rename to src/new.rs",
		"--- a/src/old.rs",
		"+++ b/src/new.rs",
		"@@ -1,2 +1,4 @@",
		"+// header",
		"+// more header",
		"@@ -5,2 +7,2 @@",
		" let x = 1;",
		" let y = 2;",
	];

	let files = parse(&diff_lines.join("\n"));
	remap_thread_anchor(&mut thread, &files);

	assert_eq!(thread.path, "src/new.rs");
	assert_eq!(thread.range, LineRange { start: 7, end: 8 });
	assert_eq!(thread.orphan, None);
}

#[test]
fn anchor_orphans_when_content_modified_inside_range() {
	let mut thread =
		make_thread("src/lib.rs", 10, 12, vec!["fn target() {", "    println!(\"hello\");", "}"]);

	let diff_lines = [
		"diff --git a/src/lib.rs b/src/lib.rs",
		"--- a/src/lib.rs",
		"+++ b/src/lib.rs",
		"@@ -10,3 +10,3 @@",
		"-fn target() {",
		"-    println!(\"hello\");",
		"+fn different_function() {",
		"+    println!(\"world\");",
		" }",
	];

	let files = parse(&diff_lines.join("\n"));
	remap_thread_anchor(&mut thread, &files);

	assert_eq!(thread.orphan, Some(OrphanReason::ContentModified));
}

#[test]
fn anchor_orphans_when_anchored_content_deleted_entirely() {
	let mut thread =
		make_thread("src/lib.rs", 10, 12, vec!["fn target() {", "    println!(\"hello\");", "}"]);

	let diff_lines = [
		"diff --git a/src/lib.rs b/src/lib.rs",
		"--- a/src/lib.rs",
		"+++ b/src/lib.rs",
		"@@ -10,3 +10,0 @@",
		"-fn target() {",
		"-    println!(\"hello\");",
		"-}",
	];

	let files = parse(&diff_lines.join("\n"));
	remap_thread_anchor(&mut thread, &files);

	assert_eq!(thread.orphan, Some(OrphanReason::ContentDeleted));
}

#[test]
fn anchor_orphans_when_file_is_removed() {
	let mut thread = make_thread("src/obsolete.rs", 1, 3, vec!["line 1", "line 2", "line 3"]);

	let diff_lines = [
		"diff --git a/src/obsolete.rs b/dev/null",
		"deleted file mode 100644",
		"--- a/src/obsolete.rs",
		"+++ /dev/null",
		"@@ -1,3 +0,0 @@",
		"-line 1",
		"-line 2",
		"-line 3",
	];

	let files = parse(&diff_lines.join("\n"));
	remap_thread_anchor(&mut thread, &files);

	assert_eq!(thread.orphan, Some(OrphanReason::FileDeleted));
}

#[test]
fn anchor_orphans_when_file_is_binary() {
	let mut thread = make_thread("image.png", 1, 1, vec!["PNG header"]);

	let diff_lines =
		["diff --git a/image.png b/image.png", "Binary files a/image.png and b/image.png differ"];

	let files = parse(&diff_lines.join("\n"));
	remap_thread_anchor(&mut thread, &files);

	assert_eq!(thread.orphan, Some(OrphanReason::BinaryFile));
}

#[test]
fn all_change_kinds_have_anchor_remapping_rules() {
	// Sweep Change::ALL dynamically at run time so adding a variant with no rule
	// fails.
	for change_kind in Change::ALL {
		let mut thread = make_thread("file.rs", 5, 5, vec!["target line"]);
		let file = FileDiff {
			old_path: "file.rs".to_string(),
			new_path: match change_kind {
				Change::Removed => "/dev/null".to_string(),
				Change::Renamed => "renamed_file.rs".to_string(),
				_ => "file.rs".to_string(),
			},
			change:   change_kind,
			hunks:    vec![Hunk {
				old_start: 1,
				old_len:   10,
				new_start: 1,
				new_len:   10,
				section:   String::new(),
				lines:     vec![DiffLine {
					kind:       LineKind::Context,
					text:       "target line".to_string(),
					old_no:     Some(5),
					new_no:     Some(5),
					no_newline: false,
				}],
			}],
			binary:   false,
			mode:     None,
		};

		remap_thread_anchor(&mut thread, &[file]);

		match change_kind {
			Change::Removed => {
				assert_eq!(thread.orphan, Some(OrphanReason::FileDeleted));
			},
			Change::Renamed => {
				assert_eq!(thread.path, "renamed_file.rs");
				assert_eq!(thread.orphan, None);
			},
			Change::Added | Change::Modified => {
				assert_eq!(thread.orphan, None);
			},
		}
	}
}
