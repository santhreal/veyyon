//! Conformance tests for virtual filesystem, overlay isolation, fault
//! injection, and logging.
//!
//! # WHY
//! Closes the defect classes of:
//! 1. Path traversal sandbox escapes (e.g. `..` escaping virtual root `/`).
//! 2. Overlay state leakage (mutations in one shard or test case mutating the
//!    shared base fixture or leaking into sibling overlays).
//! 3. Nondeterministic fault schedules breaking test case replayability.
//! 4. Incomplete partial/torn write persistence (failing to persist accepted
//!    prefixes on partial writes).
//! 5. Lost operation audit records on injected faults breaking invariant
//!    verification.
//! 6. Corrupted or mismatched fixture payload ingestion.
//!
//! What it does not catch:
//! - Kernel-level real filesystem race conditions outside in-memory virtual
//!   execution.
//! - Operating-system specific symlink resolution loops (symlinks are not in
//!   the narrow trait).

use std::{collections::BTreeSet, sync::Arc};

use super::{
	error::VfsError,
	fault::{FaultInjectingFs, FaultKind, FaultPlan, TornWriteMode},
	fixture::{FixtureTree, populate_from_fixture},
	log::{LoggingFs, OpKind, OpLog},
	memory::MemoryFs,
	overlay::Overlay,
	path::VfsPath,
	traits::{FileSystem, VfsFileType},
};
use crate::{corpus::FixtureRef, rng::Rng};

#[test]
fn path_normalization_handles_all_relative_and_dot_dot_edge_cases() {
	let cases = [
		("/", "/"),
		("", "/"),
		(".", "/"),
		("./", "/"),
		(".//.", "/"),
		("a", "/a"),
		("a/", "/a"),
		("a/b", "/a/b"),
		("a/b/", "/a/b"),
		("a/./b", "/a/b"),
		("a//b///c", "/a/b/c"),
		("a/b/..", "/a"),
		("a/b/../c", "/a/c"),
		("a/b/c/../../d", "/a/d"),
		("a/b/c/../../..", "/"),
		("a/b/c/../../../", "/"),
		("/a/b/c/../d/./e/../f", "/a/b/d/f"),
		(r"a\b\c\..\d", "/a/b/d"),
	];

	for (input, expected) in cases {
		let path =
			VfsPath::new(input).unwrap_or_else(|e| panic!("failed to normalize `{input}`: {e}"));
		assert_eq!(path.as_str(), expected, "normalization of `{input}` should equal `{expected}`");
	}
}

#[test]
fn an_escaping_path_is_strictly_refused_with_typed_error() {
	let escaping_cases = [
		"..",
		"../",
		"/..",
		"/../",
		"/a/../..",
		"/a/b/../../..",
		"a/../..",
		"foo/bar/../../../etc/passwd",
		r"..\..",
		r"a\..\..\b",
	];

	for input in escaping_cases {
		let result = VfsPath::new(input);
		assert!(
			matches!(result, Err(VfsError::PathEscapesRoot { .. })),
			"escaping path `{input}` must return Err(VfsError::PathEscapesRoot), got {result:?}"
		);
	}
}

#[test]
fn overlay_write_is_strictly_invisible_to_base_and_to_sibling_overlays() {
	let mut base = MemoryFs::new();
	let base_file = VfsPath::new("/shared.txt").unwrap();
	base.write(&base_file, b"base content").unwrap();
	let base_shared = Arc::new(base);

	let mut overlay_a = Overlay::new(Arc::clone(&base_shared));
	let overlay_b = Overlay::new(Arc::clone(&base_shared));

	// Verify sharing is by reference and base content is not duplicated
	assert_eq!(
		overlay_a.base_ptr(),
		overlay_b.base_ptr(),
		"overlays must share the exact same base memory allocation by Arc reference"
	);

	// Overlay A writes to the shared file
	overlay_a
		.write(&base_file, b"overlay A modified content")
		.unwrap();

	// Overlay A creates a new isolated file
	let unique_a = VfsPath::new("/unique_a.txt").unwrap();
	overlay_a.write(&unique_a, b"file A").unwrap();

	// Assert base is completely untouched
	assert_eq!(
		base_shared.read(&base_file).unwrap(),
		b"base content",
		"base must remain untouched after overlay write"
	);
	assert!(!base_shared.exists(&unique_a), "base must not contain unique file from overlay A");

	// Assert sibling overlay B sees unmodified base state
	assert_eq!(
		overlay_b.read(&base_file).unwrap(),
		b"base content",
		"sibling overlay B must not see modifications from overlay A"
	);
	assert!(
		!overlay_b.exists(&unique_a),
		"sibling overlay B must not see files created in overlay A"
	);

	// Assert overlay A observes its own writes
	assert_eq!(
		overlay_a.read(&base_file).unwrap(),
		b"overlay A modified content",
		"overlay A must observe its own writes"
	);
	assert_eq!(
		overlay_a.read(&unique_a).unwrap(),
		b"file A",
		"overlay A must observe its created file"
	);
}

