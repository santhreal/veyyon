//! A condensed lint report is handed back, not condensed a second time.
//!
//! WHAT CONDENSING PRODUCES. `group_diagnostics` turns a linter's diagnostics
//! into a `N diagnostics in M files` header, an optional `Top codes:` line, and
//! then one `path (N diagnostics)` header per file with the rest of each
//! diagnostic indented underneath it.
//!
//! THE BUG, AND WHY THE EXISTING GUARD WAS NOT ENOUGH. `group_diagnostics`
//! already recognizes the minimizer's own annotations and passes them through.
//! But `strip_lint_noise` runs BEFORE it, and it cannot recognize them, because
//! the ENTRY rows under a `path (N diagnostics)` header are the tails of real
//! diagnostics with the file prefix cut off. They can look like anything at
//! all, including like the code-frame noise the stripper exists to remove. A
//! biome diagnostic whose message began with digits came back as `"  000
//! ))::0…"`, which is shaped exactly like a tsc-pretty code-frame gutter line,
//! so the second pass DELETED the diagnostic and kept only the header saying
//! one existed. The report then claimed a diagnostic with nothing under it to
//! say what it was.
//!
//! Filters chain and captures get replayed, so a second pass is an ordinary
//! event. Found by `fuzz/fuzz_targets/minimizer_filters.rs`, whose property is
//! that a filter does not change its own output on a second pass.
//!
//! THE RULE NOW. Recognizing the header and stopping is the only reliable
//! guard, for the same reason it is the guard `find` uses: an entry row cannot
//! be told apart from program output by shape alone.
//! `primitives::is_diagnostic_count_header` is the one owner of the shape, and
//! `is_minimizer_annotation` reads it too, so the header the condenser writes
//! and the header it recognizes cannot drift apart.

use veyyon_shell::minimizer::{MinimizerCtx, filters, primitives::is_diagnostic_count_header};

mod common;

use common::{context, enabled};

