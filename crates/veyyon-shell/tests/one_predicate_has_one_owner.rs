//! The predicates several filters share have exactly one definition, and it is
//! the one they all call.
//!
//! WHY THIS SUITE EXISTS. Six helpers were defined more than once across
//! `src/minimizer/filters/`, and the copies had drifted:
//!
//!   - `contains_diagnostic_signal` matched `panic` in `lint.rs` and did not in
//!     `dotnet.rs`, so the same build log kept a panic line through one filter
//!     and dropped it through the other.
//!   - `push_line` trimmed trailing whitespace in `js_tools.rs` and not in the
//!     four other files that defined it, so a compactor emitted a different
//!     byte depending on which file it lived in.
//!   - `has_ordered_tokens` was a byte-identical third copy of
//!     `primitives::command_has_ordered_tokens`, which already existed.
//!   - `is_test_script_token` and `is_lint_script_token` existed in both the
//!     dispatcher (`filters/mod.rs`) and `bun.rs`. The dispatcher uses them to
//!     pick a filter and the filter uses them again to decide how to compact;
//!     if the two disagree, output is routed as a test run and then compacted
//!     as something else, and nothing surfaces that.
//!   - `looks_like_path` and `is_important_line` were each on two functions
//!     that answered genuinely different questions. Those were renamed rather
//!     than merged, because merging them would have been wrong.
//!
//! None of the drift was caught by a test, because every caller went through a
//! filter and no filter test exercised the disagreeing input. These tests go at
//! the predicates directly, through the public `primitives` surface, and then
//! prove the behavior end to end through the filters that used to disagree.

use veyyon_shell::minimizer::{MinimizerConfig, MinimizerCtx, filters, primitives};

mod common;

use common::enabled;

/// Build the context a filter is handed for one command.
const fn ctx<'a>(
	program: &'a str,
	subcommand: Option<&'a str>,
	command: &'a str,
	config: &'a MinimizerConfig,
) -> MinimizerCtx<'a> {
	MinimizerCtx { program, subcommand, command, config }
}

mod a_diagnostic_signal_is_one_word_list {
	use super::*;

	/// THE regression. `lint.rs` matched `panic` and `dotnet.rs` did not. The
	/// union is the correct answer: dropping a panic line costs the reader the
	/// failure itself, while keeping one diagnostic too many costs them a line.
	#[test]
	fn panic_is_a_diagnostic() {
		assert!(primitives::contains_diagnostic_signal("thread 'main' panicked at src/lib.rs:4"));
	}

	/// The four words both copies already agreed on, pinned so a future edit
	/// cannot quietly narrow the list back down.
	#[test]
	fn the_words_both_copies_already_shared_are_still_diagnostics() {
		assert!(primitives::contains_diagnostic_signal("error CS1002: ; expected"));
		assert!(primitives::contains_diagnostic_signal("warning CS0168: variable declared"));
		assert!(primitives::contains_diagnostic_signal("Build FAILED."));
		assert!(primitives::contains_diagnostic_signal("System.NullReferenceException"));
	}

	/// It lowercases the line itself. The `dotnet.rs` copy took an
	/// ALREADY-lowercased string, so handing it a raw line compiled fine and
	/// silently matched nothing. That is the failure mode this assertion exists
	/// to make impossible.
	#[test]
	fn an_uppercase_line_is_matched_without_the_caller_lowercasing_it() {
		assert!(primitives::contains_diagnostic_signal("ERROR: could not restore"));
		assert!(primitives::contains_diagnostic_signal("FAILED"));
		assert!(primitives::contains_diagnostic_signal("PANIC"));
	}

	/// The negative twin. A line with none of the words is not a diagnostic, so
	/// the predicate cannot have widened into "everything is important".
	#[test]
	fn an_ordinary_line_is_not_a_diagnostic() {
		assert!(!primitives::contains_diagnostic_signal("Restored /src/app.csproj (in 412 ms)."));
		assert!(!primitives::contains_diagnostic_signal("  Determining projects to restore..."));
		assert!(!primitives::contains_diagnostic_signal(""));
	}

	/// The word may sit anywhere in the line, not only at the start. `dotnet.rs`
	/// calls this on a line that begins with `restored ` and asks whether the
	/// REST of it carries a diagnostic.
	#[test]
	fn the_word_is_found_mid_line() {
		assert!(primitives::contains_diagnostic_signal("restored 3 projects, 1 failed"));
	}

	/// End to end through the filter that used to disagree: a `dotnet restore`
	/// line that mentions a panic must survive, because `is_dotnet_boilerplate`
	/// asks this predicate whether the line is more than boilerplate. Before
	/// the unification the dotnet copy did not know the word and the line was
	/// stripped.
	#[test]
	fn dotnet_keeps_a_restore_line_that_mentions_a_panic() {
		let config = enabled();
		let input = "Restored /src/app.csproj panic in analyzer\nBuild succeeded.\n";
		let out = filters::filter(&ctx("dotnet", Some("build"), "dotnet build", &config), input, 1);

		assert!(
			out.text.contains("panic in analyzer"),
			"the panic line was dropped; got {:?}",
			out.text
		);
	}
}

mod one_line_is_appended_one_way {
	use super::*;

	/// The four identical copies. Appending adds the line and a newline, and
	/// changes nothing else about the bytes.
	#[test]
	fn a_line_is_appended_verbatim_with_a_newline() {
		let mut out = String::new();
		primitives::push_line(&mut out, "first");
		primitives::push_line(&mut out, "second");

		assert_eq!(out, "first\nsecond\n");
	}

