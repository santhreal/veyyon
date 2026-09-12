//! Integration tests for the isolation backend lifecycle, candidate resolution,
//! error handling, failure teardown, and change diffing.

use std::{fs, path::Path};

use veyyon_iso::{BackendKind, ChangeKind, auto_order, backend, default_backend, resolve};
use veyyon_test_scratch::scratch_dir;

#[tokio::test]
async fn test_rcopy_lifecycle_and_diff() {
	let lower_scratch = scratch_dir("iso-rcopy-lower");
	let merged_scratch = scratch_dir("iso-rcopy-merged");

	let lower = lower_scratch.join("source");
	let merged = merged_scratch.join("workspace");
	fs::create_dir_all(&lower).expect("create lower directory");
	fs::write(lower.join("kept.txt"), "unchanged content\n").expect("write kept.txt");
	fs::write(lower.join("to_edit.txt"), "original line 1\noriginal line 2\n")
		.expect("write to_edit.txt");
	fs::write(lower.join("to_delete.txt"), "delete me\n").expect("write to_delete.txt");

	let backend = backend(BackendKind::Rcopy);
	assert_eq!(backend.kind(), BackendKind::Rcopy);

	let probe = backend.probe();
	assert!(probe.available, "Rcopy backend must always be available");
	assert!(probe.reason.is_none());

	// Start isolation
	backend.start(&lower, &merged).expect("start isolation");
	assert!(merged.exists(), "merged workspace must exist after start");
	assert_eq!(fs::read_to_string(merged.join("kept.txt")).unwrap(), "unchanged content\n");

	// Make changes in merged (with size difference for plain diff without git)
	fs::write(merged.join("to_edit.txt"), "original line 1\nmodified line 2 is longer\n")
		.expect("edit file");
	fs::remove_file(merged.join("to_delete.txt")).expect("delete file");
	fs::write(merged.join("created.txt"), "new file content\n").expect("create file");

	// Verify lower is completely untouched
	assert_eq!(
		fs::read_to_string(lower.join("to_edit.txt")).unwrap(),
		"original line 1\noriginal line 2\n"
	);
	assert!(lower.join("to_delete.txt").exists());
	assert!(!lower.join("created.txt").exists());

	// Capture diff
	let diff = backend.diff(&lower, &merged).await.expect("capture diff");
	assert!(!diff.is_empty());
	assert_eq!(diff.files.len(), 3);

	let added = diff
		.files
		.iter()
		.find(|f| f.path == Path::new("created.txt"))
		.expect("find created.txt");
	assert_eq!(added.op, ChangeKind::Added);
	assert!(
		added
			.diff
			.as_ref()
			.unwrap()
			.contains("new file mode 100644")
	);
	assert!(added.diff.as_ref().unwrap().contains("+new file content"));

	let modified = diff
		.files
		.iter()
		.find(|f| f.path == Path::new("to_edit.txt"))
		.expect("find to_edit.txt");
	assert_eq!(modified.op, ChangeKind::Modified);
	assert!(modified.diff.as_ref().unwrap().contains("-original line 2"));
	assert!(
		modified
			.diff
			.as_ref()
			.unwrap()
			.contains("+modified line 2 is longer")
	);

	let removed = diff
		.files
		.iter()
		.find(|f| f.path == Path::new("to_delete.txt"))
		.expect("find to_delete.txt");
	assert_eq!(removed.op, ChangeKind::Removed);
	assert!(
		removed
			.diff
			.as_ref()
			.unwrap()
			.contains("deleted file mode 100644")
	);
	assert!(removed.diff.as_ref().unwrap().contains("-delete me"));

	let unified = diff.unified_text();
	assert!(unified.contains("diff --git a/created.txt b/created.txt"));
	assert!(unified.contains("diff --git a/to_edit.txt b/to_edit.txt"));
	assert!(unified.contains("diff --git a/to_delete.txt b/to_delete.txt"));

	// Stop isolation and verify clean teardown
	backend.stop(&merged).expect("stop isolation");
	assert!(!merged.exists(), "merged workspace must be removed after stop");
}