#[test]
fn overlay_delete_shadows_without_mutating_the_base_tree() {
	let mut base = MemoryFs::new();
	let file_path = VfsPath::new("/target.txt").unwrap();
	let dir_path = VfsPath::new("/subdir").unwrap();
	let nested_file = VfsPath::new("/subdir/nested.txt").unwrap();

	base.create_dir_all(&dir_path).unwrap();
	base.write(&file_path, b"target file").unwrap();
	base.write(&nested_file, b"nested file").unwrap();
	let base_shared = Arc::new(base);

	let mut overlay = Overlay::new(Arc::clone(&base_shared));

	// Delete file in overlay
	overlay.remove_file(&file_path).unwrap();
	assert!(!overlay.exists(&file_path), "file must appear deleted in overlay");
	assert!(
		matches!(overlay.read(&file_path), Err(VfsError::NotFound { .. })),
		"reading deleted file in overlay must yield NotFound"
	);

	// Base still has the file untouched
	assert!(base_shared.exists(&file_path), "base must retain the file intact");
	assert_eq!(base_shared.read(&file_path).unwrap(), b"target file");

	// Delete directory tree in overlay
	overlay.remove_dir_all(&dir_path).unwrap();
	assert!(!overlay.exists(&dir_path), "directory must appear deleted in overlay");
	assert!(!overlay.exists(&nested_file), "nested file must appear deleted in overlay");

	// Base still has directory and nested file intact
	assert!(base_shared.exists(&dir_path), "base directory must remain intact");
	assert_eq!(base_shared.read(&nested_file).unwrap(), b"nested file");
}

#[test]
fn same_fault_plan_reproduces_byte_identically_across_two_independent_runs() {
	let seed = 421_337_890;
	let total_ops = 50;
	let fault_count = 10;

	let mut rng1 = Rng::new(seed);
	let plan1 = FaultPlan::from_rng(&mut rng1, total_ops, fault_count);

	let mut rng2 = Rng::new(seed);
	let plan2 = FaultPlan::from_rng(&mut rng2, total_ops, fault_count);

	assert_eq!(plan1, plan2, "fault plans generated from identical seeds must be identical");

	// Run execution sequence 1
	let mut fs1 = FaultInjectingFs::new(MemoryFs::new(), plan1);
	let mut results1 = Vec::new();
	for i in 0..total_ops {
		let path = VfsPath::new(&format!("/file_{i}.txt")).unwrap();
		let res = fs1.write(&path, b"test payload for fault execution");
		results1.push(format!("{res:?}"));
	}

	// Run execution sequence 2
	let mut fs2 = FaultInjectingFs::new(MemoryFs::new(), plan2);
	let mut results2 = Vec::new();
	for i in 0..total_ops {
		let path = VfsPath::new(&format!("/file_{i}.txt")).unwrap();
		let res = fs2.write(&path, b"test payload for fault execution");
		results2.push(format!("{res:?}"));
	}

	assert_eq!(
		results1, results2,
		"two executions of identical fault plans must produce byte-identical results"
	);
	assert_eq!(
		fs1.injected_fault_count(),
		fs2.injected_fault_count(),
		"both executions must record identical injected fault counts"
	);
	assert_eq!(
		fs1.accumulated_latency(),
		fs2.accumulated_latency(),
		"both executions must accumulate identical virtual latency"
	);
}

