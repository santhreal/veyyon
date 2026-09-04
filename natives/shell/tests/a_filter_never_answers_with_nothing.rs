//! A command that printed something is never minimized down to nothing.
//!
//! WHY THIS IS THE WORST FAILURE THE MINIMIZER HAS. Every other defect gives
//! the agent a worse answer. This one gives it no answer, and an empty capture
//! is indistinguishable from a command that was quiet. The agent then reasons
//! about a silent success that never happened, and the output that would have
//! corrected it is gone. There is nothing in the transcript to notice.
//!
//! HOW IT HAPPENED. The table reshapers drop border lines on the way in
//! (`+---+---+`, `-----+-----`) and normalize what is left. Normalizing can
//! turn a line INTO a border: `aws` reduced `"-----+-- ---------\t|"` to
//! `"-----+-- ---------"`, which is nothing but dashes, pluses and spaces, so
//! the next pass classified it as a border, dropped it, and answered with the
//! empty string. Filters chain and captures get replayed, so a second pass is
//! an ordinary event, not a corner case.
//!
//! THE RULE NOW. `primitives::or_original` is the single owner: a compaction
//! that empties a non-empty capture is discarded and the capture is kept. That
//! is not a silent fallback. The dispatcher compares the result against its
//! input, so keeping the capture makes the output report itself as a
//! PASSTHROUGH rather than as a rewrite, and the telemetry says plainly that
//! this filter declined to minimize. Found by
//! `fuzz/fuzz_targets/minimizer_filters.rs`, which asserts this separately from
//! its idempotence property precisely because it is the consequence that
//! matters.

use veyyon_shell::minimizer::{filters, primitives::or_original};

mod common;

use common::{context, enabled};

mod the_rule_itself {
	use super::*;

	/// A compaction that emptied a non-empty capture is discarded.
	#[test]
	fn an_emptied_compaction_gives_the_capture_back() {
		assert_eq!(or_original(String::new(), "+---+\n"), "+---+\n");
	}

	/// Whitespace is not content, so a compaction down to whitespace counts as
	/// empty too.
	///
	/// A blank line and no line are the same answer to the agent, and a rule
	/// that only checked for the empty string would be walked around by any path
	/// that emits a trailing newline.
	#[test]
	fn a_compaction_down_to_whitespace_also_gives_the_capture_back() {
		assert_eq!(or_original("\n\n  \n".to_string(), "data\n"), "data\n");
	}

	/// A capture that was itself empty stays empty.
	///
	/// The boundary in the other direction: a quiet command really did print
	/// nothing, and inventing output for it would be its own lie.
	#[test]
	fn an_empty_capture_stays_empty() {
		assert_eq!(or_original(String::new(), ""), "");
		assert_eq!(or_original(String::new(), "   \n\n"), "");
	}

	/// A real compaction is left exactly as it is.
	///
	/// The negative twin, and the one that matters for size: the guard must not
	/// second-guess a compaction that produced something.
	#[test]
	fn a_compaction_that_kept_content_is_untouched() {
		assert_eq!(
			or_original("id\tname\n1\tada\n".to_string(), "a hundred lines of table\n"),
			"id\tname\n1\tada\n"
		);
	}

	/// Even a single character counts as content.
	#[test]
	fn one_character_is_enough_to_count_as_content() {
		assert_eq!(or_original("x".to_string(), "a much longer capture\n"), "x");
	}

	/// A compaction holding ONLY the minimizer's own annotations counts as
	/// nothing.
	///
	/// The annotations describe output that is no longer there, so keeping them
	/// and dropping everything else is the same answer as keeping nothing.
	/// Checking bytes alone made the decision depend on whether an earlier pass
	/// had happened to leave an annotation in the capture, so the same text
	/// compacted one way on the first pass and another on the second.
	#[test]
	fn a_compaction_of_only_annotations_gives_the_capture_back() {
		assert_eq!(or_original("[…5ln elided…]\n".to_string(), "a\nb\nc\n"), "a\nb\nc\n");
		assert_eq!(or_original("line (×2)\n".to_string(), "a\nb\n"), "a\nb\n");
	}

