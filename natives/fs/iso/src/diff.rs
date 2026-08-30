//! Backend-agnostic change capture.
//!
//! Two code paths, both producing a [`Diff`] = list of [`FileChange`]:
//!
//! - **Git mode.** When `merged/.git` exists we shell `git diff --no-color
//!   HEAD` plus `git ls-files --others --exclude-standard` (for untracked),
//!   split the output on `diff --git` headers, and emit one [`FileChange`] per
//!   file. Binary entries surface as `diff: None`.
//! - **Plain mode.** No `.git`; we walk both trees in parallel, short-circuit
//!   on `(size, mtime-truncated-to-seconds)` equality, and emit a unified diff
//!   for each surviving pair. The unified body, the rule for what counts as a
//!   line, and the NUL window that classifies a file as binary → `diff: None`
//!   all come from `veyyon-diff-kernel`, shared with the `diff` shell builtin.
//!
//! Per the PAL contract: for binary files we don't materialize the bytes
//! in the patch — callers that want them read directly from `merged`
//! (for `Added`/`Modified`) or `lower` (for `Removed`).

use std::{
	collections::BTreeMap,
	fs::Metadata,
	path::{Path, PathBuf},
	time::SystemTime,
};

use tokio::process::Command;
use veyyon_diff_kernel::{Ignore, Unified, looks_binary};

use crate::{IsoError, IsoResult, command_failed};

/// Lines of context either side of a change in the patch text this crate emits.
///
/// Three is what `diff -u` and `git diff` both default to, and a patch these
/// produce is read by the same eyes and tools, so it matches rather than
/// inventing its own width.
const UNIFIED_CONTEXT: usize = 3;

/// Captured changes between a `lower` baseline and a `merged` view.
#[derive(Debug, Clone, Default)]
pub struct Diff {
	pub files: Vec<FileChange>,
}

impl Diff {
	pub const fn is_empty(&self) -> bool {
		self.files.is_empty()
	}

	/// Concatenated unified-diff text for every text-representable entry.
	/// Binary entries are skipped — enumerate via [`files`](Self::files)
	/// and copy them out-of-band if you need their contents.
	pub fn unified_text(&self) -> String {
		let mut out = String::new();
		for file in &self.files {
			let Some(diff) = &file.diff else { continue };
			if diff.is_empty() {
				continue;
			}
			if !out.is_empty() && !out.ends_with('\n') {
				out.push('\n');
			}
			out.push_str(diff);
		}
		out
	}
}

/// One entry in a [`Diff`].
///
/// `path` is relative to `merged`. `diff = None` means the file is binary
/// or otherwise text-unrepresentable — copy the contents from the merged
/// tree if you need them (or skip if you only care about text).
#[derive(Debug, Clone)]
pub struct FileChange {
	pub path: PathBuf,
	pub op:   ChangeKind,
	pub diff: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
	Added,
	Modified,
	Removed,
}

/// Default backend diff: git when available, mtime-skipped walk otherwise.
pub async fn default_diff(lower: &Path, merged: &Path) -> IsoResult<Diff> {
	if is_git_tree(merged).await {
		git_diff(merged).await
	} else {
		walk_diff(lower, merged).await
	}
}

async fn is_git_tree(merged: &Path) -> bool {
	tokio::fs::symlink_metadata(merged.join(".git"))
		.await
		.is_ok()
}

// ─── git mode ───────────────────────────────────────────────────────────────

async fn git_diff(merged: &Path) -> IsoResult<Diff> {
	// `--no-color`: keep ANSI out of patch text.
	// No `--binary`: we *want* git's `Binary files … differ` placeholder
	// so we can map it to `diff: None`.
	let tracked =
		git_run(merged, &["-c", "core.quotepath=off", "diff", "--no-color", "HEAD"]).await?;

	let untracked_list = git_run(merged, &[
		"-c",
		"core.quotepath=off",
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
	])
	.await?;

	let mut files = parse_git_diff(&tracked);

	let mut untracked_paths: Vec<&[u8]> = untracked_list
		.split(|b| *b == 0)
		.filter(|s| !s.is_empty())
		.collect();
	untracked_paths.sort_unstable();

	for path_bytes in untracked_paths {
		let path_str = std::str::from_utf8(path_bytes)
			.map_err(|err| IsoError::other(format!("untracked path is not valid UTF-8: {err}")))?;
		let one = git_run_allow_exit1(merged, &[
			"-c",
			"core.quotepath=off",
			"diff",
			"--no-color",
			"--no-index",
			git_null_path(),
			path_str,
		])
		.await?;
		files.extend(parse_git_diff(&one));
	}

	files.sort_by(|a, b| a.path.cmp(&b.path));
	Ok(Diff { files })
}