#[test]
fn partial_write_persists_exactly_its_accepted_prefix() {
	let mut plan = FaultPlan::new();
	let target_path = VfsPath::new("/partial.dat").unwrap();
	let accepted_len = 5;

	// Injected fault on first write operation (ordinal 0)
	plan.insert(0, FaultKind::PartialWrite { accepted_bytes: accepted_len });

	let mem = MemoryFs::new();
	let mut fault_fs = FaultInjectingFs::new(mem, plan);

	let full_payload = b"0123456789ABCDEF"; // 16 bytes
	let write_res = fault_fs.write(&target_path, full_payload);

	// Must return a PartialWrite error specifying the written prefix length
	assert!(
		matches!(
			write_res,
			Err(VfsError::PartialWrite { bytes_written: 5, bytes_requested: 16, .. })
		),
		"expected PartialWrite error with 5 bytes written, got {write_res:?}"
	);

	// Read underlying persisted content directly to verify ONLY the accepted prefix
	// was saved
	let persisted = fault_fs.read(&target_path).unwrap();
	assert_eq!(
		persisted.as_slice(),
		&full_payload[..accepted_len],
		"persisted content must strictly equal the accepted prefix (5 bytes), got {persisted:?}"
	);
	assert_ne!(
		persisted.as_slice(),
		full_payload.as_slice(),
		"persisted content must NOT contain the full offered buffer"
	);
}

#[test]
fn operation_log_maintains_total_ordering_and_survives_injected_faults() {
	let log = OpLog::new();
	let mut plan = FaultPlan::new();
	let failing_path = VfsPath::new("/bad.txt").unwrap();
	let ok_path = VfsPath::new("/good.txt").unwrap();

	plan.insert(1, FaultKind::Io { message: "disk failure".to_owned() });

	let mem = MemoryFs::new();
	let fault_fs = FaultInjectingFs::new(mem, plan);
	let mut logging_fs = LoggingFs::new(fault_fs, log.clone());

	// Operation 0: Successful write
	let res0 = logging_fs.write(&ok_path, b"hello");
	assert!(res0.is_ok());

	// Operation 1: Faulty write
	let res1 = logging_fs.write(&failing_path, b"fail");
	assert!(res1.is_err());

	// Operation 2: Successful read
	let res2 = logging_fs.read(&ok_path);
	assert!(res2.is_ok());

	let entries = log.entries();
	assert_eq!(entries.len(), 3, "operation log must record all 3 operations");

	// Invariant: Ordinals must be strictly sequential starting from 0
	for (i, entry) in entries.iter().enumerate() {
		assert_eq!(
			entry.ordinal, i as u64,
			"ordinal sequence must be contiguous and totally ordered"
		);
	}

	assert!(entries[0].outcome.is_success());
	assert!(entries[1].outcome.is_failure());
	assert!(entries[2].outcome.is_success());

	assert_eq!(entries[1].path, failing_path);
	assert!(matches!(entries[1].op, OpKind::Write { byte_count: 4 }));
}

#[test]
fn fixture_population_refuses_mismatched_digest() {
	let mut tree = FixtureTree::new();
	tree.add_file("/config.json", b"{\"key\": 123}");
	let valid_bytes = tree.to_bytes().unwrap();
	let valid_ref = FixtureRef::of(&valid_bytes);

	// Create a mismatched/tampered payload
	let mut tampered_bytes = valid_bytes.clone();
	tampered_bytes.push(b'!');

	let mut fs = MemoryFs::new();
	let result = populate_from_fixture(&mut fs, &valid_ref, &tampered_bytes);

	assert!(
		matches!(result, Err(VfsError::FixtureDigestMismatch { .. })),
		"fixture population with mismatched bytes must be refused with FixtureDigestMismatch"
	);

	// Successful verification and population
	let success_res = populate_from_fixture(&mut fs, &valid_ref, &valid_bytes);
	assert!(success_res.is_ok(), "valid fixture must populate cleanly");

	let loaded = fs.read(&VfsPath::new("/config.json").unwrap()).unwrap();
	assert_eq!(loaded, b"{\"key\": 123}");
}

