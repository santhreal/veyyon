//! `veyyon_glob::CompiledGlob::is_match` against the glob engine it optimizes.
//!
//! WHY THIS SUITE EXISTS. `classify_fast_path` recognizes six pattern shapes
//! and answers them with string comparisons instead of running `globset`. That
//! is a large win on a walk of a hundred thousand files and it is only correct
//! if the two always agree. When they do not, the tool returns a shorter file
//! list, the agent believes it, and nothing anywhere reports that a fast path
//! answered instead of the engine. There is no error, no log line, and no
//! failing test: the only symptom is a file that should have been found and was
//! not.
//!
//! THE BUG THAT PROMPTED IT. `*..` normalizes to `**/*..`, which the classifier
//! read as "extension is `.`" and answered FALSE for `b..` while the engine
//! answered TRUE. The equivalence it assumed does not hold: a path's extension
//! is the text after its LAST dot, while the glob `*.X` means "anything, then a
//! literal `.X`". Those agree only when X contains no dot, so `**/*.b.rs` had
//! the same bug against `a.b.rs`. Found by `fuzz/fuzz_targets/glob_patterns.rs`
//! in under three minutes of the target existing.
//!
//! HOW THE CASES ARE WRITTEN. Every case asserts the fast path and the engine
//! agree AND pins the value they agree on. Agreement alone would pass if both
//! became wrong together, which is exactly what happens when somebody "fixes" a
//! disagreement by making the engine call go away.

use veyyon_glob::compile_glob;

/// Assert both answers agree, and that they agree on `expected`.
#[track_caller]
fn assert_matches(pattern: &str, recursive: bool, path: &str, expected: bool) {
	let compiled = compile_glob(pattern, recursive).expect("pattern compiles");
	let fast = compiled.is_match(path);
	let engine = compiled.is_match_via_engine(path);

	assert_eq!(
		fast, engine,
		"{pattern:?} answers {fast} for {path:?} but the engine answers {engine} ({compiled:?})",
	);
	assert_eq!(fast, expected, "{pattern:?} against {path:?} should be {expected}");
}

mod the_regression {
	use super::*;

	/// The exact reproducer the fuzzer printed.
	#[test]
	fn a_trailing_double_dot_pattern_agrees_with_the_engine() {
		assert_matches("*..", true, "b..", true);
	}

	/// The same shape one layer down, which the same root cause breaks.
	#[test]
	fn a_multi_dot_extension_agrees_with_the_engine() {
		assert_matches("*.b.rs", true, "a.b.rs", true);
		assert_matches("*.b.rs", true, "src/a.b.rs", true);
		assert_matches("*.b.rs", true, "a.c.rs", false);
	}

	/// And through the brace form, which reaches the same classifier by a
	/// different route.
	#[test]
	fn a_brace_group_containing_a_dot_agrees_with_the_engine() {
		assert_matches("*.{rs,b.rs}", true, "a.b.rs", true);
		assert_matches("*.{rs,b.rs}", true, "a.rs", true);
		assert_matches("*.{rs,b.rs}", true, "a.ts", false);
	}

	/// The traversal components. `..` normalized to `**/..` was classified as a
	/// literal basename and answered TRUE for `a/..` where the engine answers
	/// false, so a fast path claimed a match the matcher would not have made.
	/// Whatever the engine's reason for refusing them, a fast path that
	/// disagrees is wrong by definition.
	#[test]
	fn the_traversal_components_agree_with_the_engine() {
		for (pattern, path) in [
			("..", "a/.."),
			("..", ".."),
			("..", "x  /.."),
			(".", "a/."),
			(".", "."),
			("**/..", "a/b/.."),
			("**/.", "a/b/."),
		] {
			let compiled = compile_glob(pattern, true).expect("compiles");

			assert_eq!(
				compiled.is_match(path),
				compiled.is_match_via_engine(path),
				"{pattern:?} disagrees with the engine on {path:?} ({compiled:?})",
			);
		}
	}

	/// A pattern whose extension is nothing but dots. The fast path must not
	/// claim these.
	#[test]
	fn dot_only_extensions_agree_with_the_engine() {
		for (pattern, path, expected) in
			[("*..", "b..", true), ("*...", "b...", true), ("*..", "b.", false), ("*..", "b", false)]
		{
			assert_matches(pattern, true, path, expected);
		}
	}
}

mod the_fast_paths_still_apply {
	use super::*;

	/// The optimization has to still happen for the shapes it is for, or the fix
	/// was just "delete the fast path". These are the patterns the glob tool
	/// sees constantly.
	#[test]
	fn the_ordinary_shapes_still_take_a_fast_path() {
		for (pattern, recursive) in [
			("**", true),
			("**/*", true),
			("*", false),
			("*.rs", true),
			("*.rs", false),
			("*.{rs,ts}", true),
			("Cargo.toml", true),
		] {
			let compiled = compile_glob(pattern, recursive).expect("compiles");

			assert!(compiled.uses_fast_path(), "{pattern:?} should still answer without the engine");
		}
	}

	/// And a pattern with a dotted extension now goes to the engine, which is
	/// what makes it correct.
	#[test]
	fn a_dotted_extension_falls_through_to_the_engine() {
		for pattern in ["*..", "*.b.rs", "*.{rs,b.rs}", "..", ".", "**/..", "**/."] {
			let compiled = compile_glob(pattern, true).expect("compiles");

			assert!(
				!compiled.uses_fast_path(),
				"{pattern:?} cannot be answered by extension equality"
			);
		}
	}
}

mod agreement_across_the_shapes {
	use super::*;

	/// A grid over every fast path and a realistic set of paths. This is the
	/// property the fuzzer checks, enumerated so it runs on every `cargo test`
	/// rather than only when somebody remembers to fuzz.
	#[test]
	fn every_fast_path_agrees_with_the_engine_on_a_realistic_tree() {
		let paths = [
			"lib.rs",
			"src/lib.rs",
			"src/nested/lib.rs",
			"lib.ts",
			"Cargo.toml",
			"src/Cargo.toml",
			".gitignore",
			"a.b.rs",
			"b..",
			"b.",
			"noext",
			"src/noext",
			"dir/",
			"a/b/c/d.json",
		];
		let patterns = [
			("**", true),
			("**/*", true),
			("*", false),
			("*", true),
			("*.rs", true),
			("*.rs", false),
			("*.{rs,ts}", true),
			("*.{rs,ts}", false),
			("Cargo.toml", true),
			("Cargo.toml", false),
			("**/lib.rs", false),
			("src/*.rs", false),
			("*.b.rs", true),
			("*..", true),
			(".gitignore", true),
		];

		for (pattern, recursive) in patterns {
			let compiled = compile_glob(pattern, recursive).expect("compiles");
			for path in paths {
				assert_eq!(
					compiled.is_match(path),
					compiled.is_match_via_engine(path),
					"{pattern:?} (recursive: {recursive}) disagrees with the engine on {path:?} \
					 ({compiled:?})",
				);
			}
		}
	}

	/// A dotfile has no extension by the "text after the last dot" rule the fast
	/// path uses, and the engine agrees, but only because `*` can match the
	/// empty string. Pinned because it is the case where the two rules coincide
	/// for a non-obvious reason.
	#[test]
	fn a_dotfile_is_treated_the_same_by_both() {
		assert_matches("*.gitignore", true, ".gitignore", true);
		assert_matches("*.rs", true, ".rs", true);
	}
}