#[cfg(windows)]
const fn git_null_path() -> &'static str {
	"NUL"
}

#[cfg(not(windows))]
const fn git_null_path() -> &'static str {
	"/dev/null"
}

/// Format a failed `git` invocation, rendering a signal death as `exit ?`.
fn git_failure(args: &[&str], output: &std::process::Output) -> IsoError {
	command_failed(
		format_args!("git {}", args.join(" ")),
		output
			.status
			.code()
			.map_or_else(|| "?".into(), |c| c.to_string()),
		&output.stderr,
	)
}

async fn git_run(cwd: &Path, args: &[&str]) -> IsoResult<Vec<u8>> {
	let output = git_spawn(cwd, args).await?;
	if !output.status.success() {
		return Err(git_failure(args, &output));
	}
	Ok(output.stdout)
}

/// `git diff --no-index` returns exit code 1 when files differ — that's
/// not an error for us, treat it as success with the produced patch.
async fn git_run_allow_exit1(cwd: &Path, args: &[&str]) -> IsoResult<Vec<u8>> {
	let output = git_spawn(cwd, args).await?;
	if output.status.success() || output.status.code() == Some(1) {
		return Ok(output.stdout);
	}
	Err(git_failure(args, &output))
}

async fn git_spawn(cwd: &Path, args: &[&str]) -> IsoResult<std::process::Output> {
	let mut cmd = Command::new("git");
	cmd.arg("-C").arg(cwd).args(args);
	cmd.stdin(std::process::Stdio::null());
	cmd.output().await.map_err(|err| {
		if err.kind() == std::io::ErrorKind::NotFound {
			IsoError::unavailable("`git` not on PATH; cannot capture diff for git-tracked tree")
		} else {
			IsoError::other(format!("spawn git: {err}"))
		}
	})
}

/// Split a `git diff` blob into per-file [`FileChange`] entries.
///
/// Each entry covers exactly one `diff --git a/<path> b/<path>` block. Binary
/// blocks are emitted with `diff: None`; the rest carry their original
/// unified-diff slice unchanged so `git apply` produces byte-identical
/// results downstream.
///
/// Public because it is the only part of git mode that can be exercised without
/// a repository on disk: everything around it shells out to `git`. Fuzzed by
/// the `iso_git_diff_parse` target, whose input is `git`'s stdout, and which is
/// therefore the one place a malformed blob is cheap to try.
#[must_use]
pub fn parse_git_diff(blob: &[u8]) -> Vec<FileChange> {
	let Ok(text) = std::str::from_utf8(blob) else {
		return Vec::new();
	};
	let mut out = Vec::<FileChange>::new();
	let iter = text.split_inclusive('\n');
	let mut buf = String::new();
	let mut header_path: Option<PathBuf> = None;
	let mut header_kind = ChangeKind::Modified;
	let mut header_binary = false;

	let flush = |buf: &mut String,
	             path: &mut Option<PathBuf>,
	             kind: &mut ChangeKind,
	             binary: &mut bool,
	             out: &mut Vec<FileChange>| {
		if let Some(p) = path.take() {
			let diff = if *binary {
				None
			} else {
				Some(std::mem::take(buf))
			};
			out.push(FileChange { path: p, op: *kind, diff });
		}
		buf.clear();
		*kind = ChangeKind::Modified;
		*binary = false;
	};

	for line in iter {
		if let Some(rest) = line.strip_prefix("diff --git ") {
			flush(&mut buf, &mut header_path, &mut header_kind, &mut header_binary, &mut out);
			let trimmed = rest.trim_end_matches('\n');
			if let Some((_, b)) = trimmed.split_once(' ') {
				let path = b.strip_prefix("b/").unwrap_or(b);
				header_path = Some(PathBuf::from(path));
			}
			buf.push_str(line);
			continue;
		}
		if header_path.is_some() {
			if line.starts_with("new file mode ") {
				header_kind = ChangeKind::Added;
			} else if line.starts_with("deleted file mode ") {
				header_kind = ChangeKind::Removed;
			} else if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
				header_binary = true;
			}
			buf.push_str(line);
		}
	}
	flush(&mut buf, &mut header_path, &mut header_kind, &mut header_binary, &mut out);
	out
}

