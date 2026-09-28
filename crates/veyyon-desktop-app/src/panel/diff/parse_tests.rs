//! The parser reads what `git diff` writes: headers, hunks bounded by their
//! own counts, renames, binary files and the no-newline marker.

use veyyon_desktop_model::{ChangeScope, ChangeStatus, ChangedFile, ChangesView};

use super::{LineKind, Side, parse};

fn view(diff: &str, files: Vec<ChangedFile>) -> ChangesView {
	ChangesView {
		revision: 1,
		repository: Some("/repo".to_owned()),
		scope: ChangeScope::WorkingTree,
		files,
		diff: diff.to_owned(),
		diff_truncated: false,
		files_withheld: 0,
	}
}

const TWO_FILES: &str = "diff --git a/src/a.rs b/src/a.rs\nindex 1..2 100644\n--- a/src/a.rs\n+++ \
                         b/src/a.rs\n@@ -1,3 +1,3 @@\n fn a() {\n--- removed dashes\n+++ added \
                         pluses\n }\ndiff --git a/old.txt b/new.txt\nrename from old.txt\nrename \
                         to new.txt\n@@ -1 +1,2 @@\n-x\n+y\n+\n\\ No newline at end of file\n";

#[test]
fn a_hunk_ends_on_its_counts_so_sign_lookalikes_stay_lines() {
	let parsed = parse(&view(TWO_FILES, Vec::new()));
	let paths: Vec<_> = parsed.files.iter().map(|file| file.path.as_str()).collect();
	assert_eq!(paths, ["src/a.rs", "new.txt"]);
	let first = &parsed.files[0];
	let kinds: Vec<_> = first.lines.iter().map(|line| line.kind).collect();
	assert_eq!(kinds, [
		LineKind::Hunk,
		LineKind::Context,
		LineKind::Removed,
		LineKind::Added,
		LineKind::Context
	]);
	let text = |ix: usize| &parsed.source[first.lines[ix].text.clone()];
	assert_eq!(text(2), "-- removed dashes");
	assert_eq!(text(3), "++ added pluses");
	assert_eq!((first.additions, first.deletions), (1, 1));
	assert_eq!(first.hunks, [0]);
}

#[test]
fn line_numbers_advance_per_side() {
	let parsed = parse(&view(TWO_FILES, Vec::new()));
	let numbers: Vec<_> = parsed.files[0]
		.lines
		.iter()
		.map(|line| (line.old, line.new))
		.collect();
	assert_eq!(numbers, [
		(None, None),
		(Some(1), Some(1)),
		(Some(2), None),
		(None, Some(2)),
		(Some(3), Some(3))
	]);
}

#[test]
fn a_rename_keeps_both_paths_and_an_empty_added_line_and_the_marker() {
	let parsed = parse(&view(TWO_FILES, Vec::new()));
	let second = &parsed.files[1];
	assert_eq!(second.previous_path.as_deref(), Some("old.txt"));
	let kinds: Vec<_> = second.lines.iter().map(|line| line.kind).collect();
	assert_eq!(kinds, [
		LineKind::Hunk,
		LineKind::Removed,
		LineKind::Added,
		LineKind::Added,
		LineKind::Note
	]);
	assert!(second.lines[3].text.is_empty());
	assert_eq!(parsed.files.len(), 2, "the marker after the hunk starts no file");
}

#[test]
fn side_offsets_index_the_side_text() {
	let parsed = parse(&view(TWO_FILES, Vec::new()));
	let file = &parsed.files[0];
	let new = file.side_text(&parsed.source, Side::New);
	let old = file.side_text(&parsed.source, Side::Old);
	for line in &file.lines {
		let Some(side) = line.side() else { continue };
		let text = if side == Side::Old { &old } else { &new };
		let own = &parsed.source[line.text.clone()];
		assert_eq!(&text[line.at..line.at + own.len()], own);
	}
}

#[test]
fn a_listed_file_without_diff_text_is_kept_and_binary_is_marked() {
	let diff = "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n";
	let listed = |path: &str, status| ChangedFile {
		path: path.to_owned(),
		previous_path: None,
		status,
		additions: 4,
		deletions: 0,
	};
	let parsed = parse(&view(diff, vec![
		listed("img.png", ChangeStatus::Modified),
		listed("new.rs", ChangeStatus::Untracked),
	]));
	assert_eq!(parsed.files.len(), 2);
	assert!(parsed.files[0].binary);
	assert_eq!(parsed.files[1].path, "new.rs");
	assert_eq!(parsed.files[1].status, Some(ChangeStatus::Untracked));
	assert_eq!(parsed.files[1].additions, 4);
}
