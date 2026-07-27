//! Scratch directories for Rust tests, removed when the test that made one
//! ends.
//!
//! # Why this crate exists
//!
//! Twenty-odd test modules across this workspace built a scratch directory by
//! joining a unique name onto [`std::env::temp_dir`], creating it, and never
//! removing it. In `veyyon-uu-grep` alone that pattern appeared at 80 call
//! sites, so a single `cargo test` left about ninety directories in the system
//! temp directory, permanently. On the machine where this was found, `/tmp` had
//! reached tens of thousands of stranded directories and the root filesystem
//! filled up.
//!
//! Nothing catches it. The code compiles, the tests pass, and the damage lands
//! on a developer's disk weeks later. CI never sees it, because a CI container
//! is thrown away after the run. The JavaScript half of this repository solved
//! the same problem with a bun preload that wraps `mkdtemp` and `mkdir` and
//! collects whatever a test process made
//! (`packages/utils/test/helpers/temp-dir-janitor.ts`), and none of that
//! machinery can reach a Rust test binary: there is no preload, no hook that
//! runs after every test, and no runtime to patch. So in Rust the cleanup has
//! to belong to a value, which is what [`TempTree`] is.
//!
//! # Why the guard rather than a line at the end of each test
//!
//! A test that ends with `fs::remove_dir_all(&dir)` cleans up only when it
//! PASSES. The first failing assertion returns early, so explicit cleanup is
//! skipped on exactly the runs that leave the most behind, and a flaky test
//! leaks every time it flakes. `Drop` runs while unwinding, so a guard cleans
//! up on both paths.
//!
//! # Using it
//!
//! Add it as a dev-dependency and replace the hand-built path:
//!
//! ```no_run
//! # fn example() {
//! use veyyon_test_scratch::scratch_dir;
//!
//! let tree = scratch_dir("my-crate-some-case");
//! std::fs::write(tree.join("a.txt"), "hit\n").expect("fixture");
//! // `tree` removes itself here.
//! # }
//! ```
//!
//! [`TempTree`] derefs to [`Path`] and implements [`AsRef<Path>`], so
//! `tree.join(..)`, `tree.display()`, `&tree` where a `&Path` is expected, and
//! the generic `impl AsRef<Path>` parameters most of the standard library takes
//! all work exactly as they did when the value was a [`PathBuf`].
//!
//! `crates/veyyon-uu-grep/tests/test_scratch_is_always_owned.rs` scans the
//! workspace and fails when a test names the system temp directory outside this
//! crate, so the pattern cannot come back one file at a time.

use std::{
	ops::Deref,
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
};

/// Handed out once per scratch directory, so no two names built in this process
/// can be equal however the clock behaves.
static NEXT_SCRATCH_ID: AtomicU64 = AtomicU64::new(0);

/// A scratch directory owned by the test that made it.
///
/// Dropping it removes the directory and everything under it.
pub struct TempTree(PathBuf);

impl TempTree {
	/// The directory's path, for the places that need to name the type.
	pub fn path(&self) -> &Path {
		&self.0
	}

	/// Give up ownership, returning the path and leaving the directory in place.
	///
	/// For the rare test that deliberately outlives its scratch, such as one
	/// asserting what a crashed process leaves behind. Naming it `leak` rather
	/// than `into_path` is the point: a reader should see that cleanup was
	/// given up on purpose.
	pub fn leak(self) -> PathBuf {
		let path = self.0.clone();
		std::mem::forget(self);
		path
	}
}

// `AsRef<Path>` as well as `Deref`, because deref coercion only fires where
// `&Path` is the expected type. The generic `impl AsRef<Path>` parameter that
// most path-taking standard library functions have does not coerce, and without
// this impl the guard would not be a drop-in for the `PathBuf` it replaces.
impl AsRef<Path> for TempTree {
	fn as_ref(&self) -> &Path {
		&self.0
	}
}

impl Deref for TempTree {
	type Target = Path;

	fn deref(&self) -> &Path {
		&self.0
	}
}

impl std::fmt::Debug for TempTree {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_tuple("TempTree").field(&self.0).finish()
	}
}

impl Drop for TempTree {
	fn drop(&mut self) {
		// Never panic here. A panic while unwinding from a failed assertion aborts the
		// process and replaces the assertion message, which is the one thing the person
		// reading the output needs.
		let _ = std::fs::remove_dir_all(&self.0);
	}
}