// ─── plain mode ─────────────────────────────────────────────────────────────

async fn walk_diff(lower: &Path, merged: &Path) -> IsoResult<Diff> {
	let lower = lower.to_path_buf();
	let merged = merged.to_path_buf();
	tokio::task::spawn_blocking(move || walk_diff_blocking(&lower, &merged))
		.await
		.map_err(|err| IsoError::other(format!("walk_diff join: {err}")))?
}

fn walk_diff_blocking(lower: &Path, merged: &Path) -> IsoResult<Diff> {
	let lower_index = index_tree(lower)?;
	let merged_index = index_tree(merged)?;

	let mut files: Vec<FileChange> = Vec::new();

	for (rel, m_meta) in &merged_index {
		match lower_index.get(rel) {
			None => files.push(plain_change(merged, rel, ChangeKind::Added, None)?),
			Some(l_meta) => {
				if metas_equal(l_meta, m_meta) {
					continue;
				}
				files.push(plain_change(merged, rel, ChangeKind::Modified, Some(lower))?);
			},
		}
	}
	for rel in lower_index.keys() {
		if !merged_index.contains_key(rel) {
			files.push(plain_change(lower, rel, ChangeKind::Removed, None)?);
		}
	}

	files.sort_by(|a, b| a.path.cmp(&b.path));
	Ok(Diff { files })
}

fn metas_equal(a: &Metadata, b: &Metadata) -> bool {
	if a.len() != b.len() {
		return false;
	}
	match (a.modified(), b.modified()) {
		(Ok(ma), Ok(mb)) => systime_eq(ma, mb),
		_ => false,
	}
}

fn systime_eq(a: SystemTime, b: SystemTime) -> bool {
	// Filesystems carry mtime at different resolutions (HFS+ seconds, APFS
	// nanos, FAT 2 seconds). Compare at second granularity so a metadata-
	// preserving copy that flushed through a coarse layer doesn't look
	// modified.
	let to_secs = |t: SystemTime| {
		t.duration_since(SystemTime::UNIX_EPOCH)
			.map_or(0, |d| d.as_secs())
	};
	to_secs(a) == to_secs(b)
}

fn index_tree(root: &Path) -> IsoResult<BTreeMap<PathBuf, Metadata>> {
	let mut out = BTreeMap::new();
	if !root.exists() {
		return Ok(out);
	}
	walk(root, root, &mut out)?;
	Ok(out)
}

fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Metadata>) -> IsoResult<()> {
	let entries = std::fs::read_dir(dir)
		.map_err(|err| IsoError::other(format!("read_dir {}: {err}", dir.display())))?;
	for entry in entries {
		let entry =
			entry.map_err(|err| IsoError::other(format!("dir entry in {}: {err}", dir.display())))?;
		let path = entry.path();
		let meta = entry
			.metadata()
			.map_err(|err| IsoError::other(format!("metadata {}: {err}", path.display())))?;
		if meta.is_symlink() {
			let rel = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
			out.insert(rel, meta);
			continue;
		}
		if meta.is_dir() {
			walk(root, &path, out)?;
			continue;
		}
		let rel = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
		out.insert(rel, meta);
	}
	Ok(())
}

