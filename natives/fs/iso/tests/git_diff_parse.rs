//! `parse_git_diff`: splitting `git diff` output into per-file entries.
//!
//! WHY THIS SUITE EXISTS. Isolation's git mode is the path that reports what
//! changed inside a sandbox, and every part of it except this function shells
//! out to `git`, so this is the only piece that can be checked without a
//! repository on disk. It had no tests at all until the `iso_git_diff_parse`
//! fuzz target needed it public, and a fuzzer alone is the wrong artifact here:
//! it proves the parser does not crash and says nothing about whether it read
//! the diff correctly. These cases pin what it must read.
//!
//! The contract has three parts, and all three are silent when broken. A file's
//! entry must carry the path `git` named, or the change is attributed to the
//! wrong file. Its change kind must distinguish an added file from a modified
//! one, because a caller that copies contents out reads a different
//! tree for each. And a text entry's diff must be the original slice
//! unmodified, because it is handed to `git apply` downstream, where one
//! rewritten byte is a patch that does not apply.

use std::path::PathBuf;

use veyyon_iso::{ChangeKind, Diff, FileChange, parse_git_diff};

/// A minimal but real two-file diff, matching what `git diff --no-color HEAD`
/// emits.
const TWO_FILES: &str = "diff --git a/src/one.rs b/src/one.rs\nindex 1111111..2222222 100644\n--- \
                         a/src/one.rs\n+++ b/src/one.rs\n@@ -1 +1 @@\n-old\n+new\ndiff --git \
                         a/src/two.rs b/src/two.rs\nindex 3333333..4444444 100644\n--- \
                         a/src/two.rs\n+++ b/src/two.rs\n@@ -1 +1,2 @@\nkept\n+added\n";

fn paths(entries: &[FileChange]) -> Vec<PathBuf> {
	entries.iter().map(|entry| entry.path.clone()).collect()
}

/// One entry per `diff --git` block, in the order `git` emitted them.
///
/// Order is load-bearing rather than incidental: a caller rendering the change
/// list shows it in this order, and a caller applying the entries one at a time
/// depends on it when two entries touch the same directory.
#[test]
fn splits_a_blob_into_one_entry_per_file_in_order() {
	let entries = parse_git_diff(TWO_FILES.as_bytes());

	assert_eq!(paths(&entries), vec![PathBuf::from("src/one.rs"), PathBuf::from("src/two.rs")]);
}

/// The path comes from the `b/` side, with the prefix stripped.
///
/// The `a/` and `b/` sides differ for a rename, and the `b/` side is the one
/// that exists in the merged tree the caller is going to read. Taking the `a/`
/// side would name a file that is gone.
#[test]
fn takes_the_destination_path_and_strips_the_b_prefix() {
	let renamed = "diff --git a/before.txt b/after.txt\nsimilarity index 90%\nrename from \
	               before.txt\nrename to after.txt\n";

	let entries = parse_git_diff(renamed.as_bytes());

	assert_eq!(paths(&entries), vec![PathBuf::from("after.txt")]);
}

/// A text entry carries its block verbatim, header line included.
///
/// This is the contract that makes an entry independently applicable. Asserted
/// as exact bytes rather than as a substring check, because a parser that
/// dropped the header or the trailing newline would still pass a looser
/// assertion and still produce a patch `git apply` refuses.
#[test]
fn keeps_each_block_byte_for_byte() {
	let entries = parse_git_diff(TWO_FILES.as_bytes());

	assert_eq!(
		entries[0].diff.as_deref(),
		Some(
			"diff --git a/src/one.rs b/src/one.rs\nindex 1111111..2222222 100644\n--- \
			 a/src/one.rs\n+++ b/src/one.rs\n@@ -1 +1 @@\n-old\n+new\n"
		)
	);
	assert_eq!(
		entries[1].diff.as_deref(),
		Some(
			"diff --git a/src/two.rs b/src/two.rs\nindex 3333333..4444444 100644\n--- \
			 a/src/two.rs\n+++ b/src/two.rs\n@@ -1 +1,2 @@\nkept\n+added\n"
		)
	);
}

/// `new file mode` marks the entry as added rather than modified.
///
/// The kinds are not cosmetic: a caller copying binary contents out reads
/// `merged` for an added or modified file and `lower` for a removed one, so a
/// misread kind reads the wrong tree and either finds nothing or copies a stale
/// file.
#[test]
fn reads_an_added_file_from_its_mode_line() {
	let added = "diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..e69de29\n";

	let entries = parse_git_diff(added.as_bytes());

	assert_eq!(entries.len(), 1);
	assert_eq!(entries[0].op, ChangeKind::Added);
	assert_eq!(entries[0].path, PathBuf::from("new.txt"));
}

/// And `deleted file mode` marks it as removed.
#[test]
fn reads_a_removed_file_from_its_mode_line() {
	let removed =
		"diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\nindex e69de29..0000000\n";

	let entries = parse_git_diff(removed.as_bytes());

	assert_eq!(entries.len(), 1);
	assert_eq!(entries[0].op, ChangeKind::Removed);
}

/// Anything without a mode line is a modification, which is the common case.
#[test]
fn defaults_to_modified() {
	let entries = parse_git_diff(TWO_FILES.as_bytes());

	assert!(entries.iter().all(|entry| entry.op == ChangeKind::Modified));
}

