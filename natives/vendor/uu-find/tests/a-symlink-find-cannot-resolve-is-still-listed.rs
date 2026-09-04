// WHY: `find -L` diagnosed a symlink it could not resolve and then dropped it
// from the listing. The walker reports resolving the link as an error and does
// not deliver the entry, and the error callback only wrote to stderr, so
// `find -L tree` printed every other entry, exited 1, and never named the
// broken link on stdout. GNU prints the link and the diagnostic both. The
// upstream test that would have caught it (`test_l_flag`) could not run: its
// fixtures were never vendored, and its expected string had been mangled by a
// reformat into `subdir/test\` + newline + `n`.
//
// CLASS: an entry the walker reports as an error is dropped rather than
// visited. The members are the ways a symlink fails to resolve — a missing
// target (ENOENT), a target under a non-directory (ENOTDIR), and a loop
// (ELOOP) — crossed with the three follow modes (`-P`, `-H`, `-L`), plus the
// non-symlink errors that must NOT gain a phantom entry. Every case below is
// pinned to what GNU findutils 4.9.0 does with the same tree, checked case by
// case rather than assumed:
//
//   -P tree            all three links listed, rc 0, no diagnostic
//   -L tree            broken and notdir listed; loop listed nowhere; rc 1
//   -L tree -type l    broken and notdir match; the entry carries the link's
//                      own metadata rather than a fabrication
//   -H broken          a broken link named as the root is listed, rc 0
//   -L loop            nothing listed, rc 1, and the walk terminates
//   -L unreadable-dir  the directory is listed once and no child is invented
//
// NOT COVERED: the text of the diagnostic, which is `Error: <path>: <errno>`
// here and `find: '<path>': <errno>` in GNU — a divergence this suite pins
// only loosely (it asserts the path is named) because closing it means
// rewriting every error site in the crate. Nor does it cover a link that
// resolves onto another filesystem under `-xdev`, or a link that is replaced
// between the walker's stat and this callback's `lstat`.

use std::{
	collections::HashMap,
	ffi::OsString,
	fs,
	io::Write,
	path::{Path, PathBuf},
	sync::{Arc, atomic::AtomicBool},
};

use parking_lot::Mutex;
use veyyon_uutils_ctx::ScopeIo;

fn run_in(cwd: &Path, args: &[&str]) -> (i32, Vec<String>, String) {
	let stdout_buf = Arc::new(Mutex::new(Vec::new()));
	let stderr_buf = Arc::new(Mutex::new(Vec::new()));

	#[derive(Clone)]
	struct SharedWriter {
		buf: Arc<Mutex<Vec<u8>>>,
	}

	impl Write for SharedWriter {
		fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
			self.buf.lock().write(buf)
		}

		fn flush(&mut self) -> std::io::Result<()> {
			self.buf.lock().flush()
		}
	}

	let io = ScopeIo {
		stdin:                 Box::new(std::io::empty()),
		stdin_fd:              None,
		stdin_is_search_input: false,
		stdout:                Box::new(SharedWriter { buf: stdout_buf.clone() }),
		stdout_is_terminal:    false,
		stderr:                Box::new(SharedWriter { buf: stderr_buf.clone() }),
		cwd:                   cwd.to_path_buf(),
		env:                   HashMap::new(),
		cancel:                Arc::new(AtomicBool::new(false)),
	};
	let argv: Vec<OsString> = std::iter::once(OsString::from("find"))
		.chain(args.iter().map(OsString::from))
		.collect();
	let code = veyyon_uutils_ctx::scope(io, || uu_find::run(argv));

	let mut lines: Vec<String> = String::from_utf8(stdout_buf.lock().clone())
		.unwrap()
		.lines()
		.map(str::to_string)
		.collect();
	lines.sort();
	(code, lines, String::from_utf8(stderr_buf.lock().clone()).unwrap())
}

/// A tree with one of every way a symlink fails to resolve, plus a directory
/// that cannot be opened at all.
fn tree() -> (tempfile::TempDir, PathBuf) {
	let dir = tempfile::tempdir().unwrap();
	let root = fs::canonicalize(dir.path()).unwrap();
	fs::create_dir_all(root.join("tree/sub")).unwrap();
	fs::write(root.join("tree/file"), b"").unwrap();
	fs::write(root.join("tree/sub/leaf"), b"").unwrap();
	std::os::unix::fs::symlink("missing", root.join("tree/broken")).unwrap();
	std::os::unix::fs::symlink("file/x", root.join("tree/notdir")).unwrap();
	std::os::unix::fs::symlink("loop", root.join("tree/loop")).unwrap();
	(dir, root)
}

#[test]
fn without_follow_every_link_is_listed_and_nothing_is_diagnosed() {
	let (_dir, root) = tree();

	let (code, lines, stderr) = run_in(&root, &["-P", "./tree"]);

	assert_eq!(stderr, "");
	assert_eq!(code, 0);
	assert_eq!(lines, [
		"./tree",
		"./tree/broken",
		"./tree/file",
		"./tree/loop",
		"./tree/notdir",
		"./tree/sub",
		"./tree/sub/leaf",
	]);
}

#[test]
fn a_dangling_link_is_listed_silently_and_is_not_a_fault() {
	let (_dir, root) = tree();
	fs::remove_file(root.join("tree/notdir")).unwrap();
	fs::remove_file(root.join("tree/loop")).unwrap();

	let (code, lines, stderr) = run_in(&root, &["-L", "./tree"]);

	// GNU says nothing about a link whose target simply does not exist, and
	// exits 0. Diagnosing it would make an ordinary dangling link fail a script
	// that checks the exit code.
	assert_eq!(lines, ["./tree", "./tree/broken", "./tree/file", "./tree/sub", "./tree/sub/leaf"]);
	assert_eq!(stderr, "");
	assert_eq!(code, 0);
}

