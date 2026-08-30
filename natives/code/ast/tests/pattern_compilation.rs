//! `veyyon_ast::ops::compile_pattern`, the boundary where a search pattern from
//! an `ast_grep` tool call becomes something that can be matched.
//!
//! WHY THIS SUITE EXISTS. Some patterns compile cleanly and then panic at MATCH
//! time inside ast-grep-core with "Ellipsis should be matched in parent level"
//! (`match_tree/mod.rs:79`). That assert is an upstream bug, but the reachable
//! consequence was ours: patterns arrive from an `ast_grep` tool call, `$$$` is
//! ordinary ast-grep syntax that a model or a person can reasonably type, and a
//! panic on the match path aborts the process rather than returning a tool
//! error.
//!
//! THE SEVERITY, STATED PRECISELY, BECAUSE THE FIRST VERSION OF THIS COMMENT
//! OVERSTATED IT. The upstream check is a `debug_assert!`, so a release build
//! compiles it out and the matcher returns a match instead of aborting. Debug,
//! test, and fuzz builds do abort. So the shipped binary was never crashing on
//! these patterns; it was quietly reporting matches it should not have, which
//! is the quieter half of the same bug and is why the guard returns an error in
//! both cases rather than only guarding the crash.
//!
//! HOW THE GUARD GOT ITS SHAPE, WHICH IS THE POINT OF THE SUITE.
//! `fuzz/fuzz_targets/ast_parse_and_match.rs` first found `"$$$"`, and the fix
//! was a syntax check that rejected a pattern whose whole text was an ellipsis.
//! The same fuzzer then found `"+$$$"`, which has more than an ellipsis in it
//! and panics anyway, so the syntactic set was never the right thing to
//! enumerate. `compile_pattern` now PROBES instead: it runs the compiled
//! pattern against seven trivial sources inside `catch_unwind` and converts a
//! panic into an error carrying the matcher's own message.
//!
//! A PROBE IS NOT A PROOF, AND AN EARLIER VERSION OF THIS COMMENT SAID IT WAS.
//! It claimed the assert depends on the pattern's tree rather than on the
//! source, so one probe answered for every source. Reading
//! `match_tree/match_node.rs` says otherwise: `match_node_impl` consults
//! `should_skip_cand_for_metavar(candidate)` and the parent's child iteration
//! before an ellipsis ever reaches `match_leaf_meta_var`, so the CANDIDATE
//! decides too. The eight-target campaign on 2026-07-25 then crashed inside
//! `collect_matches` on a pattern the probe had passed. So the probe is a wide
//! early net with a message about the pattern, and `collect_matches` and
//! `rewrite_source` carry the actual guarantee: `guard_matcher` wraps every
//! matcher call, so none of them can abort whatever the pattern and whatever
//! the source.
//!
//! The negative cases matter as much as the positive ones. A guard that
//! rejected `$$$` inside a real pattern would break the single most common
//! thing anyone writes with ast-grep, `fn $NAME($$$) { $$$ }`, so each of those
//! is pinned.

use ast_grep_core::MatchStrictness;
use veyyon_ast::{
	SupportLang,
	ops::{collect_matches, compile_pattern},
};

fn compile(pattern: &str, lang: SupportLang) -> anyhow::Result<ast_grep_core::matcher::Pattern> {
	compile_with(pattern, lang, &MatchStrictness::Smart)
}

/// Compile at an explicit strictness.
///
/// Strictness is not a detail here: it changes which nodes the matcher walks
/// into, so whether a pattern reaches the upstream assert depends on it. `+$$$`
/// is fine under `Smart` and trips under `Cst`, and an earlier version of this
/// suite tested it at `Smart` and concluded the guard had missed it.
fn compile_with(
	pattern: &str,
	lang: SupportLang,
	strictness: &MatchStrictness,
) -> anyhow::Result<ast_grep_core::matcher::Pattern> {
	compile_pattern(pattern, None, strictness, lang)
}

mod bare_ellipsis_is_refused {
	use super::*;

	/// The first reproducer: a bare `$$$` must be an error, not a panic later.
	#[test]
	fn a_bare_ellipsis_is_rejected_at_compile_time() {
		let error = compile("$$$", SupportLang::Html).expect_err("a bare ellipsis must be refused");

		assert!(
			error.to_string().contains("cannot be matched"),
			"the error should explain what is wrong, got: {error}",
		);
	}