/// Filter `input`, then filter the result, and return both.
fn two_passes(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> (String, String) {
	let first = filters::filter(ctx, input, exit_code).text;
	let second = filters::filter(ctx, &first, exit_code).text;
	(first, second)
}

mod the_header_predicate {
	use super::*;

	/// The shape the condenser writes is the shape the predicate reads.
	#[test]
	fn the_condenser_header_is_recognized() {
		assert!(is_diagnostic_count_header("3 diagnostics in 2 files"));
		assert!(is_diagnostic_count_header("1 diagnostics in 1 files"));
	}

	/// Leading whitespace does not hide it.
	///
	/// A condensed report can arrive nested inside another filter's output, and
	/// a predicate that only matched at column zero would let it through.
	#[test]
	fn an_indented_header_is_still_recognized() {
		assert!(is_diagnostic_count_header("  3 diagnostics in 2 files"));
	}

	/// A line that merely mentions files is not the header.
	///
	/// The negative twin: if this matched, every linter's own summary line would
	/// stop the condenser before it ever ran.
	#[test]
	fn an_ordinary_summary_line_is_not_the_header() {
		assert!(!is_diagnostic_count_header("Checked 42 files"));
		assert!(!is_diagnostic_count_header("3 problems in 2 files"));
		assert!(!is_diagnostic_count_header("found 3 diagnostics in the project"));
		assert!(!is_diagnostic_count_header(""));
	}
}

mod a_condensed_report_survives_a_second_pass {
	use super::*;

	/// THE regression, as the fuzzer reduced it.
	///
	/// The diagnostic's text starts with digits, so on the second pass the entry
	/// row read as a code-frame gutter line and was stripped as noise. The
	/// header stayed, so the report said the diagnostics existed and showed
	/// nothing.
	///
	/// Two diagnostics rather than the fuzzer's one, because a single diagnostic
	/// is no longer wrapped in a set summary at all (see the `diag_count <= 1`
	/// branch in `group_diagnostics`) and so never reaches the entry rows this
	/// pins.
	#[test]
	fn a_diagnostic_whose_text_begins_with_digits_is_not_stripped_on_a_second_pass() {
		let config = enabled();
		let ctx = context("biome", Some("clean"), "", &config);
		let (first, second) =
			two_passes(&ctx, "a.ts:1:1: 000 bad index\nb.ts:2:2: 123 files touched\n", 1);

		assert!(first.contains("2 diagnostics in 2 files"), "the first pass condenses: {first:?}");
		assert!(first.contains("000 bad index"), "and keeps the diagnostic text: {first:?}");
		assert!(first.contains("123 files touched"), "all of it: {first:?}");
		assert_eq!(second, first, "the second pass must not delete what the header counts");
	}

	/// A realistic biome report keeps every diagnostic across passes.
	///
	/// The reduced case proves the mechanism; this proves the thing an operator
	/// reads. A header that counts three diagnostics and shows one is worse than
	/// no minimization at all, because it looks complete.
	#[test]
	fn a_real_report_keeps_its_diagnostics() {
		let config = enabled();
		let ctx = context("biome", Some("check"), "biome check .", &config);
		let input = "src/app.ts:12:3: lint/style/useConst  This let declares a variable that is \
		             never reassigned.\nsrc/app.ts:31:1: lint/suspicious/noExplicitAny  Unexpected \
		             any.\nsrc/util.ts:4:9: lint/style/useConst  This let declares a variable that \
		             is never reassigned.\n";
		let (first, second) = two_passes(&ctx, input, 1);

		assert!(first.contains("3 diagnostics in 2 files"), "got: {first:?}");
		assert!(first.contains("useConst"), "the rule names survive: {first:?}");
		assert!(first.contains("noExplicitAny"), "all of them: {first:?}");
		assert_eq!(second, first, "and none of them are deleted by a second pass");
	}

	/// The count in the header keeps matching the number of entries shown.
	///
	/// This is the invariant the bug broke, stated directly rather than through
	/// string equality: the header is a claim about what follows it, and a pass
	/// that removes entries without changing the header makes the report lie.
	#[test]
	fn the_header_count_still_matches_the_entries_shown() {
		let config = enabled();
		let ctx = context("biome", Some("check"), "biome check .", &config);
		let input = "a.ts:1:1: lint/a  0 is not a valid index\na.ts:2:1: lint/b  123 files were \
		             touched\nb.ts:3:1: lint/c  9 problems remain\n";
		let (first, second) = two_passes(&ctx, input, 1);

		let entries = |text: &str| text.lines().filter(|line| line.starts_with("  ")).count();
		assert!(first.contains("3 diagnostics in 2 files"), "got: {first:?}");
		assert_eq!(entries(&first), 3, "all three are shown on the first pass: {first:?}");
		assert_eq!(entries(&second), 3, "and all three survive the second: {second:?}");
	}

	/// Several passes leave it alone, since a fix that merely alternated between
	/// two answers would satisfy a single repeat.
	#[test]
	fn a_condensed_report_stays_fixed_across_repeated_passes() {
		let config = enabled();
		let ctx = context("biome", Some("check"), "biome check .", &config);
		let mut text =
			filters::filter(&ctx, "a.ts:1:1: lint/a  4 spaces expected\nb.ts:2:2: lint/b  bad\n", 1)
				.text;
		let expected = text.clone();
		for pass in 1..=4 {
			text = filters::filter(&ctx, &text, 1).text;
			assert_eq!(text, expected, "pass {pass} rewrote a settled report");
		}
	}
}

mod the_grouping_pass_guards_itself_too {
	use veyyon_shell::minimizer::filters::lint::group_diagnostics;

	/// THE regression at the grouping pass, which other filters call directly.
	///
	/// Recognizing annotations line by line is not enough here, and the reason
	/// is structural: on a second pass EVERY line is either an annotation or an
	/// entry row, so nothing groups, and the empty-map branch falls through to
	/// `dedup_consecutive_lines` over the WHOLE report. That collapsed two
	/// identical entries into `0 (×2)`, which is a repeat counter on rows the
	/// grouper wrote itself, claiming a linter had printed the same diagnostic
	/// twice when it had printed two different ones.
	#[test]
	fn regrouping_a_report_does_not_dedup_its_own_entries() {
		let once = group_diagnostics("a.rs:0: first\na.rs:0: second\n");
		assert!(once.contains("2 diagnostics in 1 files"), "sanity: {once:?}");
		assert_eq!(group_diagnostics(&once), once, "a settled report must not be regrouped");
	}

	/// Identical diagnostics keep their own entries rather than gaining a
	/// counter.
	///
	/// The exact shape the fuzzer found: two entries that render the same.
	/// Collapsing them is wrong twice over, because it both invents a repeat the
	/// linter never reported and contradicts the count in the header above.
	#[test]
	fn two_entries_that_render_alike_are_not_collapsed_into_a_repeat() {
		let once = group_diagnostics("/(]:0\n/(]:0\n");
		assert!(once.contains("2 diagnostics"), "the header counts both: {once:?}");
		let regrouped = group_diagnostics(&once);
		assert!(!regrouped.contains('×'), "no repeat counter may appear: {regrouped:?}");
		assert_eq!(regrouped, once);
	}

	/// Grouping an ungrouped capture still works, which the guard must not
	/// break.
	#[test]
	fn an_ungrouped_capture_is_still_grouped() {
		let grouped = group_diagnostics("a.rs:1: boom\na.rs:2: bang\nb.rs:3: crash\n");
		assert!(grouped.starts_with("3 diagnostics in 2 files\n"), "got: {grouped:?}");
	}
}

mod one_diagnostic_needs_no_set_summary {
	use veyyon_shell::minimizer::filters::lint::group_diagnostics;

	use super::*;

	/// A single diagnostic is left as the line the program printed.
	///
	/// The `N diagnostics in M files` header and the `path (N diagnostics)` row
	/// are both claims about a SET. With one diagnostic they restate the line
	/// underneath them, and the agent pays for two extra lines out of its
	/// context, which is a minimizer doing worse than nothing. At the bottom it
	/// inverted outright: a diagnostic whose message text is empty is counted
	/// but not printed, so ONE line of program output came back as TWO lines
	/// with nothing under them. Found by
	/// `fuzz/fuzz_targets/minimizer_lint_condense.rs`.
	#[test]
	fn a_lone_diagnostic_is_not_wrapped_in_a_header() {
		let grouped = group_diagnostics("src/main.rs:10: mismatched types\n");
		assert_eq!(grouped, "src/main.rs:10: mismatched types\n");
	}

	/// And the same through the real dispatcher.
	#[test]
	fn a_lone_diagnostic_survives_the_dispatcher_unwrapped() {
		let config = enabled();
		let ctx = context("biome", Some("check"), "biome check .", &config);
		let first =
			filters::filter(&ctx, "src/app.ts:12:3: lint/style/useConst  never reassigned\n", 1).text;

		assert!(!first.contains(" diagnostics in "), "no set summary for one diagnostic: {first:?}");
		assert!(first.contains("useConst"), "and the diagnostic itself is untouched: {first:?}");
	}

	/// Two diagnostics DO get the summary, even though it costs lines.
	///
	/// The boundary, and the negative twin that keeps the rule from eating the
	/// feature: at two the header is telling you something the lines do not, and
	/// the per-file rows are what make a long report readable. Grouping is a
	/// trade of lines for bytes, not a reduction in lines, and the rule above is
	/// only about the case where there is nothing to trade.
	#[test]
	fn two_diagnostics_still_get_the_summary() {
		let grouped =
			group_diagnostics("src/main.rs:10: mismatched types\nsrc/main.rs:12: unused import\n");
		assert!(grouped.starts_with("2 diagnostics in 1 files\n"), "got: {grouped:?}");
		assert!(grouped.contains("src/main.rs (2 diagnostics)"), "got: {grouped:?}");
	}

	/// A lone diagnostic still settles after one pass.
	#[test]
	fn the_unwrapped_form_is_idempotent() {
		let once = group_diagnostics("src/main.rs:10: mismatched types\n");
		assert_eq!(group_diagnostics(&once), once);
	}
}

mod an_uncondensed_capture_is_still_condensed {
	use std::fmt::Write as _;

	use super::*;

	/// The negative twin for the whole guard.
	///
	/// If the guard fired on ordinary linter output the minimizer would stop
	/// minimizing the exact captures it was written for, and nothing else in the
	/// suite would notice: every idempotence check would still pass, because
	/// doing nothing is perfectly idempotent.
	#[test]
	fn ordinary_lint_output_is_still_grouped_and_shrunk() {
		let config = enabled();
		let ctx = context("biome", Some("check"), "biome check .", &config);
		let mut input = String::new();
		for n in 1..=30 {
			writeln!(
				input,
				"src/app.ts:{n}:1: lint/style/useConst  This let declares a variable that is never \
				 reassigned."
			)
			.expect("writing to a String cannot fail");
		}
		let first = filters::filter(&ctx, &input, 1).text;

		assert!(first.starts_with("30 diagnostics in 1 files\n"), "got: {first:?}");
		assert!(first.contains("src/app.ts (30 diagnostics)"), "got: {first:?}");
		assert!(first.len() < input.len(), "and the whole point is that it got smaller");
	}

	/// A linter's own line mentioning files does not stop the condenser.
	///
	/// The guard matches the minimizer's header shape and not merely the words
	/// in it, so a real summary line passes through and the diagnostics around
	/// it are still grouped.
	#[test]
	fn a_capture_containing_the_word_files_is_still_condensed() {
		let config = enabled();
		let ctx = context("biome", Some("check"), "biome check .", &config);
		let input = "Checked 42 files in 300ms\nsrc/app.ts:12:3: lint/style/useConst  never \
		             reassigned\nsrc/app.ts:31:1: lint/suspicious/noExplicitAny  Unexpected any.\n";
		let first = filters::filter(&ctx, input, 1).text;

		assert!(first.contains("2 diagnostics in 1 files"), "got: {first:?}");
	}
}

/// The cargo test failure latch, which an annotation could switch on.
///
/// WHY THIS BELONGS HERE. Everything else in this file is a filter EATING its
/// own annotation. This is the same disease with the sign flipped: the
/// annotation made the filter keep the wrong thing. `failures_only` latches on
/// `---- `, the Rust failure-header prefix, and starts keeping output
/// from there. A capture holding a bare `----` twice deduplicates to `----
/// (×2)`, which starts with that prefix without being a header, so the second
/// pass latched on the minimizer's own repeat counter and discarded everything
/// before it. A capture that had been minimized once came back shorter every
/// time it was minimized again, which for a failing test run means the failure
/// the agent needs can be the part that goes. Found by
/// `fuzz/fuzz_targets/minimizer_filters.rs`.
mod a_repeat_counter_does_not_open_a_failure_block {
	use veyyon_shell::minimizer::filters;

	use super::{context, enabled};

	/// THE regression, as the fuzzer reduced it.
	#[test]
	fn a_capture_with_a_deduplicated_dash_run_settles() {
		let config = enabled();
		let ctx = context("cargo", Some("test"), "cargo test", &config);
		let input = "leading line\n----\n----\ntrailing line\n";

		let first = filters::filter(&ctx, input, 130).text;
		assert!(first.contains("---- (×2)"), "sanity: the dedup counter is written: {first:?}");
		assert!(
			first.contains("leading line"),
			"sanity: the head survives the first pass: {first:?}"
		);

		let second = filters::filter(&ctx, &first, 130).text;
		assert_eq!(second, first, "the second pass must not latch on our own counter");
		assert!(second.contains("leading line"), "and must not discard the head: {second:?}");
	}

	/// A real failure header still latches, which is what the filter is for.
	///
	/// The negative twin, and the one that matters: a guard that suppressed the
	/// latch entirely would make every failing `cargo test` capture fall
	/// through to the generic build condenser, and nothing else in the suite
	/// would notice.
	#[test]
	fn a_real_failure_header_still_starts_the_block() {
		let config = enabled();
		let ctx = context("cargo", Some("test"), "cargo test", &config);
		let input = "running 2 tests\ntest alpha ... ok\ntest beta ... FAILED\nfailures:\n\n---- \
		             beta stdout ----\nthread 'beta' panicked at src/lib.rs:10:5:\nassertion \
		             failed\n\ntest result: FAILED. 1 passed; 1 failed\n";

		let first = filters::filter(&ctx, input, 101).text;
		assert!(first.contains("---- beta stdout ----"), "the header is kept: {first:?}");
		assert!(first.contains("assertion failed"), "and the panic under it: {first:?}");
		assert!(!first.contains("test alpha ... ok"), "while the passing test goes: {first:?}");

		let second = filters::filter(&ctx, &first, 101).text;
		assert_eq!(second, first, "and it settles after one pass");
	}

	/// Several failures all survive, so the latch is not merely finding the
	/// first one.
	#[test]
	fn every_failure_block_survives() {
		let config = enabled();
		let ctx = context("cargo", Some("test"), "cargo test", &config);
		let input = "running 3 tests\nfailures:\n\n---- alpha stdout ----\nthread 'alpha' panicked \
		             at a.rs:1:1:\nalpha broke\n\n---- gamma stdout ----\nthread 'gamma' panicked \
		             at g.rs:2:2:\ngamma broke\n\ntest result: FAILED. 1 passed; 2 failed\n";

		let first = filters::filter(&ctx, input, 101).text;
		assert!(first.contains("alpha broke"), "got: {first:?}");
		assert!(first.contains("gamma broke"), "got: {first:?}");
		assert_eq!(filters::filter(&ctx, &first, 101).text, first, "and it settles");
	}
}
