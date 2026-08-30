//! The walk depth bound must never be shallower than something the pattern
//! matches.
//!
//! WHAT THE BOUND IS FOR. A walk-relative glob compiles with
//! `literal_separator(true)`, so `*` and `?` cannot cross a `/`. A pattern with
//! N segments can then only match entries N components deep,
//! and `walk_depth_bound` tells the walker to stop there. That is what keeps
//! `dir/*.json` from descending through an entire subtree it can never match
//! into.
//!
//! WHY A WRONG BOUND IS THE WORST KIND OF BUG HERE. The walker prunes at the
//! bound, so a bound that is too shallow means directories are never visited
//! and their matches are never reported. Nothing errors, nothing is logged, and
//! the caller cannot tell a search that found three matches from one that found
//! three of five. It is a silent recall loss, and it is invisible in exactly
//! the case that matters: a large tree where nobody counts the results by hand.
//!
//! THE BUG. `literal_separator` governs `*` and `?`. It does NOT govern a
//! character class, which matches whatever it lists, `/` included. `[,-[]`
//! spans 0x2C..=0x5B and `/` is 0x2F, so `"*?[?!*?[?!,-[]?*"` matches
//! `"b/~0ba"` two components deep while its segment count says one.
//! Found by `fuzz/fuzz_targets/glob_patterns.rs`, whose property is exactly the
//! one this file states: whatever the pattern matches, the walk must be able to
//! reach.
//!
//! THE RULE NOW. A pattern whose bracket class can match `/` is unbounded.
//! Ambiguity answers "can", because that answer only ever removes an
//! optimization while the other one loses results.

use veyyon_glob::{compile_glob, walk_depth_bound};

/// The bound as the walker uses it, against what the compiled pattern really
/// matches.
fn assert_bound_reaches(pattern: &str, path: &str) {
	let compiled = compile_glob(pattern, false).expect("the pattern under test must compile");
	assert!(compiled.is_match(path), "sanity: {pattern:?} is supposed to match {path:?}");

	let bound = walk_depth_bound(pattern);
	if bound == usize::MAX {
		return;
	}
	let depth = path.split('/').filter(|seg| !seg.is_empty()).count().max(1);
	assert!(
		depth <= bound,
		"{pattern:?} matches {path:?} at depth {depth} but bounds the walk at {bound}, so the \
		 walker would never reach it",
	);
}

mod a_class_that_can_match_a_separator {
	use super::*;

	/// THE regression, as the fuzzer reduced it.
	#[test]
	fn the_fuzzers_pattern_is_unbounded() {
		assert_eq!(walk_depth_bound("*?[?!*?[?!,-[]?*"), usize::MAX);
		assert_bound_reaches("*?[?!*?[?!,-[]?*", "b/~0ba");
	}

	/// A range that straddles `/` is the general form of it.
	///
	/// `.` is 0x2E and `0` is 0x30, so `[.-0]` contains `/` without naming it,
	/// which is why checking for a literal `/` in the class is not enough.
	#[test]
	fn a_range_that_straddles_the_separator_is_unbounded() {
		assert_eq!(walk_depth_bound("a[.-0]b"), usize::MAX);
		// `[!-9]` reads as a NEGATED class holding `-` and `9`, not as a range from
		// `!`, because a leading `!` is the negation marker. Either reading is
		// unbounded, and the test says which one the code takes so a future change to
		// the parse is a visible decision.
		assert_eq!(walk_depth_bound("a[!-9]b"), usize::MAX);
	}

	/// A class that names the separator outright.
	#[test]
	fn a_class_listing_the_separator_is_unbounded() {
		assert_eq!(walk_depth_bound("a[/]b"), usize::MAX);
		assert_eq!(walk_depth_bound("a[xy/z]b"), usize::MAX);
	}

	/// A negated class matches everything it does not list, which includes `/`.
	///
	/// Reasoning about the complement would mean deciding whether `/` is among
	/// the excluded characters, and nothing writes `[^/]` by accident. Treating
	/// every negation as unbounded costs one optimization and cannot lose a
	/// match.
	#[test]
	fn a_negated_class_is_unbounded() {
		assert_eq!(walk_depth_bound("a[!xyz]b"), usize::MAX);
		assert_eq!(walk_depth_bound("a[^xyz]b"), usize::MAX);
	}

