//! WHY THIS SUITE EXISTS.
//! One test per shape a file's headers take: a modification, a new file, a
//! deletion, a rename with and without a body, a binary file, and two files
//! in one patch. The header decides the path, the change and the mode, and a
//! header read wrong renames a file in the window that nothing renamed.
//!
//! WHAT IT DOES NOT CATCH. Line numbering inside a hunk and the adversarial
//! corpus, which are the sibling suite.

use crate::text::diff::*;

#[test]
fn a_two_hunk_modification_parses_cleanly() {
	let patch = "diff --git a/src/main.rs b/src/main.rs\nindex 1234567..89abcdef 100644\n--- \
	             a/src/main.rs\n+++ b/src/main.rs\n@@ -1,4 +1,4 @@ fn first()\n-old line 1\n+new \
	             line 1\n common line\n@@ -10,3 +10,4 @@ fn second()\n alpha\n+beta\n gamma\n";

	assert!(looks_like_a_patch(patch));
	let diffs = parse(patch);
	assert_eq!(diffs.len(), 1);
	let diff = &diffs[0];
	assert_eq!(diff.old_path, "src/main.rs");
	assert_eq!(diff.new_path, "src/main.rs");
	assert_eq!(diff.change, Change::Modified);
	assert_eq!(diff.path(), "src/main.rs");
	assert_eq!(diff.added(), 2);
	assert_eq!(diff.removed(), 1);
	assert_eq!(diff.hunks.len(), 2);
	assert_eq!(diff.hunks[0].section, "fn first()");
	assert_eq!(diff.hunks[1].section, "fn second()");
}

#[test]
fn a_new_file_diff_records_added_change_and_mode() {
	let patch = "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ \
	             b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n";

	assert!(looks_like_a_patch(patch));
	let diffs = parse(patch);
	assert_eq!(diffs.len(), 1);
	let diff = &diffs[0];
	assert_eq!(diff.old_path, "/dev/null");
	assert_eq!(diff.new_path, "new.txt");
	assert_eq!(diff.change, Change::Added);
	assert_eq!(diff.mode.as_deref(), Some("100644"));
	assert_eq!(diff.path(), "new.txt");
	assert_eq!(diff.added(), 2);
	assert_eq!(diff.removed(), 0);
}

#[test]
fn a_deleted_file_diff_records_removed_change_and_path() {
	let patch = "diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ \
	             /dev/null\n@@ -1,2 +0,0 @@\n-goodbye\n-world\n";

	assert!(looks_like_a_patch(patch));
	let diffs = parse(patch);
	assert_eq!(diffs.len(), 1);
	let diff = &diffs[0];
	assert_eq!(diff.old_path, "old.txt");
	assert_eq!(diff.new_path, "/dev/null");
	assert_eq!(diff.change, Change::Removed);
	assert_eq!(diff.mode.as_deref(), Some("100644"));
	assert_eq!(diff.path(), "old.txt");
	assert_eq!(diff.added(), 0);
	assert_eq!(diff.removed(), 2);
}

#[test]
fn a_rename_without_content_change_records_renamed_paths() {
	let patch = "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from \
	             old.txt\nrename to new.txt\n";

	let diffs = parse(patch);
	assert_eq!(diffs.len(), 1);
	let diff = &diffs[0];
	assert_eq!(diff.old_path, "old.txt");
	assert_eq!(diff.new_path, "new.txt");
	assert_eq!(diff.change, Change::Renamed);
	assert_eq!(diff.path(), "new.txt");
	assert_eq!(diff.added(), 0);
	assert_eq!(diff.removed(), 0);
	assert!(diff.hunks.is_empty());
}

#[test]
fn a_rename_with_content_change_records_renamed_and_hunks() {
	let patch = "diff --git a/old.txt b/new.txt\nsimilarity index 80%\nrename from old.txt\nrename \
	             to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1,2 +1,2 @@\n-alpha\n+beta\n gamma\n";

	assert!(looks_like_a_patch(patch));
	let diffs = parse(patch);
	assert_eq!(diffs.len(), 1);
	let diff = &diffs[0];
	assert_eq!(diff.old_path, "old.txt");
	assert_eq!(diff.new_path, "new.txt");
	assert_eq!(diff.change, Change::Renamed);
	assert_eq!(diff.path(), "new.txt");
	assert_eq!(diff.added(), 1);
	assert_eq!(diff.removed(), 1);
	assert_eq!(diff.hunks.len(), 1);
}

#[test]
fn a_binary_file_diff_sets_binary_flag() {
	let patch = "diff --git a/logo.png b/logo.png\nindex 1111111..2222222 100644\nBinary files \
	             a/logo.png and b/logo.png differ\n";

	let diffs = parse(patch);
	assert_eq!(diffs.len(), 1);
	let diff = &diffs[0];
	assert_eq!(diff.old_path, "logo.png");
	assert_eq!(diff.new_path, "logo.png");
	assert!(diff.binary);
	assert_eq!(diff.change, Change::Modified);
	assert_eq!(diff.path(), "logo.png");
	assert_eq!(diff.added(), 0);
	assert_eq!(diff.removed(), 0);
}

#[test]
fn a_patch_with_two_files_splits_into_two_diffs() {
	let patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 \
	             @@\n-one\n+two\ndiff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1,1 \
	             +1,1 @@\n-three\n+four\n";

	assert!(looks_like_a_patch(patch));
	let diffs = parse(patch);
	assert_eq!(diffs.len(), 2);
	assert_eq!(diffs[0].path(), "a.txt");
	assert_eq!(diffs[0].change, Change::Modified);
	assert_eq!(diffs[0].added(), 1);
	assert_eq!(diffs[0].removed(), 1);
	assert_eq!(diffs[1].path(), "b.txt");
	assert_eq!(diffs[1].change, Change::Modified);
	assert_eq!(diffs[1].added(), 1);
	assert_eq!(diffs[1].removed(), 1);
}