/// Create a scratch directory named after `label`, removed when the returned
/// guard drops.
///
/// The name carries three parts, and each answers a different question. The
/// process id separates two test binaries running at once. A counter, handed
/// out atomically, separates two threads of ONE binary: that is the part that
/// makes the name unique, because the clock does not. A nanosecond timestamp is
/// there so a directory stranded by a killed process can be placed in time.
///
/// The counter is not belt and braces. `SystemTime::now` is not required to
/// advance between two reads, two cores can read the realtime clock inside the
/// same tick, and this machine's tick is about 30 nanoseconds wide, so a burst
/// of tests starting together can build the same name twice. `create_dir_all`
/// treats an existing directory as success, so the second caller would have
/// been handed the FIRST caller's directory and told nothing: the two then see
/// each other's files, and a listing one of them asserts on holds entries it
/// never created. That is how `veyyon-walker`'s
/// `collect_entries_follow_links_always` came to fail with another test's
/// `real.txt` in its listing while passing when run on its own.
///
/// So the directory is created with [`std::fs::create_dir`], which fails when
/// the path already exists, and not with `create_dir_all`, which does not. A
/// collision is then a panic naming the path rather than two tests quietly
/// sharing a tree. Panics if the directory cannot be created, since a test with
/// nowhere to write has nothing left to assert.
pub fn scratch_dir(label: &str) -> TempTree {
	let root = std::env::temp_dir().join(format!(
		"veyyon-scratch-{label}-{}-{}-{}",
		std::process::id(),
		std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map_or(0, |elapsed| elapsed.as_nanos()),
		NEXT_SCRATCH_ID.fetch_add(1, Ordering::Relaxed)
	));
	std::fs::create_dir(&root).unwrap_or_else(|error| {
		panic!("scratch directory {} should be created: {error}", root.display())
	});
	TempTree(root)
}

#[cfg(test)]
mod tests {
	use super::*;

	/// The whole point: the directory is gone once the guard goes out of scope.
	#[test]
	fn dropping_the_guard_removes_the_directory() {
		let path = {
			let tree = scratch_dir("drop-removes");
			assert!(tree.exists(), "the directory should exist while the guard is alive");
			tree.path().to_path_buf()
		};

		assert!(!path.exists(), "the directory should be gone once the guard drops");
	}

	/// Contents are removed too. A guard that only removed an empty directory
	/// would silently do nothing for every real fixture.
	#[test]
	fn dropping_the_guard_removes_what_was_written_into_it() {
		let path = {
			let tree = scratch_dir("drop-removes-contents");
			std::fs::create_dir_all(tree.join("nested")).expect("nested directory");
			std::fs::write(tree.join("nested/a.txt"), "hit\n").expect("fixture file");
			tree.path().to_path_buf()
		};

		assert!(!path.exists(), "the tree and its contents should be gone");
	}

	/// Cleanup on the failing path is the reason this is a guard and not a final
	/// line.
	#[test]
	fn a_panicking_test_still_gets_its_directory_removed() {
		let path = std::sync::Arc::new(std::sync::Mutex::new(PathBuf::new()));
		let captured = std::sync::Arc::clone(&path);

		let result = std::panic::catch_unwind(move || {
			let tree = scratch_dir("drop-on-panic");
			*captured.lock().expect("the capture lock") = tree.path().to_path_buf();
			panic!("the assertion this test stands in for");
		});

		assert!(result.is_err(), "the closure should have panicked");
		let leaked = path.lock().expect("the capture lock").clone();
		assert!(!leaked.as_os_str().is_empty(), "the path should have been captured");
		assert!(!leaked.exists(), "unwinding should still have run Drop");
	}

	/// Two guards never collide, which is what lets tests run in parallel.
	#[test]
	fn two_scratch_directories_with_the_same_label_are_distinct() {
		let first = scratch_dir("same-label");
		let second = scratch_dir("same-label");

		assert_ne!(first.path(), second.path());
		assert!(first.exists() && second.exists());
	}