	/// An unterminated class is not understood, so it is not bounded.
	#[test]
	fn an_unterminated_class_is_unbounded() {
		assert_eq!(walk_depth_bound("a[xyz"), usize::MAX);
		assert_eq!(walk_depth_bound("src/[0-9"), usize::MAX);
	}

	/// An escaped separator inside a class still matches a separator.
	#[test]
	fn an_escaped_separator_inside_a_class_is_unbounded() {
		assert_eq!(walk_depth_bound("a[x\\/y]b"), usize::MAX);
	}
}

mod a_class_that_cannot {
	use super::*;

	/// The common cases keep their bound, which is the whole point of having
	/// one.
	///
	/// If every class disabled the bound, `src/[0-9]*.log` would walk an entire
	/// tree again and the timeouts the bound was written for would come back.
	#[test]
	fn an_ordinary_class_keeps_its_segment_count() {
		assert_eq!(walk_depth_bound("[0-9].ts"), 1);
		assert_eq!(walk_depth_bound("src/[0-9]*.log"), 2);
		assert_eq!(walk_depth_bound("a/b/[abc]d/e.rs"), 4);
	}

	/// A range entirely above or below `/` is fine.
	#[test]
	fn a_range_that_misses_the_separator_keeps_its_bound() {
		assert_eq!(walk_depth_bound("x[0-9]y"), 1);
		assert_eq!(walk_depth_bound("x[a-z]y"), 1);
		// A range that stops one byte short of `/`: `#` is 0x23 and `.` is 0x2E.
		assert_eq!(walk_depth_bound("x[#-.]y"), 1);
		// And one that starts one byte past it: `0` is 0x30.
		assert_eq!(walk_depth_bound("x[0-;]y"), 1);
	}

	/// A literal `]` first in the class does not end it, and the rest is still
	/// read.
	#[test]
	fn a_leading_bracket_is_a_literal_and_the_class_still_ends() {
		assert_eq!(walk_depth_bound("x[]ab]y"), 1);
		assert_eq!(walk_depth_bound("x[]/]y"), usize::MAX);
	}

	/// A trailing `-` is a literal, not the start of a range.
	#[test]
	fn a_trailing_dash_is_a_literal() {
		assert_eq!(walk_depth_bound("x[ab-]y"), 1);
	}

	/// An escaped `[` is not a class at all.
	#[test]
	fn an_escaped_bracket_opens_nothing() {
		assert_eq!(walk_depth_bound("a\\[bc"), 1);
		assert_eq!(walk_depth_bound("src/a\\[b/c.ts"), 3);
	}
}

mod the_rest_of_the_bound_is_unchanged {
	use super::*;

	/// `**` and `{...}` still disable it, for the reasons they always did.
	#[test]
	fn globstar_and_alternation_stay_unbounded() {
		assert_eq!(walk_depth_bound("**/*.ts"), usize::MAX);
		assert_eq!(walk_depth_bound("src/**"), usize::MAX);
		assert_eq!(walk_depth_bound("{a,b}/c.ts"), usize::MAX);
	}

	/// A plain pattern is its segment count, never zero.
	#[test]
	fn a_plain_pattern_counts_its_segments() {
		assert_eq!(walk_depth_bound("*.ts"), 1);
		assert_eq!(walk_depth_bound("src/*.ts"), 2);
		assert_eq!(walk_depth_bound("/"), 1);
		assert_eq!(walk_depth_bound(""), 1);
	}

	/// And the bound holds for the patterns it is supposed to bound.
	#[test]
	fn a_bounded_pattern_reaches_everything_it_matches() {
		for (pattern, path) in
			[("*.ts", "a.ts"), ("src/*.ts", "src/a.ts"), ("src/[0-9]*.log", "src/1x.log")]
		{
			assert_bound_reaches(pattern, path);
		}
	}
}