/// Build a [`FileChange`] for an entry observed by [`walk_diff_blocking`].
///
/// `op == Modified` requires `peer_root = Some(lower)` so we can read the
/// counterpart; `Added`/`Removed` only need the side we already know about.
fn plain_change(
	side: &Path,
	rel: &Path,
	op: ChangeKind,
	peer_root: Option<&Path>,
) -> IsoResult<FileChange> {
	let full = side.join(rel);
	let primary = std::fs::read(&full)
		.map_err(|err| IsoError::other(format!("read {}: {err}", full.display())))?;
	if looks_binary(&primary) {
		return Ok(FileChange { path: rel.to_path_buf(), op, diff: None });
	}
	let (old_bytes, new_bytes) = match op {
		ChangeKind::Added => (Vec::new(), primary),
		ChangeKind::Removed => (primary, Vec::new()),
		ChangeKind::Modified => {
			let peer = peer_root.ok_or_else(|| {
				IsoError::other(format!(
					"modified change for {} requires a peer root to diff against",
					rel.display()
				))
			})?;
			let peer_full = peer.join(rel);
			let peer_bytes = std::fs::read(&peer_full)
				.map_err(|err| IsoError::other(format!("read {}: {err}", peer_full.display())))?;
			if looks_binary(&peer_bytes) {
				return Ok(FileChange { path: rel.to_path_buf(), op, diff: None });
			}
			(peer_bytes, primary)
		},
	};
	let (Ok(old_text), Ok(new_text)) =
		(std::str::from_utf8(&old_bytes), std::str::from_utf8(&new_bytes))
	else {
		return Ok(FileChange { path: rel.to_path_buf(), op, diff: None });
	};
	Ok(FileChange {
		path: rel.to_path_buf(),
		op,
		diff: Some(render_unified(rel, op, old_text, new_text)),
	})
}

fn render_unified(rel: &Path, op: ChangeKind, old: &str, new: &str) -> String {
	let rel_str = rel.to_string_lossy();
	let (from_label, to_label) = match op {
		ChangeKind::Added => (String::from("/dev/null"), format!("b/{rel_str}")),
		ChangeKind::Removed => (format!("a/{rel_str}"), String::from("/dev/null")),
		ChangeKind::Modified => (format!("a/{rel_str}"), format!("b/{rel_str}")),
	};
	use std::fmt::Write as _;
	let mut out = String::new();
	let _ = writeln!(out, "diff --git a/{rel_str} b/{rel_str}");
	match op {
		ChangeKind::Added => {
			let _ = writeln!(out, "new file mode 100644");
		},
		ChangeKind::Removed => {
			let _ = writeln!(out, "deleted file mode 100644");
		},
		ChangeKind::Modified => {},
	}
	// The body comes from the shared owner rather than from `similar` directly, so
	// this crate and the `diff` shell builtin cannot disagree about what a line is.
	// No ignore flags here: plain mode reports every difference it finds.
	let mut body = Vec::new();
	let diff = Unified::compute(old, new, UNIFIED_CONTEXT, Ignore::default());
	let _ = diff.write(&mut body, &from_label, &to_label);
	out.push_str(&String::from_utf8_lossy(&body));
	if !out.ends_with('\n') {
		out.push('\n');
	}
	out
}

#[cfg(test)]
mod tests {
	use veyyon_test_scratch::TempTree;

	use super::*;

	/// A scratch directory for one case, removed when that case ends.
	///
	/// It used to be a fixed name per tag with no cleanup at all, so every run
	/// left one directory per case behind and two runs in parallel shared a
	/// path.
	fn temp_root(tag: &str) -> TempTree {
		veyyon_test_scratch::scratch_dir(&format!("iso-diff-{tag}"))
	}

	#[test]
	fn modified_without_peer_root_is_an_error_not_a_panic() {
		let side = temp_root("no-peer");
		std::fs::write(side.join("file.txt"), "new contents\n").unwrap();

		let err = plain_change(&side, Path::new("file.txt"), ChangeKind::Modified, None)
			.expect_err("modified change without a peer root must fail");
		assert!(
			err.to_string().contains("requires a peer root"),
			"error should name the missing peer root, got: {err}"
		);

		std::fs::remove_dir_all(&side).unwrap();
	}