#[test]
fn a_link_whose_target_sits_under_a_file_is_listed_and_diagnosed() {
	let (_dir, root) = tree();
	fs::remove_file(root.join("tree/broken")).unwrap();
	fs::remove_file(root.join("tree/loop")).unwrap();

	let (code, lines, stderr) = run_in(&root, &["-L", "./tree"]);

	assert_eq!(lines, ["./tree", "./tree/file", "./tree/notdir", "./tree/sub", "./tree/sub/leaf"]);
	assert_eq!(
		stderr
			.lines()
			.filter(|line| line.contains("./tree/notdir"))
			.count(),
		1
	);
	assert_eq!(code, 1);
}

#[test]
fn a_link_outside_the_depth_bounds_is_not_listed() {
	let (_dir, root) = tree();
	fs::remove_file(root.join("tree/notdir")).unwrap();
	fs::remove_file(root.join("tree/loop")).unwrap();

	// The visit happens outside the walker's own depth filter, so the bounds
	// have to be applied to it as well. GNU lists only the leaf here.
	let (code, lines, stderr) = run_in(&root, &["-L", "./tree", "-mindepth", "2"]);
	assert_eq!(lines, ["./tree/sub/leaf"]);
	assert_eq!(stderr, "");
	assert_eq!(code, 0);

	let (code, lines, _) = run_in(&root, &["-L", "./tree", "-maxdepth", "1"]);
	assert_eq!(lines, ["./tree", "./tree/broken", "./tree/file", "./tree/sub"]);
	assert_eq!(code, 0);
}

#[test]
fn following_lists_neither_more_nor_less_than_gnu_does() {
	let (_dir, root) = tree();

	let (code, lines, stderr) = run_in(&root, &["-L", "./tree"]);

	// GNU 4.9.0 on this tree: broken and notdir are listed, the loop is not,
	// and the loop and notdir each carry a diagnostic.
	assert_eq!(lines, [
		"./tree",
		"./tree/broken",
		"./tree/file",
		"./tree/notdir",
		"./tree/sub",
		"./tree/sub/leaf",
	]);
	assert!(stderr.contains("./tree/loop"), "stderr was {stderr:?}");
	assert_eq!(code, 1);
}

#[test]
fn a_loop_is_diagnosed_listed_nowhere_and_the_walk_ends() {
	let (_dir, root) = tree();
	fs::remove_file(root.join("tree/broken")).unwrap();
	fs::remove_file(root.join("tree/notdir")).unwrap();

	// The bound is the point: a loop must cost one diagnostic and end, not
	// recurse. Reaching the assertions at all is what proves termination.
	let (code, lines, stderr) = run_in(&root, &["-L", "./tree"]);

	assert_eq!(lines, ["./tree", "./tree/file", "./tree/sub", "./tree/sub/leaf"]);
	assert_eq!(
		stderr
			.lines()
			.filter(|line| line.contains("./tree/loop"))
			.count(),
		1
	);
	assert_eq!(code, 1);
}

#[test]
fn a_loop_named_as_the_root_lists_nothing() {
	let (_dir, root) = tree();

	let (code, lines, stderr) = run_in(&root, &["-L", "./tree/loop"]);

	assert_eq!(lines, Vec::<String>::new());
	assert!(stderr.contains("./tree/loop"), "stderr was {stderr:?}");
	assert_eq!(code, 1);
}

#[test]
fn an_unresolvable_link_is_still_a_link_to_type_l() {
	let (_dir, root) = tree();

	let (code, lines, stderr) = run_in(&root, &["-L", "./tree", "-type", "l"]);

	// The visited entry carries the link's own `lstat`, so `-type l` matches it;
	// a fabricated entry with no metadata would match nothing.
	assert_eq!(lines, ["./tree/broken", "./tree/notdir"]);
	assert!(stderr.contains("./tree/loop"), "stderr was {stderr:?}");
	assert_eq!(code, 1);
}

#[test]
fn a_broken_link_named_as_the_root_is_listed_under_every_follow_mode() {
	let (_dir, root) = tree();

	for flag in ["-P", "-H", "-L"] {
		let (code, lines, stderr) = run_in(&root, &[flag, "./tree/broken"]);

		assert_eq!(lines, ["./tree/broken"], "under {flag}");
		assert_eq!(stderr, "", "under {flag}");
		assert_eq!(code, 0, "under {flag}");
	}
}

#[test]
fn a_directory_that_cannot_be_opened_gains_no_phantom_entry() {
	let (_dir, root) = tree();
	fs::create_dir(root.join("tree/locked")).unwrap();
	fs::write(root.join("tree/locked/hidden"), b"").unwrap();
	fs::set_permissions(
		root.join("tree/locked"),
		std::os::unix::fs::PermissionsExt::from_mode(0o000),
	)
	.unwrap();

	let (code, lines, stderr) = run_in(&root, &["-L", "./tree"]);

	fs::set_permissions(
		root.join("tree/locked"),
		std::os::unix::fs::PermissionsExt::from_mode(0o755),
	)
	.unwrap();

	// The directory itself is listed exactly once, by the walker; the extra
	// visit is for symlinks only, so nothing under it is invented.
	assert_eq!(lines.iter().filter(|line| *line == "./tree/locked").count(), 1);
	assert!(!lines.iter().any(|line| line.starts_with("./tree/locked/")), "listing was {lines:?}");
	assert!(stderr.contains("./tree/locked"), "stderr was {stderr:?}");
	assert_eq!(code, 1);
}