	/// The second reproducer, and the reason the guard is a probe rather than a
	/// syntax check. `+$$$` is not a bare ellipsis by any textual reading, and
	/// it trips the same assert. A guard built by enumerating pattern shapes
	/// would have shipped, looked correct, and still missed this.
	///
	/// The full strictness map is pinned because it is the whole argument for
	/// the probe running at the CALLER'S strictness rather than at a fixed one.
	/// Strictness decides which nodes the matcher walks into, so the same
	/// pattern reaches the assert under `Ast`, `Relaxed`, and `Signature` and
	/// never gets near it under `Cst`, `Smart`, or `Template`. A guard that
	/// tested one fixed level would either miss three of these or refuse three
	/// patterns that work, and which of those you got would depend on the level
	/// somebody happened to hard-code. Two earlier drafts of this very test
	/// picked `Smart` and then `Cst` and concluded the guard was broken; it was
	/// not.
	#[test]
	fn a_prefixed_ellipsis_is_refused_at_exactly_the_strictness_levels_that_fail() {
		// Named alongside each level because `MatchStrictness` has no `Debug`, and
		// a failure that cannot say which level it was is a failure you have to
		// reproduce by hand.
		for (name, strictness) in [
			("Ast", MatchStrictness::Ast),
			("Relaxed", MatchStrictness::Relaxed),
			("Signature", MatchStrictness::Signature),
		] {
			let error = compile_with("+$$$", SupportLang::Rust, &strictness)
				.expect_err("`+$$$` must be refused where the matcher asserts on it");

			assert!(
				error.to_string().contains("cannot be matched"),
				"the error should explain what is wrong at {name}, got: {error}",
			);
		}

		for (name, strictness) in [
			("Cst", MatchStrictness::Cst),
			("Smart", MatchStrictness::Smart),
			("Template", MatchStrictness::Template),
		] {
			assert!(
				compile_with("+$$$", SupportLang::Rust, &strictness).is_ok(),
				"`+$$$` works at {name} and must not be refused there",
			);
		}
	}

	/// The error carries the matcher's own message, so the report says what
	/// actually failed instead of this crate's guess about it.
	#[test]
	fn the_error_quotes_the_matchers_own_message() {
		let error = compile("$$$", SupportLang::Rust).expect_err("must fail");

		assert!(
			error
				.to_string()
				.contains("Ellipsis should be matched in parent level"),
			"the error should quote the upstream assert, got: {error}",
		);
	}

	/// The error tells the caller what to write instead. A tool error that only
	/// says "invalid" leaves the model to guess, and it will guess `$$$` again.
	#[test]
	fn the_error_suggests_a_working_pattern() {
		let error = compile("$$$", SupportLang::Rust).expect_err("must fail");

		assert!(
			error.to_string().contains("fn $NAME($$$)"),
			"the error should show a pattern that works, got: {error}",
		);
	}

	/// A NAMED ellipsis is a different metavariable and must NOT be refused.
	///
	/// `$$$` is `MetaVariable::Multiple` and `$$$ARGS` is
	/// `MetaVariable::MultiCapture`, and the upstream assert fires only on the
	/// first. An earlier version of this suite asserted that `$$$ARGS` was
	/// rejected too, reasoning by analogy rather than by reading the matcher,
	/// and it was simply wrong: the probe correctly lets these through. Kept as
	/// a positive case so nobody widens the guard back over them.
	#[test]
	fn a_named_ellipsis_is_not_refused() {
		for pattern in ["$$$ARGS", "$$$args", "$$$A_1"] {
			assert!(
				compile(pattern, SupportLang::Rust).is_ok(),
				"{pattern:?} is a named capture, not the unnamed ellipsis the assert is about",
			);
		}
	}

	/// Surrounding whitespace does not smuggle a bare ellipsis through.
	#[test]
	fn whitespace_around_a_bare_ellipsis_does_not_hide_it() {
		for pattern in ["  $$$  ", "\n$$$\n", "\t$$$ "] {
			assert!(compile(pattern, SupportLang::Rust).is_err(), "{pattern:?} must be refused");
		}
	}

