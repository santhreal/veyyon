//! Every line the minimizer writes is recognized as one the minimizer wrote.
//!
//! WHY THIS SUITE EXISTS. `primitives::is_minimizer_annotation` is the one
//! answer to "did we write this line?", and almost every idempotence fix in
//! this crate leans on it. Filters chain, wrappers re-filter what they wrapped,
//! and captures get replayed, so a filter reads its own output as a matter of
//! course. When it does, an annotation it fails to recognize is read as program
//! output, and the results have been bad in every direction: entries deleted as
//! noise, repeat counters counted as repeats, tallies counted as data, elision
//! markers counted as the lines they stand for.
//!
//! THE HAZARD THIS LOCKS OUT. The predicate lists shapes, and the shapes are
//! WRITTEN somewhere else. Nothing but this file makes a new annotation shape
//! declare itself, so the failure mode is silent and slow: someone adds a
//! summary line to a filter, every existing test passes, and the shape is only
//! noticed months later when a fuzzer finds output that changes on a second
//! pass. That is exactly how `N rows`, `N diagnostics in M files` and the
//! `path (N diagnostics)` rows were each found, one at a time.
//!
//! HOW IT IS TESTED. Through the REAL filters wherever the annotation has a
//! filter that emits it, so the string asserted here is the string the filter
//! produces rather than one written twice. A hand-written literal would pass
//! forever after the writer changed.

use veyyon_shell::minimizer::{filters, primitives, primitives::is_minimizer_annotation};

mod common;

use common::{context, enabled, lines};

/// Every line of `text` that `predicate` picks out must be recognized as ours.
fn assert_recognized(text: &str, predicate: impl Fn(&str) -> bool, what: &str) {
	let matches: Vec<&str> = text.lines().filter(|line| predicate(line)).collect();
	assert!(!matches.is_empty(), "no {what} was produced, so nothing was tested: {text:?}");
	for line in matches {
		assert!(
			is_minimizer_annotation(line),
			"{what} {line:?} is not recognized as an annotation, so the next pass will read it as \
			 program output"
		);
	}
}

mod shapes_the_primitives_write {
	use super::*;

	/// `line (×N)` from `dedup_consecutive_lines`.
	///
	/// The first one that bit: `0 (×2)` is shaped exactly like a tsc code-frame
	/// body line, so re-condensing it returned the empty string.
	#[test]
	fn the_repeat_counter_is_recognized() {
		let deduped = primitives::dedup_consecutive_lines("boom\nboom\nboom\n");
		assert_eq!(deduped, "boom (×3)\n", "sanity: the shape under test");
		assert_recognized(&deduped, |line| line.contains('×'), "repeat counter");
	}

	/// `[…Nln elided…]` from the head/tail capping helpers.
	#[test]
	fn the_line_elision_marker_is_recognized() {
		let input = lines(200, |n| format!("line {n}\n"));
		let capped = primitives::head_tail_lines(&input, 10, 10);
		assert_recognized(&capped, |line| line.contains("elided"), "elision marker");
	}

	/// The grouped-by-file header and its entries.
	///
	/// The header ends in a colon and the entries are indented, so neither is an
	/// annotation by the `is_minimizer_annotation` rules; the listing is
	/// recognized as a whole by `is_grouped_listing` instead. Asserted here so
	/// the division of labour is on the record: a future change that tries to
	/// make the header an annotation would break the grouping, because
	/// `group_diagnostics` passes annotations through ungrouped.
	#[test]
	fn a_grouped_listing_is_recognized_by_its_own_predicate_not_this_one() {
		let grouped = primitives::group_by_file("a.rs:1:1: boom\na.rs:2:2: bang\n", 20);
		assert!(
			primitives::is_grouped_listing(&grouped),
			"the listing predicate claims it: {grouped:?}"
		);
		assert!(!is_minimizer_annotation("a.rs:"), "the header alone is not an annotation");
	}
}

mod shapes_the_filters_write {
	use super::*;

