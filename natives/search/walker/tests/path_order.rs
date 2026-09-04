//! The walk-relative path order: `compare_depth_first_paths`,
//! `is_relative_ancestor`, and `sort_collected_depth_first`.
//!
//! WHY THIS SUITE EXISTS. `compare_depth_first_paths` was not a total order,
//! and `sort_collected_depth_first` hands it to `slice::sort_unstable_by`,
//! where the standard library is entitled to panic or return an arbitrary order
//! when the comparator is inconsistent. The old implementation used an ancestor
//! rule for paths related by prefix and whole-string byte order for everything
//! else, and those two disagree for any sibling whose name continues with a
//! byte below `/` (0x2F). That set is `space !"#$%&'()*+,-.`, so it includes
//! `.` and `-`, the two most common characters in real file names, and `src`,
//! `src/x`, `src-gen` was already a broken triple in any checkout.
//!
//! `fuzz/fuzz_targets/walker_path_order.rs` found it in ninety seconds and
//! reports the offending triple. This suite is the durable half of that
//! finding: the fuzzer explores, and these cases pin the specific orderings so
//! the bug cannot come back the next time someone reaches for
//! `left.cmp(right)`.
//!
//! Every case below asserts a concrete `Ordering` or a concrete sorted
//! sequence. None of them assert only that a call did not panic, because the
//! old code did not panic either.

use std::cmp::Ordering;

use veyyon_walker::{
	CollectedEntry, FileType, compare_depth_first_paths, is_relative_ancestor,
	sort_collected_depth_first,
};

/// Build a file entry at `path`. Only the path participates in ordering.
fn entry(path: &str) -> CollectedEntry {
	CollectedEntry {
		path:      path.to_string(),
		file_type: FileType::File,
		mtime:     None,
		size:      None,
	}
}

fn sorted(paths: &[&str]) -> Vec<String> {
	let mut entries: Vec<CollectedEntry> = paths.iter().map(|path| entry(path)).collect();
	sort_collected_depth_first(&mut entries);
	entries.into_iter().map(|entry| entry.path).collect()
}

/// Every ordered triple drawn from `paths` satisfies transitivity.
fn assert_transitive(paths: &[&str]) {
	for a in paths {
		for b in paths {
			if compare_depth_first_paths(a, b) != Ordering::Greater {
				continue;
			}
			for c in paths {
				if compare_depth_first_paths(b, c) != Ordering::Greater {
					continue;
				}
				assert_eq!(
					compare_depth_first_paths(a, c),
					Ordering::Greater,
					"{a:?} > {b:?} > {c:?}, but compare({a:?}, {c:?}) disagrees",
				);
			}
		}
	}
}

fn assert_antisymmetric(paths: &[&str]) {
	for a in paths {
		for b in paths {
			assert_eq!(
				compare_depth_first_paths(a, b),
				compare_depth_first_paths(b, a).reverse(),
				"compare({a:?}, {b:?}) is not the reverse of compare({b:?}, {a:?})",
			);
		}
	}
}

mod the_regression {
	use super::*;

	/// The exact input `walker_path_order` reported, kept verbatim.
	///
	/// The old comparator answered `Greater`, `Greater`, `Less` for these three
	/// pairs: `"."` is an ancestor of `"./aaaaaaaaa"` so it sorted after it,
	/// `"./aaaaaaaaa"` beat `"...."` on byte order because `/` (0x2F) is above
	/// `.` (0x2E), and yet `"."` sorted below `"...."`. Pinning all three pairs
	/// rather than the sorted result, because the sorted result of an
	/// inconsistent comparator is not stable enough to assert.
	#[test]
	fn the_fuzzer_reproducer_is_a_consistent_chain() {
		assert_eq!(compare_depth_first_paths(".", "./aaaaaaaaa"), Ordering::Greater);
		assert_eq!(compare_depth_first_paths("./aaaaaaaaa", "...."), Ordering::Less);
		assert_eq!(compare_depth_first_paths(".", "...."), Ordering::Less);

		assert_transitive(&["", ".", "....", "./aaaaaaaaa"]);
		assert_antisymmetric(&["", ".", "....", "./aaaaaaaaa"]);
	}

	/// The same bug in the shape it takes in a real checkout.
	///
	/// `src`, `src/x`, `src-gen`: a source directory, a file inside it, and a
	/// generated sibling. `-` is 0x2D, below `/`, so the old comparator put
	/// `src-gen` before `src/x` while also putting `src` after `src/x`, leaving
	/// no consistent position for `src`. Any repository with a hyphenated
	/// sibling directory hit this.
	#[test]
	fn a_hyphenated_sibling_directory_is_ordered_consistently() {
		assert_eq!(compare_depth_first_paths("src", "src/x"), Ordering::Greater);
		assert_eq!(compare_depth_first_paths("src/x", "src-gen"), Ordering::Less);
		assert_eq!(compare_depth_first_paths("src", "src-gen"), Ordering::Less);

		assert_eq!(sorted(&["src-gen", "src", "src/x"]), vec!["src/x", "src", "src-gen"]);
	}