	/// Sixty-four threads asking for the same label at once get sixty-four
	/// directories, and each one is EMPTY.
	///
	/// This is the case the clock alone did not cover. The name used to be
	/// process id plus a nanosecond timestamp, and two cores can read the
	/// realtime clock inside one tick, so a burst of tests starting together
	/// could build the same name twice; `create_dir_all` then treated the
	/// existing directory as success and handed the second caller the first
	/// caller's tree. Distinct paths are half the proof. The other half is that
	/// each thread finds only its OWN marker file, because a shared tree shows
	/// two, and that is the symptom a test on a shared tree actually reports: a
	/// listing holding a file it never created.
	#[test]
	fn a_burst_of_guards_with_one_label_never_shares_a_tree() {
		let threads = 64;
		let started = std::sync::Barrier::new(threads);
		let paths = std::sync::Mutex::new(Vec::with_capacity(threads));

		std::thread::scope(|scope| {
			for index in 0..threads {
				let started = &started;
				let paths = &paths;
				scope.spawn(move || {
					// Every thread reads the clock as close to the same instant as
					// the machine allows, which is what makes the collision
					// reachable at all.
					started.wait();
					let tree = scratch_dir("burst-same-label");
					std::fs::write(tree.join(format!("marker-{index}")), "hit\n")
						.expect("the marker file should write");
					let mut names: Vec<String> = std::fs::read_dir(tree.path())
						.expect("the scratch directory should be readable")
						.map(|entry| {
							entry
								.expect("the entry should be readable")
								.file_name()
								.to_string_lossy()
								.into_owned()
						})
						.collect();
					names.sort();
					assert_eq!(
						names,
						vec![format!("marker-{index}")],
						"thread {index} should see only its own marker in {}",
						tree.path().display()
					);
					paths
						.lock()
						.expect("the path lock")
						.push(tree.path().to_path_buf());
				});
			}
		});

		let mut collected = paths.into_inner().expect("the path lock");
		assert_eq!(collected.len(), threads, "every thread should have reported a path");
		collected.sort();
		let unique = collected.len();
		collected.dedup();
		assert_eq!(collected.len(), unique, "no two threads should have been given one path");
	}

	/// The name carries a counter that rises, which is the part that does not
	/// depend on the clock.
	///
	/// Asserting the paths differ would pass on the old implementation whenever
	/// the clock happened to advance, which it usually does. This asserts the
	/// mechanism instead: the last segment of the name is a number handed out
	/// per call, so two names built inside one clock tick are still different.
	#[test]
	fn the_name_ends_in_a_counter_that_rises_per_call() {
		fn counter(tree: &TempTree) -> u64 {
			tree
				.path()
				.file_name()
				.and_then(|name| name.to_str())
				.and_then(|name| name.rsplit('-').next())
				.expect("the name should end in a counter")
				.parse()
				.expect("the counter should be a number")
		}

		let first = scratch_dir("rising-counter");
		let second = scratch_dir("rising-counter");
		let third = scratch_dir("rising-counter");

		assert!(
			counter(&first) < counter(&second) && counter(&second) < counter(&third),
			"the counter should rise: {} {} {}",
			counter(&first),
			counter(&second),
			counter(&third)
		);
	}

	/// A path that already exists is refused rather than shared.
	///
	/// `create_dir_all` reports success for a directory that is already there,
	/// which is exactly how the collision went unnoticed. `create_dir` does not,
	/// so this pins the semantics the function relies on: taking over an
	/// existing tree is an error, not a quiet success.
	#[test]
	fn creating_a_scratch_path_that_exists_is_an_error() {
		let tree = scratch_dir("already-there");

		let again = std::fs::create_dir(tree.path());

		assert!(again.is_err(), "creating an existing scratch path should fail");
		assert_eq!(
			again.expect_err("checked above").kind(),
			std::io::ErrorKind::AlreadyExists,
			"and it should fail because the path is already there"
		);
	}

	/// The label appears in the name, so a stranded directory from a killed
	/// process can still be traced back to the test that made it.
	#[test]
	fn the_directory_name_carries_the_label_and_the_process_id() {
		let tree = scratch_dir("named-for-tracing");
		let name = tree
			.path()
			.file_name()
			.and_then(|n| n.to_str())
			.expect("the directory should have a name")
			.to_string();

		assert!(name.starts_with("veyyon-scratch-named-for-tracing-"), "unexpected name: {name}");
		assert!(name.contains(&std::process::id().to_string()), "unexpected name: {name}");
	}

	/// The guard is a drop-in for the `PathBuf` it replaced, both ways.
	#[test]
	fn the_guard_works_where_a_path_is_expected() {
		let tree = scratch_dir("path-coercions");
		std::fs::write(tree.join("a.txt"), "hit\n").expect("fixture file");

		fn takes_ref(path: &Path) -> bool {
			path.is_dir()
		}
		fn takes_as_ref(path: impl AsRef<Path>) -> bool {
			path.as_ref().is_dir()
		}

		assert!(takes_ref(&tree), "deref coercion should reach &Path");
		assert!(takes_as_ref(&tree), "AsRef should reach the generic parameter");
		assert!(tree.join("a.txt").is_file(), "join should work through Deref");
	}

	/// `leak` is the deliberate escape hatch, and it must actually leave the
	/// tree.
	#[test]
	fn leak_gives_up_ownership_instead_of_removing_the_tree() {
		let path = {
			let tree = scratch_dir("leaked-on-purpose");
			std::fs::write(tree.join("a.txt"), "hit\n").expect("fixture file");
			tree.leak()
		};

		assert!(path.is_dir(), "a leaked tree should survive the guard going out of scope");
		std::fs::remove_dir_all(&path).expect("the test cleans up what it deliberately leaked");
	}
}