	/// `N diagnostics in M files` and the per-file `path (N diagnostics)` rows.
	#[test]
	fn the_lint_condense_headers_are_recognized() {
		let config = enabled();
		let ctx = context("biome", Some("check"), "biome check .", &config);
		let input = "a.ts:1:1: lint/a  bad\na.ts:2:1: lint/b  worse\nb.ts:3:1: lint/c  worst\n";
		let condensed = filters::filter(&ctx, input, 1).text;

		assert_recognized(
			&condensed,
			|line| line.contains(" diagnostics in "),
			"diagnostic count header",
		);
		assert_recognized(
			&condensed,
			|line| line.ends_with(" diagnostics)"),
			"per-file diagnostic row",
		);
	}

	/// `Top codes:` from the lint code summary.
	#[test]
	fn the_top_codes_summary_is_recognized() {
		let config = enabled();
		let ctx = context("tsc", None, "tsc --noEmit", &config);
		let input = "a.ts(1,1): error TS2322: Type 'string' is not assignable to type \
		             'number'.\nb.ts(2,2): error TS2322: Type 'string' is not assignable to type \
		             'number'.\nc.ts(3,3): error TS2304: Cannot find name 'foo'.\n";
		let condensed = filters::filter(&ctx, input, 2).text;

		assert_recognized(&condensed, |line| line.starts_with("Top codes: "), "code summary");
	}

	/// `find: N paths in M dirs` from the listing filter.
	#[test]
	fn the_find_summary_header_is_recognized() {
		let config = enabled();
		let ctx = context("find", None, "find .", &config);
		let listed = filters::filter(&ctx, "./src/main.rs\n./src/lib.rs\n./tests/it.rs\n", 0).text;

		assert_recognized(&listed, |line| line.starts_with("find: "), "find summary header");
	}

	/// `N rows` from the docker table compactor.
	#[test]
	fn the_row_tally_is_recognized() {
		let config = enabled();
		let ctx = context("docker", Some("ps"), "docker ps -a", &config);
		let input = format!(
			"CONTAINER ID   IMAGE   STATUS\n{}",
			lines(40, |n| format!("c{n:04}          nginx   Up\n"))
		);
		let capped = filters::filter(&ctx, &input, 0).text;

		assert_recognized(&capped, |line| line.trim().ends_with(" rows"), "row tally");
		assert_recognized(&capped, |line| line.contains("rows elided"), "row elision marker");
	}

	/// `N entries` from the plain-listing compactor.
	///
	/// Written by `primitives::compact_listing`, which every listing arm reaches
	/// for output it cannot parse into a structured listing. It counted its own
	/// tally as an entry until this shape was claimed.
	#[test]
	fn the_entry_tally_is_recognized() {
		let input = lines(100, |n| format!("./path/to/file{n:03}.rs\n"));
		let listed = primitives::compact_listing(&input, 20);

		assert_recognized(&listed, |line| line.trim().ends_with(" entries"), "entry tally");
	}

	/// `log summary: …` from the log compactor.
	///
	/// The one that mattered most of the three found together: this header
	/// contains the word "error", and the compactor counts every line containing
	/// it as an error, so leaving the shape unclaimed made a second pass report
	/// an error the program had never logged.
	#[test]
	fn the_log_summary_header_is_recognized() {
		let config = enabled();
		let ctx = context("log", None, "log", &config);
		let input = lines(100, |n| format!("event {n} happened\n"));
		let summarized = filters::filter(&ctx, &input, 0).text;

		assert_recognized(
			&summarized,
			|line| line.starts_with("log summary: "),
			"log summary header",
		);
	}