#[test]
fn test_teardown_after_start_failure() {
	let scratch = scratch_dir("iso-fail-teardown");
	let nonexistent_lower = scratch.join("does_not_exist");
	let merged = scratch.join("merged_target");

	let backend = backend(BackendKind::Rcopy);
	let result = backend.start(&nonexistent_lower, &merged);
	assert!(result.is_err(), "start with nonexistent lower must fail");

	// Ensure no partial directory left behind
	assert!(!merged.exists(), "merged target must not exist after failed start");

	// Stopping after failed start must be safe and idempotent
	let stop_res = backend.stop(&merged);
	assert!(stop_res.is_ok(), "stopping after failed start must succeed");
}

#[test]
fn test_start_fails_when_lower_is_not_a_directory() {
	let scratch = scratch_dir("iso-not-dir");
	let file_lower = scratch.join("not_a_dir.txt");
	fs::write(&file_lower, "just a file\n").expect("write file");
	let merged = scratch.join("merged");

	let backend = backend(BackendKind::Rcopy);
	let result = backend.start(&file_lower, &merged);
	let err = result.expect_err("start with regular file must fail");
	assert!(
		err.message().contains("is not a directory"),
		"error message must state path is not a directory: {err}"
	);
}

#[test]
fn test_stop_is_idempotent_on_nonexistent_paths() {
	let scratch = scratch_dir("iso-idempotent-stop");
	let nonexistent = scratch.join("ghost_path");

	let backend = backend(BackendKind::Rcopy);
	assert!(backend.stop(&nonexistent).is_ok());
	assert!(backend.stop(&nonexistent).is_ok());
}

#[test]
fn test_backend_kind_and_probe_exhaustiveness() {
	let all_kinds = [
		BackendKind::Apfs,
		BackendKind::Btrfs,
		BackendKind::Zfs,
		BackendKind::LinuxReflink,
		BackendKind::Overlayfs,
		BackendKind::WindowsBlockClone,
		BackendKind::Projfs,
		BackendKind::Rcopy,
	];

	for kind in all_kinds {
		let b = backend(kind);
		assert_eq!(b.kind(), kind, "backend() must return struct with matching kind()");
		assert_eq!(
			BackendKind::from_str(kind.as_str()),
			Some(kind),
			"from_str round-trip for {}",
			kind.as_str()
		);
		let probe = b.probe();
		if !probe.available {
			assert!(
				probe.reason.is_some(),
				"unavailable probe for {kind:?} must provide a reason string"
			);
		}
	}
}

#[test]
fn test_candidate_resolution_and_fallback() {
	let order = auto_order();
	assert!(!order.is_empty(), "auto_order must not be empty");
	assert_eq!(
		*order.last().unwrap(),
		BackendKind::Rcopy,
		"Rcopy must be the final auto_order fallback"
	);

	// Preferred available backend (Rcopy): no fallback, so no reason, even when a
	// later automatic candidate probed unavailable on this host.
	let res = resolve(Some(BackendKind::Rcopy));
	assert_eq!(res.kind, BackendKind::Rcopy);
	assert!(!res.fell_back);
	assert!(res.reason.is_none(), "reason must be absent when no fallback happened");
	assert!(res.candidates.contains(&BackendKind::Rcopy));

	// Preferred unavailable backend on Linux (e.g. Apfs)
	#[cfg(not(target_os = "macos"))]
	{
		let res = resolve(Some(BackendKind::Apfs));
		assert_ne!(res.kind, BackendKind::Apfs);
		assert!(res.fell_back);
		assert!(res.reason.is_some());
	}

	// Automatic resolution without preference
	let auto_res = resolve(None);
	assert!(auto_res.candidates.contains(&BackendKind::Rcopy));
	assert!(backend(auto_res.kind).probe().available);

	// Default backend matches native kind
	assert_eq!(default_backend().kind(), BackendKind::native());
}