/// A binary block is reported as an entry with no text.
///
/// `git` is deliberately not run with `--binary`, so what arrives is the
/// placeholder line rather than the bytes. Emitting that placeholder as an
/// entry's diff would hand a caller a patch that claims to describe a change
/// and contains none of it, which `git apply` accepts as a no-op: the
/// change would be silently lost. `None` is what tells the caller to copy the
/// file instead.
#[test]
fn reports_a_binary_block_as_an_entry_with_no_diff() {
	let binary = "diff --git a/logo.png b/logo.png\nindex 1111111..2222222 100644\nBinary files \
	              a/logo.png and b/logo.png differ\n";

	let entries = parse_git_diff(binary.as_bytes());

	assert_eq!(entries.len(), 1);
	assert_eq!(entries[0].path, PathBuf::from("logo.png"));
	assert_eq!(entries[0].diff, None);
}

/// The other spelling `git` uses for the same thing.
#[test]
fn recognizes_the_git_binary_patch_spelling() {
	let binary = "diff --git a/blob.bin b/blob.bin\nGIT binary patch\nliteral 4\n";

	let entries = parse_git_diff(binary.as_bytes());

	assert_eq!(entries.len(), 1);
	assert_eq!(entries[0].diff, None);
}

/// A blank blob is no changes, not an error and not one empty entry.
#[test]
fn parses_an_empty_blob_to_no_entries() {
	assert!(parse_git_diff(b"").is_empty());
}

/// Output before the first header belongs to no file and is dropped.
///
/// This is the case a preamble would corrupt: text attributed to the first file
/// would be prepended to its patch and make it unapplicable.
#[test]
fn drops_anything_before_the_first_header() {
	let with_preamble = format!("warning: something\nunrelated line\n{TWO_FILES}");

	let entries = parse_git_diff(with_preamble.as_bytes());

	assert_eq!(paths(&entries), vec![PathBuf::from("src/one.rs"), PathBuf::from("src/two.rs")]);
	assert_eq!(
		entries[0]
			.diff
			.as_deref()
			.map(|d| d.starts_with("diff --git ")),
		Some(true)
	);
}

/// Invalid UTF-8 is refused wholesale rather than salvaged.
///
/// Refusing everything is the safe answer, because a partially decoded diff
/// would produce entries whose text is not what `git` emitted, and those
/// entries would then be applied. Reporting no changes is visibly wrong;
/// reporting subtly wrong changes is not.
#[test]
fn refuses_a_blob_that_is_not_utf8() {
	let mut blob = TWO_FILES.as_bytes().to_vec();
	blob.push(0xff);

	assert!(parse_git_diff(&blob).is_empty());
}

/// A header with no space between the two paths names no file, so nothing is
/// emitted for it.
///
/// Adjacent well-formed blocks must survive it. A parser that gave up at the
/// first malformed header would drop every later file, and the caller would see
/// a shorter change list with no error.
#[test]
fn skips_a_malformed_header_without_losing_the_next_file() {
	let malformed = format!("diff --git nonsense\nsome body\n{TWO_FILES}");

	let entries = parse_git_diff(malformed.as_bytes());

	assert_eq!(paths(&entries), vec![PathBuf::from("src/one.rs"), PathBuf::from("src/two.rs")]);
}

/// A filename containing a space is parsed by the first space, which is what
/// `git` guarantees.
///
/// Documented rather than merely asserted, because it is a real limit:
/// `core.quotepath=off` is set when the diff is taken, and a path with a space
/// arrives unquoted, so the `a/` side ends where the scanner says it does. This
/// case pins the current behaviour so a future change to it is a decision
/// somebody made rather than a silent drift.
#[test]
fn splits_a_header_at_its_first_space() {
	let spaced = "diff --git a/my file.txt b/my file.txt\nindex 1111111..2222222 100644\n";

	let entries = parse_git_diff(spaced.as_bytes());

	assert_eq!(entries.len(), 1);
	assert_eq!(entries[0].path, PathBuf::from("file.txt b/my file.txt"));
}

/// Re-parsing one entry's text yields exactly that entry again.
///
/// The property the fuzz target searches for a counterexample to, pinned here
/// on a known input so a regression is caught by `cargo test` rather than only
/// by a fuzzing campaign. Splitting a blob into pieces is only correct if each
/// piece is itself a whole blob.
#[test]
fn each_entry_reparses_to_itself() {
	for entry in parse_git_diff(TWO_FILES.as_bytes()) {
		let text = entry
			.diff
			.clone()
			.expect("this fixture has no binary entries");

		let reparsed = parse_git_diff(text.as_bytes());

		assert_eq!(reparsed.len(), 1);
		assert_eq!(reparsed[0].path, entry.path);
		assert_eq!(reparsed[0].op, entry.op);
		assert_eq!(reparsed[0].diff, entry.diff);
	}
}

/// `unified_text` concatenates the text entries and skips the binary ones.
///
/// Asserted as exact bytes, because the whole value of this string is that it
/// can be applied, and a missing or added newline between two blocks is enough
/// to break that.
#[test]
fn unified_text_joins_text_entries_and_omits_binary_ones() {
	let mut files = parse_git_diff(TWO_FILES.as_bytes());
	files.push(FileChange {
		path: PathBuf::from("logo.png"),
		op:   ChangeKind::Modified,
		diff: None,
	});
	let diff = Diff { files };

	assert_eq!(diff.unified_text(), TWO_FILES);
}