	#[test]
	fn modified_with_peer_root_diffs_both_sides() {
		let side = temp_root("upper");
		let peer = temp_root("lower");
		std::fs::write(side.join("file.txt"), "line one\nline two changed\n").unwrap();
		std::fs::write(peer.join("file.txt"), "line one\nline two\n").unwrap();

		let change =
			plain_change(&side, Path::new("file.txt"), ChangeKind::Modified, Some(&peer)).unwrap();
		assert_eq!(change.op, ChangeKind::Modified);
		assert_eq!(change.path, Path::new("file.txt"));
		// The WHOLE patch, not two `contains` probes. This test used to assert only
		// that the removed and added lines appeared somewhere in the text, which
		// passes for a patch with the wrong header, the wrong ranges, or a hunk split
		// in the wrong place, and did pass while the body drifted from the `diff`
		// builtin's.
		assert_eq!(
			change.diff.expect("text files must carry a unified diff"),
			"diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,2 @@\n \
			 line one\n-line two\n+line two changed\n"
		);

		std::fs::remove_dir_all(&side).unwrap();
		std::fs::remove_dir_all(&peer).unwrap();
	}
	/// Byte-exact pins on the patch text plain mode emits.
	///
	/// WHY THIS SUITE EXISTS. The unified body used to come from `similar`'s own
	/// formatter, called here and separately in the `diff` shell builtin, and
	/// the two were free to drift: the builtin's copy already differed on how a
	/// line is split, because `similar`'s tokenizer treats a lone `\r` as a
	/// line break and GNU diff does not. Both now call one owner, and these
	/// cases were written against the OLD formatter so the move is provably
	/// byte-identical.
	///
	/// The pins assert the WHOLE patch, header lines included, because the
	/// header is assembled here and the body is not, and a change that shifted
	/// work across that seam would otherwise pass.
	mod the_patch_text_is_pinned_byte_for_byte {
		use super::*;

		/// A modified file carries the `diff --git` line, no mode line, and a
		/// unified body labelled `a/` and `b/`.
		#[test]
		fn a_modified_file_gets_a_git_header_and_a_unified_body() {
			let patch = render_unified(
				Path::new("src/main.rs"),
				ChangeKind::Modified,
				"line one\nline two\n",
				"line one\nline two changed\n",
			);

			assert_eq!(
				patch,
				"diff --git a/src/main.rs b/src/main.rs\n--- a/src/main.rs\n+++ b/src/main.rs\n@@ \
				 -1,2 +1,2 @@\n line one\n-line two\n+line two changed\n"
			);
		}

		/// An added file gains a `new file mode` line and `/dev/null` on the
		/// left, and the left range is the empty `-0,0`.
		#[test]
		fn an_added_file_gets_a_mode_line_and_a_dev_null_label() {
			let patch = render_unified(Path::new("new.txt"), ChangeKind::Added, "", "fresh\n");

			assert_eq!(
				patch,
				"diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ \
				 b/new.txt\n@@ -0,0 +1 @@\n+fresh\n"
			);
		}

		/// A removed file is the mirror image: `deleted file mode` and
		/// `/dev/null` on the right.
		#[test]
		fn a_removed_file_gets_a_deleted_mode_line() {
			let patch = render_unified(Path::new("gone.txt"), ChangeKind::Removed, "was here\n", "");

			assert_eq!(
				patch,
				"diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ \
				 /dev/null\n@@ -1 +0,0 @@\n-was here\n"
			);
		}

		/// A missing final newline carries the marker, and the patch still ends
		/// in a newline because the header assembly guarantees it.
		#[test]
		fn a_missing_final_newline_is_marked() {
			let patch = render_unified(Path::new("t"), ChangeKind::Modified, "a\nb", "a\nc\n");

			assert_eq!(
				patch,
				"diff --git a/t b/t\n--- a/t\n+++ b/t\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end \
				 of file\n+c\n"
			);
			assert!(patch.ends_with('\n'));
		}