	/// THE divergence. The `js_tools.rs` copy trimmed trailing whitespace and
	/// the other four did not. The owner does not trim: a caller that wants it
	/// says so, and this pins that the default preserves what it was given.
	#[test]
	fn trailing_whitespace_is_preserved_by_the_owner() {
		let mut out = String::new();
		primitives::push_line(&mut out, "kept   ");

		assert_eq!(out, "kept   \n", "the owner must not trim on the caller's behalf");
	}

	/// And the caller that wants the trim gets exactly the old behavior by
	/// asking for it, which is the property that made the unification safe.
	#[test]
	fn a_caller_that_wants_the_trim_asks_for_it() {
		let mut out = String::new();
		primitives::push_line(&mut out, "trimmed   ".trim_end());

		assert_eq!(out, "trimmed\n");
	}

	/// An empty line is still a line. A compactor that pushes one is asking for
	/// a blank, not for nothing.
	#[test]
	fn an_empty_line_still_writes_a_newline() {
		let mut out = String::new();
		primitives::push_line(&mut out, "");

		assert_eq!(out, "\n");
	}
}

mod ordered_tokens_have_one_scanner {
	use super::*;

	/// `git.rs` and `gt.rs` each carried a byte-identical copy of this while the
	/// canonical owner already existed in `primitives`. Three definitions, one
	/// behavior. These assertions pin the behavior at the owner.
	#[test]
	fn the_second_token_must_follow_the_first() {
		assert!(primitives::command_has_ordered_tokens("git stash show -p", "stash", "show"));
		assert!(primitives::command_has_ordered_tokens("gt log --short", "log", "--short"));
	}

	/// Order is the whole point of the predicate: reversed, it must not match.
	#[test]
	fn the_reverse_order_does_not_match() {
		assert!(!primitives::command_has_ordered_tokens("git show stash", "stash", "show"));
	}

	/// A token must be a whole word. `git stashed showcase` is not `git stash
	/// show`.
	#[test]
	fn a_substring_is_not_a_token() {
		assert!(!primitives::command_has_ordered_tokens("git stashed showcase", "stash", "show"));
	}

	/// Only the first is present, so there is nothing to follow it.
	#[test]
	fn the_first_token_alone_does_not_match() {
		assert!(!primitives::command_has_ordered_tokens("git stash", "stash", "show"));
	}

	/// End to end: `git stash show -p` is a patch, which is what the caller in
	/// `git.rs` uses this to decide.
	#[test]
	fn git_still_recognizes_a_stash_patch() {
		let config = enabled();
		let command = concat!("git ", "stash", " show -p");
		let out = filters::filter(
			&ctx("git", Some("stash"), command, &config),
			"diff --git a/a.txt b/a.txt\n+added\n",
			0,
		);

		assert!(out.text.contains("+added"), "patch body was dropped: {:?}", out.text);
	}
}

mod the_router_and_the_filter_agree_on_a_script_word {
	use super::*;

	/// The dispatcher and `bun.rs` each classified script words. These are the
	/// words both agreed on; pinned at the single owner they now share.
	#[test]
	fn a_test_script_word_is_recognized() {
		assert!(primitives::is_test_script_token("test"));
		assert!(primitives::is_test_script_token("t"));
		assert!(primitives::is_test_script_token("e2e"));
		assert!(primitives::is_test_script_token("spec"));
		assert!(primitives::is_test_script_token("test:unit"));
	}

	/// Quoting is how the two copies differed in form: the dispatcher inlined
	/// the trim and `bun.rs` called a named helper. Both must strip it, because
	/// a script name reaches the minimizer exactly as it was typed.
	#[test]
	fn quoting_does_not_change_the_answer() {
		assert!(primitives::is_test_script_token("\"test\""));
		assert!(primitives::is_test_script_token("'test:unit'"));
		assert!(primitives::is_test_script_token("`e2e`"));
		assert!(primitives::is_lint_script_token("\"lint:fix\""));
	}

	/// The negative twin, and the reason the predicate is narrow: `build` and
	/// `testing-library` must not route output through the test filter.
	#[test]
	fn a_word_that_merely_starts_with_test_is_not_a_test_script() {
		assert!(!primitives::is_test_script_token("testing-library"));
		assert!(!primitives::is_test_script_token("build"));
		assert!(!primitives::is_test_script_token(""));
	}

	/// The lint half, including the three prefixed forms.
	#[test]
	fn a_lint_script_word_is_recognized() {
		assert!(primitives::is_lint_script_token("lint"));
		assert!(primitives::is_lint_script_token("typecheck"));
		assert!(primitives::is_lint_script_token("type-check"));
		assert!(primitives::is_lint_script_token("lint:fix"));
		assert!(primitives::is_lint_script_token("typecheck:ci"));
		assert!(primitives::is_lint_script_token("type-check:all"));
	}

	/// And its negative twin.
	#[test]
	fn a_word_that_merely_contains_lint_is_not_a_lint_script() {
		assert!(!primitives::is_lint_script_token("linting-rules"));
		assert!(!primitives::is_lint_script_token("prettier"));
	}

	/// The trim is its own owner too, so a filter classifying some other word
	/// gets the same quote handling for free.
	#[test]
	fn the_quote_trim_is_shared() {
		assert_eq!(primitives::trim_command_token("\"check:types\""), "check:types");
		assert_eq!(primitives::trim_command_token("'run'"), "run");
		assert_eq!(primitives::trim_command_token("`x`"), "x");
		assert_eq!(primitives::trim_command_token("plain"), "plain");
	}
}
