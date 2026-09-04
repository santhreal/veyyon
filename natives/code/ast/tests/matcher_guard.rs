//! `guard_matcher`, the boundary that stops an ast-grep-core panic from taking
//! the process with it.
//!
//! WHY A SECOND GUARD WHEN `compile_pattern` ALREADY PROBES. Because the probe
//! cannot be complete, and saying so cost a campaign to learn. The upstream
//! assert lives in `match_leaf_meta_var`, which is reached through
//! `match_node_impl`, which consults `should_skip_cand_for_metavar(candidate)`
//! and the parent's child iteration first. So whether a pattern trips it
//! depends on the CANDIDATE as well as on the pattern, and probing seven fixed
//! sources answers for seven sources. The eight-target fuzz campaign on
//! 2026-07-25 crashed inside `collect_matches` on a pattern `compile_pattern`
//! had passed.
//!
//! WHAT THE GUARD PROMISES. No matcher call this crate makes can abort the
//! process, whatever the pattern and whatever the source. The panic becomes an
//! `Err` naming what was being matched and quoting the matcher's own message.
//! That is a boundary and not a fallback (Law 10): nothing continues past it
//! and the caller cannot mistake it for a successful search that found nothing,
//! which is exactly what returning an empty `Vec` would have looked like.
//!
//! HOW THESE TESTS REACH THE ASSERT. They bypass `compile_pattern` and build
//! the `Pattern` through `ast_grep_core` directly, which is the only way to get
//! a pattern the probe would have refused into the matcher. That is deliberate:
//! testing the guard through the front door would only prove the probe works.

use ast_grep_core::matcher::Pattern;
use veyyon_ast::{
	SupportLang,
	ops::{collect_matches, compile_pattern},
};

/// The upstream check is a `debug_assert!`, so it exists in this build and not
/// in a release one. Tests that need the panic say so rather than being written
/// to pass either way, which would make them assert nothing.
#[cfg(debug_assertions)]
mod the_panic_becomes_an_error {
	use super::*;

	/// The core case: a pattern that ast-grep itself compiles, matched against a
	/// source, panics inside the matcher, and comes back as an error instead of
	/// taking the process down.
	#[test]
	fn a_bare_ellipsis_matched_directly_returns_an_error() {
		let pattern = Pattern::try_new("$$$", SupportLang::Html).expect("ast-grep compiles this");

		let error = collect_matches("\0\0", SupportLang::Html, &[pattern])
			.expect_err("the matcher panics on this and the guard must report it");

		assert!(
			error
				.to_string()
				.contains("Ellipsis should be matched in parent level"),
			"the error should quote the matcher's own message, got: {error}",
		);
	}

	/// The error says what the caller was doing, so a report names the operation
	/// rather than only the upstream assert.
	#[test]
	fn the_error_names_the_operation_that_failed() {
		let pattern = Pattern::try_new("$$$", SupportLang::Rust).expect("ast-grep compiles this");

		let error =
			collect_matches("fn f() {}", SupportLang::Rust, &[pattern]).expect_err("must fail");

		assert!(
			error.to_string().contains("searching for a pattern"),
			"the error should name the operation, got: {error}",
		);
	}

	/// And it tells the caller what to write instead, since the caller is often
	/// a model that will otherwise produce the same pattern again.
	#[test]
	fn the_error_suggests_a_working_pattern() {
		let pattern = Pattern::try_new("$$$", SupportLang::Rust).expect("ast-grep compiles this");

		let error =
			collect_matches("fn f() {}", SupportLang::Rust, &[pattern]).expect_err("must fail");

		assert!(
			error.to_string().contains("fn $NAME($$$)"),
			"the error should show a pattern that works, got: {error}",
		);
	}

	/// The guard does not swallow: an error is returned rather than an empty
	/// result set. This is the distinction that makes it a boundary and not a
	/// silent fallback, and it is asserted rather than assumed because the two
	/// are one `unwrap_or_default()` apart.
	#[test]
	fn a_guarded_panic_is_never_reported_as_zero_matches() {
		let pattern = Pattern::try_new("$$$", SupportLang::Html).expect("ast-grep compiles this");

		let result = collect_matches("\0\0", SupportLang::Html, &[pattern]);

		assert!(result.is_err(), "a panic must not come back as an empty match list");
	}

	/// A guarded panic on one pattern does not corrupt the process for the next
	/// call. `catch_unwind` leaves the tree-sitter state behind, so this checks
	/// the crate is still usable afterwards rather than assuming it.
	#[test]
	fn matching_still_works_after_a_guarded_panic() {
		let bad = Pattern::try_new("$$$", SupportLang::Rust).expect("compiles");
		let _ = collect_matches("fn f() {}", SupportLang::Rust, &[bad]);

		let good = compile_pattern(
			"let $X = $Y;",
			None,
			&ast_grep_core::MatchStrictness::Smart,
			SupportLang::Rust,
		)
		.expect("an ordinary pattern compiles");
		let matches = collect_matches("fn f() { let a = 1; }", SupportLang::Rust, &[good])
			.expect("matching must work after a guarded panic");

		assert_eq!(matches.len(), 1);
		assert_eq!(matches[0].text, "let a = 1;");
	}
}

mod ordinary_matching_is_unaffected {
	use super::*;

	/// The guard must not change what a working pattern returns. Asserted with
	/// the matched text rather than a count, so a guard that started returning
	/// the wrong nodes would fail here.
	#[test]
	fn a_working_pattern_returns_its_matches_unchanged() {
		let pattern = compile_pattern(
			"let $X = $Y;",
			None,
			&ast_grep_core::MatchStrictness::Smart,
			SupportLang::Rust,
		)
		.expect("compiles");

		let matches =
			collect_matches("fn f() { let a = 1; let b = 2; }", SupportLang::Rust, &[pattern])
				.expect("must not fail");

		assert_eq!(matches.len(), 2);
		assert_eq!(matches[0].text, "let a = 1;");
		assert_eq!(matches[1].text, "let b = 2;");
	}

	/// A source with no match is `Ok` with an empty list, which is a different
	/// answer from the error above and has to stay one.
	#[test]
	fn no_matches_is_an_empty_list_and_not_an_error() {
		let pattern = compile_pattern(
			"let $X = $Y;",
			None,
			&ast_grep_core::MatchStrictness::Smart,
			SupportLang::Rust,
		)
		.expect("compiles");

		let matches =
			collect_matches("fn f() {}", SupportLang::Rust, &[pattern]).expect("must not fail");

		assert!(matches.is_empty());
	}
}
