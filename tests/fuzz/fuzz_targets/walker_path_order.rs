#![no_main]

//! Fuzzes the walk-relative path comparator in `veyyon-walker`.
//!
//! WHAT IS UNDER TEST. `compare_depth_first_paths` claims to be a total order
//! over normalized walk-relative paths, and `sort_collected_depth_first` hands
//! it straight to `slice::sort_unstable_by`. Rust requires a total order there;
//! supplying anything else is a documented way to get a panic or a nonsense
//! result out of the standard library, and the walker's callers assume a
//! directory's contents precede the directory itself.
//!
//! WHY A FUZZER AND NOT A TABLE OF CASES. The comparator mixes two orders: an
//! ancestor rule for paths related by prefix, and byte order for everything
//! else. Whether those agree depends on how the byte after a `/` sorts against
//! `/` itself, which is not something anyone reasons about correctly by
//! inspection, and there are 256 ways to get it wrong. The generator in
//! `veyyon_fuzz::PathLike` is built around exactly that alphabet so the search
//! is over the distinction that matters rather than over UTF-8 at large.

use libfuzzer_sys::fuzz_target;
use veyyon_fuzz::{
	MAX_ORDER_ITEMS, PathLike, find_antisymmetry_violation, find_irreflexive,
	find_transitivity_violation,
};
use veyyon_walker::{
	CollectedEntry, FileType, compare_depth_first_paths, is_relative_ancestor,
	sort_collected_depth_first,
};

fuzz_target!(|paths: Vec<PathLike>| {
	if paths.len() > MAX_ORDER_ITEMS {
		return;
	}
	let paths: Vec<String> = paths.into_iter().map(|path| path.0).collect();

	// The three total-order axioms, checked directly. Each reports the offending
	// elements rather than a bare boolean, because the reproducer is the finding.
	if let Some(index) = find_irreflexive(&paths, |a, b| compare_depth_first_paths(a, b)) {
		panic!("compare_depth_first_paths({:?}, itself) is not Equal", paths[index]);
	}

	if let Some((i, j)) = find_antisymmetry_violation(&paths, |a, b| compare_depth_first_paths(a, b))
	{
		panic!(
			"antisymmetry: compare({:?}, {:?}) = {:?} but compare({:?}, {:?}) = {:?}",
			paths[i],
			paths[j],
			compare_depth_first_paths(&paths[i], &paths[j]),
			paths[j],
			paths[i],
			compare_depth_first_paths(&paths[j], &paths[i]),
		);
	}

	if let Some((i, j, k)) =
		find_transitivity_violation(&paths, |a, b| compare_depth_first_paths(a, b))
	{
		panic!(
			"transitivity: {:?} > {:?} > {:?}, but compare({:?}, {:?}) = {:?}",
			paths[i],
			paths[j],
			paths[k],
			paths[i],
			paths[k],
			compare_depth_first_paths(&paths[i], &paths[k]),
		);
	}

	// The ancestor relation the comparator is built on must itself be coherent,
	// or the comparator inherits the incoherence. Nothing is its own ancestor,
	// and two distinct paths cannot each be an ancestor of the other.
	for a in &paths {
		assert!(!is_relative_ancestor(a, a), "{a:?} is its own ancestor");
		for b in &paths {
			assert!(
				!(is_relative_ancestor(a, b) && is_relative_ancestor(b, a)),
				"{a:?} and {b:?} are each other's ancestor",
			);
		}
	}

	// And the consumer, which is where a bad comparator actually reaches a user.
	// This is not redundant with the axioms above: it also covers the sort
	// itself, and it is the call that panics inside the standard library when the
	// comparator is inconsistent.
	let mut entries: Vec<CollectedEntry> = paths
		.iter()
		.map(|path| CollectedEntry {
			path:      path.clone(),
			file_type: FileType::File,
			mtime:     None,
			size:      None,
		})
		.collect();
	sort_collected_depth_first(&mut entries);

	// The contract the walker's callers rely on: after sorting, a directory's
	// contents come before the directory. Checked on the sorted output rather
	// than assumed from the comparator, so a sort that silently reorders past a
	// broken comparison is still caught.
	for (earlier, later) in entries.iter().zip(entries.iter().skip(1)) {
		assert!(
			!is_relative_ancestor(&earlier.path, &later.path),
			"sorted output puts the ancestor {:?} before its descendant {:?}",
			earlier.path,
			later.path,
		);
	}
});