	/// One real line alongside an annotation is content, and is kept.
	///
	/// The boundary: the rule is about a compaction that kept NOTHING of the
	/// program's, not about one that annotated what it kept.
	#[test]
	fn an_annotation_next_to_real_output_is_still_content() {
		let compacted = "error: boom\n[…5ln elided…]\n".to_string();
		assert_eq!(or_original(compacted.clone(), "a hundred lines\n"), compacted);
	}

	/// A capture that is itself nothing but annotations is still a capture.
	///
	/// This test asserted the opposite, on the reasoning that handing back an
	/// original with no program content in it says nothing. That was wrong twice
	/// over. It says more than the empty string does: a marker stands in for
	/// output that was dropped, and `[…5ln elided…]` tells a reader five lines
	/// were there. And exempting those captures made the answer depend on how
	/// many passes had run, which is the defect the guard exists to prevent. A
	/// psql table of only borders compacts to nothing, so the capture stands,
	/// the dedup after it leaves one repeat counter and nothing else, and on the
	/// next pass the reshaper kept that counter, the exemption let it through,
	/// and the line the first pass had kept was gone. See
	/// `a_salvaged_nothing_is_not_a_compaction.rs`.
	#[test]
	fn an_original_of_only_annotations_is_given_back() {
		assert_eq!(or_original(String::new(), "[…5ln elided…]\n"), "[…5ln elided…]\n");
		assert_eq!(or_original(String::new(), "line (×2)\n"), "line (×2)\n");
	}

	/// The boundary that keeps the rule from firing on every quiet command: a
	/// capture that really was empty is answered empty, not reported as a
	/// passthrough of nothing.
	#[test]
	fn a_capture_that_printed_nothing_is_still_answered_with_nothing() {
		assert_eq!(or_original(String::new(), ""), "");
		assert_eq!(or_original(String::new(), " \n\t\n"), "");
	}
}

mod annotations_are_not_table_rows {
	use super::*;

	/// THE regression, as the fuzzer reduced it.
	///
	/// A capture of nothing but pipes and a border declines to compact, and the
	/// dedup that follows collapses its two identical lines into `| (×2)`. On
	/// the next pass the table compactor read that repeat counter as a row,
	/// split it on its pipes into `"\t(×2)"`, and threw the rest of the capture
	/// away. Two fixes meet here: the compactors pass an annotation through
	/// verbatim instead of reshaping it, and `or_original` counts a compaction
	/// of only annotations as nothing.
	#[test]
	fn a_repeat_counter_is_not_reshaped_into_a_row() {
		let config = enabled();
		let ctx = context("psql", Some("status"), "psql -c 'select 1'", &config);
		let first = filters::filter(&ctx, "|\n|||\n-+----\n|\n|\n", 2).text;
		assert!(first.contains("(×2)"), "the dedup counter is written: {first:?}");

		let second = filters::filter(&ctx, &first, 2).text;
		assert!(!second.starts_with('\t'), "the counter must not be split into cells: {second:?}");
		assert_eq!(second, first, "and the capture must not be thrown away");
	}

	/// A real table alongside a counter keeps both.
	///
	/// The negative twin: passing annotations through must not stop the rows
	/// around them from being reshaped.
	#[test]
	fn a_counter_inside_a_real_table_does_not_stop_the_reshaping() {
		let config = enabled();
		let ctx = context("psql", Some("log"), "psql -c 'select id, name from users'", &config);
		let input = " id | name \n----+------\n  1 | ada\nsomething (×2)\n  2 | grace\n(2 rows)\n";
		let first = filters::filter(&ctx, input, 0).text;

		assert!(first.contains("1\tada"), "the rows are still reshaped: {first:?}");
		assert!(first.contains("something (×2)"), "and the counter survives verbatim: {first:?}");

		let second = filters::filter(&ctx, &first, 0).text;
		assert_eq!(second, first, "and the whole thing settles after one pass");
	}
}

