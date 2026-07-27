//! Every Rust test that makes a scratch directory must hand it to something
//! that deletes it.
//!
//! This is a scan of the workspace source rather than a behavioural test,
//! because the thing it guards against compiles perfectly: a test that joins a
//! name onto `env::temp_dir()`, creates it, and never removes it is valid Rust
//! and a passing test. Nothing fails, and the only symptom appears weeks later
//! on somebody's disk.
//!
//! That is not hypothetical. Three helpers in this workspace did exactly that,
//! at 90 call sites between them, so one `cargo test` left ninety directories
//! in `/tmp` permanently. It went unnoticed for so long because the fix for the
//! equivalent problem on the JavaScript side is a bun preload
//! (`packages/utils/test/helpers/temp-dir-janitor.ts`) that wraps `mkdtemp` and
//! `mkdir` and collects everything a test process made. No preload reaches a
//! Rust test binary, so a Rust test's scratch has to be owned by a value whose
//! `Drop` removes it, and there is nothing in the language or the build that
//! will remind anyone.
//!
//! The rule this file enforces: test code may only name a path under the system
//! temp directory inside `veyyon-test-scratch`, which owns the guard. Anywhere
//! else, the reviewer has no way to see whether the directory is ever removed.
//!
//! Each assertion is checked against a real path first, so a scan that stopped
//! finding files, or an owner that got renamed, fails here rather than silently
//! passing.

use std::{
	fs,
	path::{Path, PathBuf},
};

/// The workspace root, from this crate's own manifest directory.
fn workspace_root() -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR"))
		.parent()
		.and_then(Path::parent)
		.expect("the crate lives two levels under the workspace root")
		.to_path_buf()
}

/// This file's own path, excluded from the scan.
///
/// The rule is written as the string it looks for, so this file matches it.
/// Excluding it by name is the honest fix; spelling the pattern in pieces so it
/// does not match here would make the rule unreadable and is how a scanner
/// quietly stops working.
const SCANNER: &str = "crates/veyyon-uu-grep/tests/test_scratch_is_always_owned.rs";

/// The pattern a leak starts with: naming a path UNDER the system temp
/// directory.
///
/// `temp_dir()` on its own is not it. Handing the temp directory to something
/// as a working directory creates nothing and leaves nothing behind, and
/// several tests here do exactly that. It is the `.join(..)` that names a new
/// path, which the next line then creates and nobody deletes.
const TEMP_DIR_CALL: &str = "temp_dir().join(";

/// Where a source file's test code begins.
const TEST_MODULE_MARKER: &str = "#[cfg(test)]";

/// The part of `source` that is test code.
///
/// PRODUCTION use of the system temp directory is not what this file is about.
/// A cache under the temp directory, a scratch file for an atomic rename, a
/// spill path for a large result: those are deliberate, they belong to a
/// running program rather than to a test, and their lifetime is the program's
/// problem. Flagging them would make the rule noise, and a noisy rule gets an
/// allowlist entry per offender until it means nothing.
///
/// So an integration test under `tests/` is test code in its entirety, and a
/// `src` file counts only from its first `#[cfg(test)]` marker onward.
fn test_portion<'a>(rel: &str, source: &'a str) -> &'a str {
	if rel.contains("/tests/") {
		return source;
	}
	match source.find(TEST_MODULE_MARKER) {
		Some(at) => &source[at..],
		None => "",
	}
}

/// The one file allowed to name the system temp directory in test code.
///
/// It is a list rather than a constant so a second owner is a visible decision
/// instead of an edit nobody notices. There should not be one:
/// `veyyon-test-scratch` is a dev-dependency, so any crate in the workspace can
/// use it, and eight separate copies of this guard is what the workspace had
/// before.
const OWNERS: &[&str] = &["crates/veyyon-test-scratch/src/lib.rs"];

/// Every `.rs` file under `crates/`, skipping vendored trees and build output.
fn rust_sources(root: &Path) -> Vec<PathBuf> {
	let mut found = Vec::new();
	collect(&root.join("crates"), &mut found);
	found.sort();
	found
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
	let Ok(entries) = fs::read_dir(dir) else {
		return;
	};
	for entry in entries.flatten() {
		let path = entry.path();
		if path.is_dir() {
			let name = path
				.file_name()
				.and_then(|n| n.to_str())
				.unwrap_or_default();
			// `vendor` is somebody else's source and `target` is build output; neither is
			// ours to hold to this rule.
			if name == "vendor" || name == "target" {
				continue;
			}
			collect(&path, out);
		} else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
			out.push(path);
		}
	}
}

/// Path relative to the workspace root, with forward slashes, for readable
/// failures.
fn relative(root: &Path, path: &Path) -> String {
	path
		.strip_prefix(root)
		.unwrap_or(path)
		.to_string_lossy()
		.replace('\\', "/")
}

#[test]
fn the_scan_finds_real_files() {
	// Without this, every assertion below passes vacuously the day the walk breaks.
	let root = workspace_root();
	let sources = rust_sources(&root);

	assert!(
		sources.len() > 50,
		"the scan found only {} Rust sources under {}, so it is not reading the workspace",
		sources.len(),
		root.display()
	);
}

#[test]
fn every_owner_in_the_allowlist_exists() {
	// A renamed or deleted owner must fail here, not silently shrink the allowlist
	// to something that no longer describes the code.
	let root = workspace_root();

	for owner in OWNERS {
		assert!(
			root.join(owner).is_file(),
			"{owner} is in the allowlist but does not exist; update OWNERS when a file moves"
		);
	}
}

#[test]
fn every_owner_actually_defines_a_cleanup_guard() {
	// The allowlist means "this file owns removal". If an owner loses its `Drop`,
	// the permission it was granted no longer describes what it does.
	let root = workspace_root();

	for owner in OWNERS {
		let source = fs::read_to_string(root.join(owner)).expect("an owner should be readable");
		assert!(
			source.contains("impl Drop for"),
			"{owner} is allowed to create temp directories because it deletes them, but it defines \
			 no Drop impl"
		);
		assert!(
			source.contains("remove_dir_all"),
			"{owner} defines a Drop impl but never removes the directory it made"
		);
	}
}

#[test]
fn no_other_file_names_the_system_temp_directory() {
	// The rule itself. A new test helper that builds a scratch path by hand fails
	// here with the two ways out named, rather than leaking silently for months.
	let root = workspace_root();
	let mut offenders = Vec::new();

	for path in rust_sources(&root) {
		let rel = relative(&root, &path);
		if rel == SCANNER || OWNERS.contains(&rel.as_str()) {
			continue;
		}
		let Ok(source) = fs::read_to_string(&path) else {
			continue;
		};
		if test_portion(&rel, &source).contains(TEMP_DIR_CALL) {
			offenders.push(rel);
		}
	}

	assert!(
		offenders.is_empty(),
		"these files name the system temp directory without owning its removal: {offenders:?}\nUse \
		 `veyyon_test_scratch::scratch_dir(label)` so the directory is deleted when the\ntest that \
		 made it ends, including when that test fails."
	);
}