	/// The dot-file form of the same triple: `a`, `a/b`, `a.txt`.
	#[test]
	fn a_dotted_sibling_file_is_ordered_consistently() {
		assert_eq!(compare_depth_first_paths("a", "a/b"), Ordering::Greater);
		assert_eq!(compare_depth_first_paths("a/b", "a.txt"), Ordering::Less);
		assert_eq!(compare_depth_first_paths("a", "a.txt"), Ordering::Less);

		assert_eq!(sorted(&["a.txt", "a", "a/b"]), vec!["a/b", "a", "a.txt"]);
	}

	/// A sibling continuing with a byte ABOVE `/` was always consistent, and
	/// must stay so. `0` is 0x30, so `a0` sorts above both `a` and `a/b` under
	/// either implementation; this is the control that shows the fix did not
	/// simply invert the failing direction.
	#[test]
	fn a_sibling_above_the_separator_keeps_its_order() {
		assert_eq!(compare_depth_first_paths("a", "a0"), Ordering::Less);
		assert_eq!(compare_depth_first_paths("a/b", "a0"), Ordering::Less);

		assert_eq!(sorted(&["a0", "a", "a/b"]), vec!["a/b", "a", "a0"]);
	}

	/// The whole byte range that used to break it, one triple per character.
	///
	/// Enumerated rather than sampled: the failure was a byte comparison against
	/// `/`, so the set of characters that trigger it is exactly the printable
	/// ASCII below 0x2F, and any of them reaching production is the same bug.
	#[test]
	fn every_character_below_the_separator_is_ordered_consistently() {
		for byte in b' '..b'/' {
			let sibling = format!("a{}", char::from(byte));
			let paths = ["a", "a/b", sibling.as_str()];

			assert_transitive(&paths);
			assert_antisymmetric(&paths);
			assert_eq!(
				sorted(&paths),
				vec!["a/b".to_string(), "a".to_string(), sibling.clone()],
				"contents before parent, then the sibling, failed for {sibling:?}",
			);
		}
	}
}

mod the_axioms {
	use super::*;

	/// A representative corpus: the root, dot forms, siblings on both sides of
	/// `/`, nested paths, repeated separators, a trailing separator, and
	/// multi-byte characters.
	const CORPUS: &[&str] = &[
		"", ".", "..", "....", "a", "a.txt", "a-b", "a0", "a b", "a/", "a/b", "a/b/c", "a//b", "ab",
		"ab/c", "z", "é", "é/x", "src", "src-gen", "src/x",
	];

	#[test]
	fn every_path_equals_itself() {
		for path in CORPUS {
			assert_eq!(
				compare_depth_first_paths(path, path),
				Ordering::Equal,
				"{path:?} does not compare equal to itself",
			);
		}
	}

	#[test]
	fn the_order_is_antisymmetric() {
		assert_antisymmetric(CORPUS);
	}

	#[test]
	fn the_order_is_transitive() {
		assert_transitive(CORPUS);
	}

	/// Distinct paths never compare `Equal`. A comparator that collapses two
	/// different paths lets an unstable sort drop or duplicate an entry's
	/// position, and the walker's callers deduplicate on nothing.
	#[test]
	fn distinct_paths_are_never_equal() {
		for a in CORPUS {
			for b in CORPUS {
				if a == b {
					continue;
				}
				assert_ne!(
					compare_depth_first_paths(a, b),
					Ordering::Equal,
					"{a:?} and {b:?} are different paths but compare equal",
				);
			}
		}
	}

	/// Sorting the corpus must not panic and must be a permutation of the input.
	/// `sort_unstable_by` on an inconsistent comparator is where the real damage
	/// would land, so the consumer is exercised, not just the comparison.
	#[test]
	fn sorting_the_corpus_preserves_every_entry() {
		let result = sorted(CORPUS);

		let mut expected: Vec<String> = CORPUS.iter().map(|path| (*path).to_string()).collect();
		expected.sort_unstable();
		let mut actual = result.clone();
		actual.sort_unstable();

		assert_eq!(actual, expected);
		assert_eq!(result.len(), CORPUS.len());
	}