	/// Refused for every language, since the parent-level requirement is a
	/// property of the matcher rather than of a grammar.
	#[test]
	fn a_bare_ellipsis_is_refused_in_every_language() {
		for lang in [
			SupportLang::Rust,
			SupportLang::TypeScript,
			SupportLang::Python,
			SupportLang::Bash,
			SupportLang::Html,
			SupportLang::Yaml,
			SupportLang::Json,
		] {
			assert!(compile("$$$", lang).is_err(), "a bare ellipsis must be refused for {lang:?}");
		}
	}

	/// The whole point of refusing it: matching must not panic. Compiling
	/// returning `Err` is only useful if nothing downstream can still reach the
	/// panicking path, so this drives the exact call that used to abort.
	#[test]
	fn the_pattern_that_used_to_panic_now_returns_an_error() {
		let result = compile("$$$", SupportLang::Html);

		assert!(result.is_err(), "the reproducer must not produce a matchable pattern");
	}
}

mod ordinary_patterns_still_compile {
	use super::*;

	/// The single most common ast-grep pattern there is. A guard that broke this
	/// would be worse than the crash it prevents.
	#[test]
	fn an_ellipsis_inside_a_function_pattern_compiles_and_matches() {
		let pattern = compile("fn $NAME($$$) { $$$ }", SupportLang::Rust).expect("must compile");

		let matches = collect_matches("fn main() { let x = 1; }", SupportLang::Rust, &[pattern])
			.expect("matching must not fail");

		assert_eq!(matches.len(), 1, "the pattern should match the one function");
		assert_eq!(matches[0].text, "fn main() { let x = 1; }");
	}

	/// An ellipsis in argument position, which is the other everyday use.
	#[test]
	fn an_ellipsis_in_a_call_compiles_and_matches() {
		let pattern = compile("println!($$$)", SupportLang::Rust).expect("must compile");

		let matches =
			collect_matches(r#"fn f() { println!("a{}", 1); }"#, SupportLang::Rust, &[pattern])
				.expect("matching must not fail");

		assert_eq!(matches.len(), 1);
		assert_eq!(matches[0].text, r#"println!("a{}", 1)"#);
	}

	/// A single-node metavariable is a different construct and was never
	/// affected. Pinned so the guard's prefix check cannot widen to `$`.
	#[test]
	fn a_bare_single_metavariable_still_compiles() {
		let pattern = compile("$X", SupportLang::Rust).expect("a bare $X must still compile");

		let matches = collect_matches("fn f() { y; }", SupportLang::Rust, &[pattern])
			.expect("matching must not fail");

		assert!(!matches.is_empty(), "$X should match at least one node");
	}

	/// Text beginning with the sigil but continuing into real syntax is a
	/// pattern, not a bare ellipsis, so the guard must not be what rejects it.
	///
	/// Asserted on WHICH error rather than on success, because ast-grep has its
	/// own opinions about these fragments: `$$$; return $X;` parses to multiple
	/// root nodes and Rust has no wrapper template, so it is refused as
	/// `MultipleNode`. That refusal is correct and predates this guard. What
	/// would be a bug is the guard claiming these are bare ellipses, which is
	/// how a too-eager prefix check would break `$$$` in every real pattern.
	#[test]
	fn ordinary_patterns_are_not_rejected_by_the_probe() {
		for pattern in ["fn $NAME($$$) { $$$ }", "println!($$$)", "let $X = $Y;", "$X.foo($$$)"] {
			let error = compile(pattern, SupportLang::Rust).err();

			assert!(
				error.is_none(),
				"{pattern:?} is an ordinary pattern but was refused: {}",
				error.map_or_else(String::new, |err| err.to_string()),
			);
		}
	}

	/// Reported byte ranges must line up with the source, which is what
	/// `apply_edits` later slices on. Asserted with the real text rather than a
	/// count, because a match at the wrong offsets rewrites the wrong bytes.
	#[test]
	fn match_ranges_address_the_text_they_report() {
		let pattern = compile("let $X = $Y;", SupportLang::Rust).expect("must compile");
		let source = "fn f() { let a = 1; let b = 2; }";

		let matches =
			collect_matches(source, SupportLang::Rust, &[pattern]).expect("matching must not fail");

		assert_eq!(matches.len(), 2);
		for found in &matches {
			assert_eq!(found.text, &source[found.byte_start..found.byte_end]);
		}
		assert_eq!(matches[0].text, "let a = 1;");
		assert_eq!(matches[1].text, "let b = 2;");
	}
}