		/// TWO distant changes make two hunks under ONE pair of `---`/`+++`
		/// lines, which is the case that catches a formatter emitting the
		/// header per hunk.
		#[test]
		fn two_distant_changes_make_two_hunks_under_one_header() {
			let old = (1..=20).fold(String::new(), |mut lines, i| {
				use std::fmt::Write as _;
				let _ = writeln!(lines, "l{i}");
				lines
			});
			let new = old.replace("l2\n", "L2\n").replace("l19\n", "L19\n");

			let patch = render_unified(Path::new("f"), ChangeKind::Modified, &old, &new);

			assert_eq!(
				patch,
				"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,5 +1,5 @@\n l1\n-l2\n+L2\n l3\n l4\n \
				 l5\n@@ -16,5 +16,5 @@\n l16\n l17\n l18\n-l19\n+L19\n l20\n"
			);
		}

		/// Identical text produces the header and NOTHING else, since a body with
		/// no hunks has no `---`/`+++` lines either.
		#[test]
		fn identical_text_produces_a_header_with_no_body() {
			let patch = render_unified(Path::new("same"), ChangeKind::Modified, "x\n", "x\n");

			assert_eq!(patch, "diff --git a/same b/same\n");
		}

		/// A path with a space is written as typed on both sides, because the
		/// header is assembled by interpolation and nothing quotes it.
		#[test]
		fn a_path_with_a_space_is_written_as_typed() {
			let patch = render_unified(Path::new("a b/c.txt"), ChangeKind::Modified, "1\n", "2\n");

			assert!(patch.starts_with("diff --git a/a b/c.txt b/a b/c.txt\n"), "{patch}");
		}

		/// A LONE `\r` is NOT a line break. GNU diff splits on `\n` and nothing
		/// else, so this is one line and the hunk reads `@@ -1 +1 @@`.
		/// `similar`'s tokenizer disagreed and produced a two-line hunk here,
		/// which is the concrete drift that having two formatters allowed.
		#[test]
		fn a_lone_carriage_return_does_not_start_a_line() {
			let patch = render_unified(Path::new("cr"), ChangeKind::Modified, "a\rb\n", "a\rc\n");

			assert_eq!(patch, "diff --git a/cr b/cr\n--- a/cr\n+++ b/cr\n@@ -1 +1 @@\n-a\rb\n+a\rc\n");
		}
	}

	/// The binary sniff, which decides whether a pair gets a patch at all.
	mod a_nul_within_the_window_means_binary {
		use super::*;

		/// The window is 4 KiB, MEASURED against GNU diff 3.10, which sniffs
		/// whatever its first read returned: a NUL at offset 4095 makes a file
		/// binary and one at 4096 does not. This crate used to use 8 KiB, and
		/// the `diff` builtin used to as well; both were wrong in the same
		/// direction and one of them was fixed without the other, which is what
		/// sharing the owner prevents.
		#[test]
		fn the_window_ends_at_four_kilobytes() {
			let mut just_inside = vec![b'x'; 4095];
			just_inside.push(0);
			just_inside.extend(std::iter::repeat_n(b'x', 10_000));
			assert!(looks_binary(&just_inside), "a NUL at 4095 is inside the window");

			let mut just_outside = vec![b'x'; 4096];
			just_outside.push(0);
			just_outside.extend(std::iter::repeat_n(b'x', 10_000));
			assert!(!looks_binary(&just_outside), "a NUL at 4096 is outside it");
		}

		/// The ordinary cases: a NUL near the start is binary and text is not.
		#[test]
		fn a_nul_near_the_start_is_binary_and_plain_text_is_not() {
			assert!(looks_binary(b"\0"));
			assert!(looks_binary(b"ELF\0\0\0"));
			assert!(!looks_binary(b"fn main() {}\n"));
			assert!(!looks_binary(b""), "an empty file is text");
		}

		/// A large NUL-free file is text however long it is, so the sniff reports
		/// on NULs and not on size.
		#[test]
		fn a_large_nul_free_file_is_text() {
			let text = "line\n".repeat(20_000);
			assert!(!looks_binary(text.as_bytes()));
		}
	}
}