mod the_aws_table_path {
	use super::*;

	/// THE regression, as the fuzzer reduced it.
	///
	/// The capture looks like a table because it contains `-+-`, and every line
	/// in it reduces to a border. Before the guard the second pass answered with
	/// nothing at all.
	#[test]
	fn a_capture_of_nothing_but_borders_is_kept_rather_than_deleted() {
		let config = enabled();
		let ctx = context("aws", Some("ec2"), "aws ec2 describe-instances", &config);
		let first = filters::filter(&ctx, "-----+-- ---------\t|\n", 143).text;
		assert!(!first.trim().is_empty(), "the first pass must not answer with nothing: {first:?}");

		let second = filters::filter(&ctx, &first, 143).text;
		assert!(!second.trim().is_empty(), "and neither must the second: {second:?}");
		assert_eq!(second, first, "the answer must not depend on how many passes have run");
	}

	/// And it stays that way over several passes.
	#[test]
	fn a_border_only_capture_stays_fixed_across_repeated_passes() {
		let config = enabled();
		let ctx = context("aws", Some("ec2"), "aws ec2 describe-instances", &config);
		let mut text = filters::filter(&ctx, "-----+-- ---------\t|\n", 143).text;
		let expected = text.clone();
		for pass in 1..=4 {
			text = filters::filter(&ctx, &text, 143).text;
			assert_eq!(text, expected, "pass {pass} rewrote a settled capture");
		}
	}

	/// A real aws table is still compacted, which is what the filter is for.
	///
	/// The negative twin for the whole guard: if it fired on ordinary tables the
	/// minimizer would stop minimizing the exact output it was written for, and
	/// nothing else in the suite would notice.
	#[test]
	fn a_real_table_is_still_compacted() {
		let config = enabled();
		let ctx = context("aws", Some("ec2"), "aws ec2 describe-instances --output table", &config);
		let input = "+--------------+----------+\n|  InstanceId  |  State   \
		             |\n+--------------+----------+\n|  i-0abc      |  running |\n|  i-0def      |  \
		             stopped |\n+--------------+----------+\n";
		let first = filters::filter(&ctx, input, 0).text;

		assert!(first.contains("InstanceId\tState"), "the header is reshaped: {first:?}");
		assert!(first.contains("i-0abc\trunning"), "and the rows: {first:?}");
		assert!(!first.contains("+------"), "the borders are dropped: {first:?}");
		assert!(first.len() < input.len(), "and the whole point is that it got smaller");

		let second = filters::filter(&ctx, &first, 0).text;
		assert_eq!(second, first, "and it settles after one pass");
	}
}

mod the_psql_table_path {
	use super::*;

	/// The same guard on the psql reshaper, reached by its own detector.
	#[test]
	fn a_border_only_psql_capture_is_kept_rather_than_deleted() {
		let config = enabled();
		let ctx = context("psql", Some("log"), "psql -c 'select 1'", &config);
		let first = filters::filter(&ctx, "----+----\n|\n", 0).text;
		assert!(!first.trim().is_empty(), "the first pass must not answer with nothing: {first:?}");

		let second = filters::filter(&ctx, &first, 0).text;
		assert!(!second.trim().is_empty(), "and neither must the second: {second:?}");
		assert_eq!(second, first, "and the two passes must agree");
	}

	/// A real result set is still compacted.
	#[test]
	fn a_real_result_set_is_still_compacted() {
		let config = enabled();
		let ctx = context("psql", Some("log"), "psql -c 'select id, name from users'", &config);
		let input = " id | name  \n----+-------\n  1 | ada\n  2 | grace\n(2 rows)\n";
		let first = filters::filter(&ctx, input, 0).text;

		assert!(first.contains("1\tada"), "got: {first:?}");
		assert!(!first.contains("----+"), "the border is dropped: {first:?}");
		assert!(first.len() < input.len(), "and it got smaller");
	}
}