#[tokio::test]
async fn test_diff_binary_files() {
	let lower_scratch = scratch_dir("iso-bin-lower");
	let merged_scratch = scratch_dir("iso-bin-merged");

	let lower = lower_scratch.join("source");
	let merged = merged_scratch.join("workspace");
	fs::create_dir_all(&lower).expect("create lower");

	let bin_data_old = vec![0u8, 1, 2, 3, 255, 0, 128];
	let bin_data_new = vec![0u8, 1, 2, 99, 255, 0, 128, 42];
	fs::write(lower.join("data.bin"), &bin_data_old).expect("write binary old");

	let backend = backend(BackendKind::Rcopy);
	backend.start(&lower, &merged).expect("start");

	fs::write(merged.join("data.bin"), &bin_data_new).expect("write binary new");
	fs::write(merged.join("new_bin.dat"), vec![0u8, 255, 0]).expect("write new binary");

	let diff = backend.diff(&lower, &merged).await.expect("diff");
	backend.stop(&merged).expect("stop");

	let modified = diff
		.files
		.iter()
		.find(|f| f.path == Path::new("data.bin"))
		.expect("find data.bin");
	assert_eq!(modified.op, ChangeKind::Modified);
	assert!(modified.diff.is_none(), "binary diff must be None");

	let added = diff
		.files
		.iter()
		.find(|f| f.path == Path::new("new_bin.dat"))
		.expect("find new_bin.dat");
	assert_eq!(added.op, ChangeKind::Added);
	assert!(added.diff.is_none(), "binary diff must be None");
}

/// Stale destinations must not survive a block-clone start. Empty source files
/// exercise initialization without requiring filesystem extent-cloning support.
/// Nonempty-file extent cloning and `ProjFS` callbacks are outside this case.
#[cfg(windows)]
#[test]
fn block_clone_replaces_stale_destinations() {
	for stale_directory in [false, true] {
		let scratch = scratch_dir("iso-block-clone-stale");
		let lower = scratch.join("source");
		let merged = scratch.join("workspace");
		fs::create_dir(&lower).expect("create source");
		fs::write(lower.join("empty.txt"), []).expect("write empty source file");
		if stale_directory {
			fs::create_dir(&merged).expect("create stale workspace");
			fs::write(merged.join("stale.txt"), "old workspace").expect("write stale file");
		} else {
			fs::write(&merged, "stale destination file").expect("write stale destination");
		}

		let backend = backend(BackendKind::WindowsBlockClone);
		backend
			.start(&lower, &merged)
			.expect("replace stale destination");
		let mut names = fs::read_dir(&merged)
			.expect("read cloned directory")
			.map(|entry| entry.expect("read cloned entry").file_name())
			.collect::<Vec<_>>();
		names.sort();
		assert_eq!(names, [std::ffi::OsString::from("empty.txt")]);
		assert_eq!(fs::read(merged.join("empty.txt")).expect("read clone"), []);
		assert_eq!(fs::read(lower.join("empty.txt")).expect("read source"), []);
		backend.stop(&merged).expect("stop block clone");
		assert!(!merged.exists());
		assert!(lower.join("empty.txt").exists());
	}
}

/// A destination file is not an isolation tree and must not be deleted by start
/// or stop.
#[test]
fn test_rcopy_preserves_regular_file_destination() {
	let scratch = scratch_dir("iso-rcopy-file-destination");
	let lower = scratch.join("source");
	let merged = scratch.join("workspace");
	fs::create_dir_all(&lower).expect("create source");
	fs::write(&merged, "existing file content").expect("write destination");
	let backend = backend(BackendKind::Rcopy);
	for stopping in [false, true] {
		let result = if stopping {
			backend.stop(&merged)
		} else {
			backend.start(&lower, &merged)
		};
		let error = result.expect_err("a regular file is not a replaceable isolation directory");
		assert!(!error.is_unavailable());
		assert_eq!(fs::read_to_string(&merged).unwrap(), "existing file content");
	}
}

