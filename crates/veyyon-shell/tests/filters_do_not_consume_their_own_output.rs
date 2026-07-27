//! A filter must not read its own annotations back as program output.
//!
//! WHY A SECOND PASS IS ORDINARY. Filters chain, wrappers re-filter what they
//! wrapped, and captures get replayed. So a filter runs over text it wrote
//! itself as a matter of course, and the summaries and markers it splices in
//! are, to the next pass, just more lines of program output. Every filter that
//! parses lines has to survive that, and several did not.
//!
//! WHAT WENT WRONG, ONE CASE PER MODULE BELOW. The pytest success path branches
//! on "did anything survive filtering?" and counted its own elision marker as
//! something that survived, so the branch flipped on the second pass. The find
//! filter collected every non-blank line as a path and so counted its own
//! header, printing `find: 2 paths in 1 dirs` for one path. The dotnet build
//! filter classified its own `dotnet build: failed` header as a failure
//! diagnostic, emitted the header again above it, and the dedup pass collapsed
//! the pair into `dotnet build: failed (×2)`.
//!
//! All three were found by `fuzz/fuzz_targets/minimizer_filters.rs`, whose
//! property is that a filter does not change its own output on a second pass.
//! They are one bug in three places, which is why the shared predicates
//! (`is_minimizer_annotation`, `is_program_content`, `has_program_content`) are
//! the fix rather than three local patches, and why this file tests them
//! through the real dispatcher instead of through the predicates.

use veyyon_shell::minimizer::{MinimizerCtx, filters};

mod common;

use common::{context, enabled};