	/// `N files, M dirs` from the directory-listing tally.
	///
	/// The tally only appears for the LONG form, because it is derived from the
	/// permission and size columns; a bare `ls` has nothing to count.
	#[test]
	fn the_directory_tally_is_recognized() {
		let config = enabled();
		let ctx = context("ls", None, "ls -la", &config);
		let input = format!(
			"total 928\ndrwxr-xr-x  6 user staff 192 2 feb 21:35 discover\n{}",
			lines(25, |n| format!(
				"-rw-r--r--  1 user staff {} 2 feb 21:35 file{n:03}.rs\n",
				1024 * n
			))
		);
		let listed = filters::filter(&ctx, &input, 0).text;

		assert_recognized(
			&listed,
			|line| line.contains(" files, ") && line.contains("dirs"),
			"directory tally",
		);
	}
}

mod the_predicate_does_not_overreach {
	use super::*;

	/// Ordinary program output is not claimed.
	///
	/// The negative twin for the whole suite, and it matters more than it looks:
	/// a line wrongly claimed as ours is a line the filters refuse to strip,
	/// group, or count, so over-claiming quietly turns minimization off for the
	/// captures that contain it.
	#[test]
	fn ordinary_diagnostics_are_not_claimed() {
		for line in [
			"src/main.rs:10:5: error[E0308]: mismatched types",
			"error: could not compile `veyyon-shell` (lib test)",
			"warning: unused variable: `x`",
			"Compiling veyyon-shell v1.0.37",
			"",
			"    Finished `test` profile in 2.91s",
		] {
			assert!(!is_minimizer_annotation(line), "{line:?} is program output, not ours");
		}
	}

	/// A program's own count of rows or files is not claimed.
	///
	/// These are the near misses, and they are where over-claiming would come
	/// from: psql's `(13 rows)`, a linter's `Checked 42 files`, and a test
	/// runner's `3 files, 0 failures` all sit one shape away from an annotation.
	#[test]
	fn the_programs_own_summaries_are_not_claimed() {
		for line in [
			"(13 rows)",
			"(1 row)",
			"Checked 42 files",
			"deleted 13 rows",
			"13 rows affected",
			"3 problems in 2 files",
			"Top of the stack:",
			"package tree/list: 91 entries",
			"removed 4 entries",
			"log summary follows",
		] {
			assert!(!is_minimizer_annotation(line), "{line:?} is the program's own summary");
		}
	}
}

mod the_diff_summary {
	use super::*;

	/// `--- Changes ---` from the diff compactor.
	///
	/// THE WORST SHAPE IN THE SET, because it is not merely unrecognized, it is
	/// read as the WRONG thing: the header opens with `--- `, which is a
	/// unified-diff file marker, so a second pass parsed it as a file named
	/// `Changes ---`. A two-file diff came back claiming `1 file changed` with
	/// the second file's name spliced onto the first, and nothing about the
	/// output looked wrong. Found by `fuzz/fuzz_targets/minimizer_filters.rs`.
	#[test]
	fn the_changes_header_is_recognized() {
		let config = enabled();
		let ctx = context("git", Some("diff"), "git diff", &config);
		let input =
			"diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -1,2 +1,3 @@\n line\n+added\n";
		let compacted = filters::filter(&ctx, input, 0).text;

		assert_recognized(&compacted, |line| line.trim() == "--- Changes ---", "diff changes header");
	}

	/// And the compactor leaves its own summary alone.
	///
	/// The guard and the predicate are two halves of one rule, so both are
	/// asserted: recognizing the line is no use if the filter reshapes it
	/// anyway.
	#[test]
	fn a_compacted_diff_is_not_compacted_again() {
		let config = enabled();
		let ctx = context("git", Some("diff"), "git diff", &config);
		let input = "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -1,2 +1,3 @@\n \
		             line\n+added\ndiff --git a/b.rs b/b.rs\n--- a/b.rs\n+++ b/b.rs\n@@ -1,2 +1,3 \
		             @@\n line\n+added\n";
		let first = filters::filter(&ctx, input, 0).text;
		assert!(first.contains("2 files changed"), "sanity: two files went in: {first:?}");

		let second = filters::filter(&ctx, &first, 0).text;
		assert_eq!(second, first, "the summary must survive a second pass unchanged");
		assert!(second.contains("2 files changed"), "and must not lose a file: {second:?}");
	}
}