/// Binary and non-UTF-8 contents on either side of a link transition must not
/// produce text patches. Text controls prevent dropping all transitions. Git
/// mode is not covered here.
#[cfg(unix)]
#[tokio::test]
async fn plain_diff_classifies_binary_content_on_either_side_of_a_link() {
	for (contents, is_text) in [
		(b"\0binary".as_slice(), false),
		(b"\xffbinary".as_slice(), false),
		(b"text".as_slice(), true),
	] {
		for before_is_link in [false, true] {
			let scratch = scratch_dir("iso-link-binary-transition");
			let lower = scratch.join("source");
			let merged = scratch.join("workspace");
			for (root, is_link) in [(&lower, before_is_link), (&merged, !before_is_link)] {
				fs::create_dir_all(root).unwrap();
				let entry = root.join("entry");
				if is_link {
					std::os::unix::fs::symlink("missing-target", entry).unwrap();
				} else {
					fs::write(entry, contents).unwrap();
				}
			}
			let diff = backend(BackendKind::Rcopy)
				.diff(&lower, &merged)
				.await
				.unwrap();
			assert_eq!(diff.files.len(), 1);
			assert_eq!(diff.files[0].path, Path::new("entry"));
			assert_eq!(diff.files[0].op, ChangeKind::Modified);
			if is_text {
				let patch = diff.files[0]
					.diff
					.as_ref()
					.expect("text transition needs a patch");
				let (old, new) = if before_is_link {
					("missing-target", "text")
				} else {
					("text", "missing-target")
				};
				assert!(patch.contains(&format!("\n-{old}\n")), "{patch}");
				assert!(patch.contains(&format!("\n+{new}\n")), "{patch}");
			} else {
				assert_eq!(diff.files[0].diff, None, "binary content must never become a text patch");
			}
		}
	}
}

#[cfg(unix)]
#[tokio::test]
async fn test_walk_diff_handles_symlinks_and_broken_symlinks() {
	let lower_scratch = scratch_dir("iso-symlink-lower");
	let merged_scratch = scratch_dir("iso-symlink-merged");

	let lower = lower_scratch.join("source");
	let merged = merged_scratch.join("workspace");
	fs::create_dir_all(&lower).expect("create lower");
	fs::create_dir_all(&merged).expect("create merged");

	// Kept file
	fs::write(lower.join("kept.txt"), "kept").expect("write lower kept");
	fs::write(merged.join("kept.txt"), "kept").expect("write merged kept");

	// Kept symlink
	std::os::unix::fs::symlink("kept.txt", lower.join("kept_link.txt")).expect("create lower link");
	std::os::unix::fs::symlink("kept.txt", merged.join("kept_link.txt"))
		.expect("create merged link");

	// Broken symlink in lower and merged (pointing to nonexistent file)
	std::os::unix::fs::symlink("nonexistent", lower.join("broken_link.txt"))
		.expect("create lower broken link");
	std::os::unix::fs::symlink("nonexistent", merged.join("broken_link.txt"))
		.expect("create merged broken link");

	// Modified symlink target
	std::os::unix::fs::symlink("target_a", lower.join("mod_link.txt"))
		.expect("create lower mod link");
	std::os::unix::fs::symlink("target_b", merged.join("mod_link.txt"))
		.expect("create merged mod link");

	// Added symlink
	std::os::unix::fs::symlink("kept.txt", merged.join("added_link.txt"))
		.expect("create added link");

	// Removed symlink
	std::os::unix::fs::symlink("kept.txt", lower.join("removed_link.txt"))
		.expect("create removed link");

	let backend = backend(BackendKind::Rcopy);
	let diff = backend
		.diff(&lower, &merged)
		.await
		.expect("diff with symlinks must succeed");

	assert_eq!(diff.files.len(), 3);
	let mod_entry = diff
		.files
		.iter()
		.find(|f| f.path == Path::new("mod_link.txt"))
		.expect("find mod_link.txt");
	assert_eq!(mod_entry.op, ChangeKind::Modified);
	assert!(mod_entry.diff.as_ref().unwrap().contains("-target_a"));
	assert!(mod_entry.diff.as_ref().unwrap().contains("+target_b"));

	let added_entry = diff
		.files
		.iter()
		.find(|f| f.path == Path::new("added_link.txt"))
		.expect("find added_link.txt");
	assert_eq!(added_entry.op, ChangeKind::Added);

	let removed_entry = diff
		.files
		.iter()
		.find(|f| f.path == Path::new("removed_link.txt"))
		.expect("find removed_link.txt");
	assert_eq!(removed_entry.op, ChangeKind::Removed);
}