/// Filter `input`, then filter the result, and return both.
fn two_passes(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> (String, String) {
	let first = filters::filter(ctx, input, exit_code).text;
	let second = filters::filter(ctx, &first, exit_code).text;
	(first, second)
}

mod pytest_does_not_count_its_marker_as_surviving_output {
	use super::*;

	/// A capture with nothing worth showing falls back to its last lines, and
	/// that fallback must be reached again on the second pass.
	///
	/// THE regression. Ninety blank lines produced `[…70ln elided…]` plus twenty
	/// blank lines; on the second pass the marker was counted as surviving
	/// content, the fallback did not run, and the twenty lines vanished. The
	/// same text meant two different things depending on how many times it had
	/// been filtered.
	#[test]
	fn a_blank_capture_settles_after_one_pass() {
		let config = enabled();
		let ctx = context("pytest", Some("pytest"), "pytest", &config);
		let input = "\n".repeat(90);
		let (first, second) = two_passes(&ctx, &input, 0);

		assert!(
			first.starts_with("[…70ln elided…]\n"),
			"first pass elides 70 of 90 lines, got: {first:?}"
		);
		assert_eq!(
			second, first,
			"the marker is not surviving output, so the same branch must run again"
		);
	}

	/// Real pytest output is unaffected by the rule.
	///
	/// The negative twin: the predicate now excludes annotations, and if it
	/// excluded too much a passing run would take the blank-capture fallback
	/// and hand back raw lines instead of the summary.
	#[test]
	fn a_passing_run_still_reports_its_summary() {
		let config = enabled();
		let ctx = context("pytest", Some("pytest"), "pytest", &config);
		let input = "test_a.py .\ntest_b.py .\n=== 2 passed in 0.10s ===\n";
		let (first, second) = two_passes(&ctx, input, 0);

		assert!(
			first.contains("2 passed"),
			"the summary is program output and must survive: {first:?}"
		);
		assert_eq!(second, first, "and must survive a second pass too");
	}
}

mod find_does_not_reparse_its_own_grouping {
	use super::*;

	/// The grouped listing must come back unchanged when filtered again.
	///
	/// THE regression, in two parts: the header was counted as a path, so the
	/// count grew, and the per-directory rows were parsed as paths, so a row
	/// `./ )` produced the file name ` )` and the row gained a space on every
	/// pass. The filter now recognizes its own header and stops.
	#[test]
	fn a_grouped_listing_settles_after_one_pass() {
		let config = enabled();
		let ctx = context("find", None, "find .", &config);
		let input = "./src/main.rs\n./src/lib.rs\n./tests/it.rs\n";
		let (first, second) = two_passes(&ctx, input, 0);

		assert!(first.starts_with("find: 3 paths in 2 dirs\n"), "got: {first:?}");
		assert_eq!(second, first, "re-filtering a grouped listing must not regroup it");
	}

	/// And the count stays right across several passes, since the original bug
	/// incremented it by one each time.
	#[test]
	fn the_path_count_does_not_drift_across_passes() {
		let config = enabled();
		let ctx = context("find", None, "find .", &config);
		let mut text = filters::filter(&ctx, "./a.rs\n./b.rs\n", 0).text;
		let expected = text.clone();
		for pass in 1..=4 {
			text = filters::filter(&ctx, &text, 0).text;
			assert_eq!(text, expected, "pass {pass} changed a settled listing");
		}
	}

	/// A row whose file name is punctuation is the fuzzer's reduced case, and
	/// the one that grew a space per pass.
	#[test]
	fn a_punctuation_file_name_does_not_grow_a_space_per_pass() {
		let config = enabled();
		let ctx = context("find", None, "find .", &config);
		let (first, second) = two_passes(&ctx, ")\n", 0);
		assert_eq!(second, first, "got {first:?} then {second:?}");
	}
}

mod log_compaction_does_not_leave_a_blank_run_it_created {
	use super::*;

	/// Dropping a duplicate log line must not put two blank lines back together.
	///
	/// THE regression, and a different shape to the three above: nothing here
	/// re-reads an annotation. The log filter collapses runs of blank lines on
	/// the way IN and then removes duplicate lines, and removing a line that sat
	/// between two blanks leaves those blanks adjacent, in a run the filter's
	/// own first step exists to remove. So the output still contained a blank
	/// run, and filtering it again removed it. Ordering, not misreading, but the
	/// same consequence: two answers for one text.
	#[test]
	fn a_capture_whose_duplicate_sits_between_blanks_settles_after_one_pass() {
		let config = enabled();
		let ctx = context("docker", Some("logs"), "docker logs app", &config);
		let input = "\n\nstarting\n\n\nstarting\n\n\n";
		let (first, second) = two_passes(&ctx, input, 0);

		assert!(
			!first.contains("\n\n\n"),
			"no run of blank lines may survive the first pass: {first:?}"
		);
		assert_eq!(second, first, "the filter must not find more to remove on a second pass");
	}

	/// The duplicate is still counted rather than silently dropped.
	///
	/// The negative twin: collapsing the blank run must not also swallow the
	/// repeat counter, which is the only record that the line occurred twice.
	#[test]
	fn the_duplicate_is_still_reported_as_a_repeat() {
		let config = enabled();
		let ctx = context("docker", Some("logs"), "docker logs app", &config);
		let first = filters::filter(&ctx, "\n\nstarting\n\n\nstarting\n\n\n", 0).text;
		assert!(first.contains("starting"), "the line itself survives: {first:?}");
		assert!(first.contains("(×2)"), "and its repeat count survives: {first:?}");
	}
}

mod dotnet_does_not_reread_its_failure_header {
	use super::*;

	/// The failure header must appear exactly once however often it is filtered.
	///
	/// THE regression: the header contains the word `failed`, so the failure
	/// classifier claimed it, the header was emitted again above it, and the
	/// dedup pass turned the pair into `dotnet build: failed (×2)`. A repeat
	/// counter on the minimizer's own header is a message no program printed.
	#[test]
	fn the_failure_header_is_not_counted_as_a_diagnostic() {
		let config = enabled();
		let ctx = context("dotnet", Some("build"), "dotnet build", &config);
		let (first, second) = two_passes(&ctx, "dotnet build: failed\n", 1);

		assert_eq!(first, "dotnet build: failed\n", "one header, no repeat counter");
		assert_eq!(second, first, "and still one after a second pass");
	}

	/// A real build failure keeps its diagnostics and gains the header once.
	///
	/// The negative twin: the skip is matched against the exact header this
	/// filter would emit, so an ordinary line mentioning failure must still be
	/// treated as a diagnostic.
	#[test]
	fn a_real_failure_line_is_still_kept() {
		let config = enabled();
		let ctx = context("dotnet", Some("build"), "dotnet build", &config);
		let input = "src/Program.cs(10,5): error CS1002: ; expected\nBuild FAILED.\n";
		let (first, second) = two_passes(&ctx, input, 1);

		assert!(first.starts_with("dotnet build: failed\n"), "got: {first:?}");
		assert!(first.contains("error CS1002"), "the diagnostic is program output: {first:?}");
		assert_eq!(second, first, "and the whole thing settles after one pass");
	}
}