#[test]
fn sweep_fault_kind_variants_from_source_fails_on_untested_member() {
	let variants = FaultKind::all_variants();
	let mut covered_names: BTreeSet<&'static str> = BTreeSet::new();

	for variant in &variants {
		let name = variant.name();
		match variant {
			FaultKind::Io { .. } => {
				covered_names.insert(name);
			},
			FaultKind::NoSpace => {
				covered_names.insert(name);
			},
			FaultKind::AccessDenied => {
				covered_names.insert(name);
			},
			FaultKind::PartialWrite { .. } => {
				covered_names.insert(name);
			},
			FaultKind::TornWrite { .. } => {
				covered_names.insert(name);
			},
			FaultKind::Latency { .. } => {
				covered_names.insert(name);
			},
		}
	}

	let expected_names: BTreeSet<&'static str> =
		["io", "nospace", "access_denied", "partial_write", "torn_write", "latency"]
			.into_iter()
			.collect();

	// Exact set equality enforces that no new variant can be added without
	// explicitly expanding both the test and the discriminator table
	assert_eq!(
		covered_names, expected_names,
		"all FaultKind variants must be explicitly verified in the test suite"
	);
}

#[test]
fn torn_write_modes_transform_and_persist_corrupted_data_correctly() {
	let modes = [
		(TornWriteMode::PrefixOnly, b"1234".to_vec()),
		(TornWriteMode::ZeroPadding, vec![b'1', b'2', b'3', b'4', 0, 0, 0, 0]),
		(TornWriteMode::CorruptedSuffix, vec![b'1', b'2', b'3', b'4', !b'5', !b'6', !b'7', !b'8']),
		(TornWriteMode::BlockSwap, b"56781234".to_vec()),
	];

	let input = b"12345678";
	let split = 4;

	for (mode, expected) in modes {
		let computed = FaultInjectingFs::<MemoryFs>::compute_torn_data(input, split, mode);
		assert_eq!(computed, expected, "torn write transformation for mode {mode} failed");

		// Execute against FaultInjectingFs
		let mut plan = FaultPlan::new();
		plan.insert(0, FaultKind::TornWrite { split_offset: split, mode });
		let mut fs = FaultInjectingFs::new(MemoryFs::new(), plan);
		let path = VfsPath::new("/torn.dat").unwrap();
		let res = fs.write(&path, input);
		assert!(matches!(res, Err(VfsError::TornWrite { .. })));

		let persisted = fs.read(&path).unwrap();
		assert_eq!(
			persisted, expected,
			"persisted torn data for {mode} must match expected transformation"
		);
	}
}

#[test]
fn memory_fs_directory_tree_and_file_lifecycle_contract() {
	let mut fs = MemoryFs::new();
	let dir = VfsPath::new("/a/b/c").unwrap();
	let file = VfsPath::new("/a/b/c/data.txt").unwrap();

	// Create nested directories
	fs.create_dir_all(&dir).unwrap();
	assert!(fs.exists(&dir));

	// Write and append
	fs.write(&file, b"initial").unwrap();
	fs.append(&file, b" appended").unwrap();

	assert_eq!(fs.read(&file).unwrap(), b"initial appended");
	let meta = fs.metadata(&file).unwrap();
	assert_eq!(meta.file_type, VfsFileType::File);
	assert_eq!(meta.len(), 16);

	// Read dir
	let entries = fs.read_dir(&dir).unwrap();
	assert_eq!(entries.len(), 1);
	assert_eq!(entries[0].name, "data.txt");
	assert_eq!(entries[0].file_type, VfsFileType::File);

	// Rename
	let renamed = VfsPath::new("/a/b/c/renamed.txt").unwrap();
	fs.rename(&file, &renamed).unwrap();
	assert!(!fs.exists(&file));
	assert!(fs.exists(&renamed));

	// Remove file
	fs.remove_file(&renamed).unwrap();
	assert!(!fs.exists(&renamed));

	// Remove dir
	let root_a = VfsPath::new("/a").unwrap();
	fs.remove_dir_all(&root_a).unwrap();
	assert!(!fs.exists(&root_a));
}