	/// The contract the walker's callers rely on, checked on sorted output: no
	/// entry is followed by one of its own descendants.
	#[test]
	fn sorted_output_puts_contents_before_their_directory() {
		let result = sorted(CORPUS);

		for (earlier, later) in result.iter().zip(result.iter().skip(1)) {
			assert!(
				!is_relative_ancestor(earlier, later),
				"{earlier:?} is an ancestor of {later:?} but sorts before it",
			);
		}
	}
}

mod agreement_with_the_ancestor_rule {
	use super::*;

	/// Wherever `is_relative_ancestor` says yes, the comparator must say
	/// `Greater`. The two are separate functions and callers use both, so a fix
	/// to one that leaves the other behind produces a walk that is internally
	/// inconsistent without failing anything.
	#[test]
	fn an_ancestor_always_sorts_after_its_descendant() {
		let pairs = [
			("", "a"),
			("", "a/b"),
			("a", "a/b"),
			("a", "a/b/c"),
			("a/b", "a/b/c"),
			("a", "a//b"),
			("a/", "a//b"),
			("é", "é/x"),
		];

		for (ancestor, descendant) in pairs {
			assert!(
				is_relative_ancestor(ancestor, descendant),
				"{ancestor:?} should be an ancestor of {descendant:?}",
			);
			assert_eq!(
				compare_depth_first_paths(ancestor, descendant),
				Ordering::Greater,
				"{ancestor:?} is an ancestor of {descendant:?} but does not sort after it",
			);
		}
	}

	/// The negative half. These pairs look related by prefix but are not
	/// ancestors, and treating them as such is how a filter prunes a directory
	/// that merely shares a name prefix with a pruned one.
	#[test]
	fn a_shared_name_prefix_is_not_an_ancestor() {
		let pairs = [("a", "ab"), ("a", "a.txt"), ("src", "src-gen"), ("a/b", "a/bc")];

		for (left, right) in pairs {
			assert!(!is_relative_ancestor(left, right), "{left:?} is not an ancestor of {right:?}");
			assert!(!is_relative_ancestor(right, left), "{right:?} is not an ancestor of {left:?}");
			assert_eq!(
				compare_depth_first_paths(left, right),
				Ordering::Less,
				"{left:?} should sort before {right:?} on component order",
			);
		}
	}

	/// Nothing is its own ancestor, so no path can sort after itself.
	#[test]
	fn no_path_is_its_own_ancestor() {
		for path in ["", ".", "a", "a/b", "a//b", "é/x"] {
			assert!(!is_relative_ancestor(path, path), "{path:?} is its own ancestor");
		}
	}

	/// The root sorts last, because it is an ancestor of everything.
	#[test]
	fn the_root_sorts_after_every_entry() {
		for path in [".", "a", "a/b", "z", "é"] {
			assert_eq!(
				compare_depth_first_paths("", path),
				Ordering::Greater,
				"the root should sort after {path:?}",
			);
		}

		assert_eq!(sorted(&["", "b", "a/c", "a"]), vec!["a/c", "a", "b", ""]);
	}
}

mod realistic_listings {
	use super::*;

	/// A directory listing of the shape the walker actually produces, with the
	/// expected order written out in full.
	///
	/// This is the case a reader should look at first to understand the order:
	/// within a directory, entries sort by name; a subdirectory's contents come
	/// before the subdirectory; and everything under a directory precedes any
	/// sibling that sorts after it.
	#[test]
	fn a_checkout_shaped_listing_sorts_depth_first() {
		let listing = [
			"src",
			"src/lib.rs",
			"src/main.rs",
			"src-gen",
			"src-gen/out.rs",
			"README.md",
			"Cargo.toml",
		];

		assert_eq!(sorted(&listing), vec![
			"Cargo.toml",
			"README.md",
			"src/lib.rs",
			"src/main.rs",
			"src",
			"src-gen/out.rs",
			"src-gen",
		],);
	}

	/// Deeper nesting, to show the rule applies at every level rather than only
	/// at the top.
	#[test]
	fn nested_directories_each_follow_their_own_contents() {
		let listing = ["a", "a/b", "a/b/c", "a/b/c/d.txt", "a/z.txt"];

		assert_eq!(sorted(&listing), vec!["a/b/c/d.txt", "a/b/c", "a/b", "a/z.txt", "a"]);
	}

	/// Non-ASCII names sort by their UTF-8 bytes within a component, and the
	/// ancestor rule is unaffected by multi-byte characters.
	#[test]
	fn multi_byte_names_sort_within_their_component() {
		let listing = ["é", "é/x", "e", "e/x", "z"];

		assert_eq!(sorted(&listing), vec!["e/x", "e", "z", "é/x", "é"]);
	}
}