#[cfg(target_os = "linux")]
#[test]
fn test_linux_backends_lifecycle_and_fallback() {
	let scratch = scratch_dir("iso-linux-backends");
	let lower = scratch.join("source");
	let merged = scratch.join("workspace");
	fs::create_dir_all(&lower).expect("create source");
	fs::write(lower.join("file.txt"), "hello linux\n").expect("write file.txt");

	// Btrfs: on non-btrfs volume, start must fail with IsoError::Unavailable and
	// clean up
	let btrfs = backend(BackendKind::Btrfs);
	let btrfs_res = btrfs.start(&lower, &merged);
	if let Err(err) = btrfs_res {
		assert!(
			err.is_unavailable() || err.message().contains("btrfs"),
			"btrfs error should indicate unsupported/unavailable: {err}"
		);
		assert!(!merged.exists(), "merged path must not exist after btrfs start failure");
	} else {
		assert!(merged.exists());
		btrfs.stop(&merged).expect("stop btrfs");
		assert!(!merged.exists());
	}

	// Zfs: on non-zfs dataset, start must fail with IsoError::Unavailable and clean
	// up
	let zfs = backend(BackendKind::Zfs);
	let zfs_res = zfs.start(&lower, &merged);
	if let Err(err) = zfs_res {
		assert!(
			err.is_unavailable() || err.message().contains("ZFS"),
			"zfs error should indicate unsupported/unavailable: {err}"
		);
		assert!(!merged.exists(), "merged path must not exist after zfs start failure");
	} else {
		assert!(merged.exists());
		zfs.stop(&merged).expect("stop zfs");
		assert!(!merged.exists());
	}

	// LinuxReflink: FICLONE clone
	let reflink = backend(BackendKind::LinuxReflink);
	let reflink_res = reflink.start(&lower, &merged);
	if let Err(err) = reflink_res {
		assert!(
			err.is_unavailable() || err.message().contains("FICLONE"),
			"reflink error should indicate unsupported FICLONE: {err}"
		);
		assert!(!merged.exists(), "merged path must not exist after reflink start failure");
	} else {
		assert!(merged.exists());
		assert_eq!(fs::read_to_string(merged.join("file.txt")).unwrap(), "hello linux\n");
		reflink.stop(&merged).expect("stop reflink");
		assert!(!merged.exists());
	}

	// Overlayfs: kernel or fuse mount
	let overlay = backend(BackendKind::Overlayfs);
	let overlay_res = overlay.start(&lower, &merged);
	if let Err(err) = overlay_res {
		assert!(
			err.is_unavailable() || err.message().contains("overlay"),
			"overlayfs error should indicate unsupported: {err}"
		);
		assert!(!merged.exists(), "merged path must not exist after overlayfs start failure");
	} else {
		assert!(merged.exists());
		overlay.stop(&merged).expect("stop overlayfs");
		assert!(!merged.exists());
	}
}
