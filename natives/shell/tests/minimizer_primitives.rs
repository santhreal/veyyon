//! `veyyon_shell::minimizer::primitives::dedup_consecutive_lines`, the
//! repeated-line collapser that ten of the built-in output filters run.
//!
//! WHY THIS SUITE EXISTS. The collapser annotated a run of identical lines as
//! `line (×N)`, and applied that to blank lines too. So two blank lines came
//! back as a line reading ` (×2)`: not a shorter version of the input, an
//! invented message that no program printed. Blank lines separate sections in
//! the output of cargo, tsc, eslint, git, and gh, which is most of what the
//! shell tool captures, so the marker was being spliced into ordinary output
//! and read back to the agent as though a tool had emitted it.
//!
//! It slipped through because every fixture in the suite was realistic program
//! output, where the blank lines are incidental and nobody was asserting on
//! them. `fuzz/fuzz_targets/minimizer_lint_condense.rs` found it by noticing
//! that two bytes of input had become seven bytes of output.
//!
//! A note on that property, because it is stated carefully below and the care
//! is the point. "Never grows in bytes" is not true in general: collapsing
//! `a\na\n` to `a (×2)\n` grows it, and correctly so, since the counter costs
//! six bytes and tells you the program repeated itself. What is universally
//! true is that the LINE count never grows, and what is true for blank runs
//! specifically is that the byte count never grows, because there the
//! annotation carries no information at all. Both are asserted, at those
//! precisions.
//!
//! The cases below pin the exact output string, because the bug was in what the
//! function wrote, not in whether it returned.

use veyyon_shell::minimizer::primitives::dedup_consecutive_lines;

mod blank_lines {
	use super::*;

	/// The reproducer. Two blank lines are one blank line, with no counter.
	#[test]
	fn two_blank_lines_collapse_to_one_and_carry_no_count() {
		assert_eq!(dedup_consecutive_lines("\n\n"), "\n");
	}

	/// The property that caught it, stated directly: collapsing blank lines
	/// never produces more bytes than it was given.
	#[test]
	fn collapsing_blank_lines_never_grows_the_output() {
		for count in 1..=8 {
			let input = "\n".repeat(count);
			let output = dedup_consecutive_lines(&input);

			assert!(
				output.len() <= input.len(),
				"{count} blank lines grew from {} to {} bytes: {output:?}",
				input.len(),
				output.len(),
			);
		}
	}

	/// A long run collapses to a single blank line rather than to a count.
	#[test]
	fn a_long_run_of_blank_lines_collapses_to_one() {
		assert_eq!(dedup_consecutive_lines("\n\n\n\n\n\n"), "\n");
	}

	/// Whitespace-only lines are blank to a reader, so they get the same
	/// treatment. The line's own characters are preserved; only the counter is
	/// suppressed.
	#[test]
	fn whitespace_only_lines_collapse_without_a_count() {
		assert_eq!(dedup_consecutive_lines("   \n   \n"), "   \n");
		assert_eq!(dedup_consecutive_lines("\t\n\t\n\t\n"), "\t\n");
	}

	/// The marker must not appear anywhere in the output for blank input.
	/// Checked as a substring as well as by equality, because a future change
	/// that moves the annotation elsewhere in the line would still be wrong.
	#[test]
	fn no_repeat_marker_is_emitted_for_blank_runs() {
		for input in ["\n\n", "\n\n\n", " \n \n", "\t\t\n\t\t\n"] {
			let output = dedup_consecutive_lines(input);

			assert!(!output.contains('×'), "{input:?} produced a repeat marker: {output:?}");
		}
	}

	/// Blank lines between real content stay a separator and do not swallow the
	/// content around them.
	#[test]
	fn blank_lines_between_content_remain_a_separator() {
		assert_eq!(dedup_consecutive_lines("first\n\n\nsecond\n"), "first\n\nsecond\n");
	}
}

mod repeated_content {
	use super::*;

	/// The feature the function exists for, unchanged. A program that printed
	/// the same warning four times gets one line and a count, and the count is
	/// the information worth keeping.
	#[test]
	fn repeated_content_lines_are_collapsed_with_a_count() {
		assert_eq!(dedup_consecutive_lines("warn\nwarn\nwarn\nwarn\n"), "warn (×4)\n");
	}

	/// Two occurrences count, so the threshold is "more than one" and not some
	/// higher number.
	#[test]
	fn two_identical_lines_are_counted() {
		assert_eq!(dedup_consecutive_lines("warn\nwarn\n"), "warn (×2)\n");
	}

	/// A single line is passed through untouched, with no marker.
	#[test]
	fn a_single_line_is_left_alone() {
		assert_eq!(dedup_consecutive_lines("warn\n"), "warn\n");
	}

	/// Only CONSECUTIVE repeats collapse. Two occurrences either side of a
	/// different line are two separate runs, because collapsing them would move
	/// output out of the order the program printed it.
	#[test]
	fn non_consecutive_repeats_are_not_merged() {
		assert_eq!(dedup_consecutive_lines("a\nb\na\n"), "a\nb\na\n");
	}

	/// Runs of content and runs of blanks in the same input, each handled by its
	/// own rule. This is the shape real lint output has.
	#[test]
	fn a_mixed_input_applies_each_rule_where_it_belongs() {
		let input = "error: x\nerror: x\n\n\nnote: y\n";

		assert_eq!(dedup_consecutive_lines(input), "error: x (×2)\n\nnote: y\n");
	}

	/// Empty input produces empty output rather than a stray newline.
	#[test]
	fn empty_input_produces_empty_output() {
		assert_eq!(dedup_consecutive_lines(""), "");
	}

	/// Input without a trailing newline gains one, which is the documented
	/// normalization and is what the callers splice together.
	#[test]
	fn a_missing_trailing_newline_is_added() {
		assert_eq!(dedup_consecutive_lines("only"), "only\n");
	}
}

mod line_endings {
	use super::*;

	/// The reproducer for the second bug this suite covers, found by the same
	/// fuzz target from a different property: `group_diagnostics` was not
	/// idempotent, returning `"\r\n\n"` on one pass and `"\n"` on the next.
	///
	/// WHY IT HAPPENED. `str::lines` strips ONE carriage return before the
	/// newline, and this function writes every line back terminated by a bare
	/// `\n`. So each pass ate one more `\r` and the result depended on how many
	/// times the filter chain had run.
	#[test]
	fn collapsing_is_idempotent_for_repeated_carriage_returns() {
		let once = dedup_consecutive_lines("\r\r\n\n");
		let twice = dedup_consecutive_lines(&once);

		assert_eq!(once, "\n", "both lines are blank once the carriage returns are gone");
		assert_eq!(twice, once, "a second pass must find nothing left to do");
	}

	/// The case that matters more than the fixed point: CRLF output did not
	/// collapse at all, because `warn\r` and `warn` compare unequal. This
	/// project runs on Windows, where every tool writes CRLF.
	#[test]
	fn crlf_output_collapses_the_same_as_lf_output() {
		assert_eq!(dedup_consecutive_lines("warn\r\nwarn\r\nwarn\r\n"), "warn (×3)\n");
		assert_eq!(dedup_consecutive_lines("warn\nwarn\nwarn\n"), "warn (×3)\n");
	}

	/// Mixed endings in one capture, which is what you get when a tool writes
	/// CRLF and the harness appends LF. Both spellings of the line are the same
	/// line and count together.
	#[test]
	fn mixed_endings_are_one_run_and_not_two() {
		assert_eq!(dedup_consecutive_lines("error: x\r\nerror: x\n"), "error: x (×2)\n");
	}

	/// A carriage return inside the line is left alone. Progress bars redraw
	/// with `\r` mid-line and that content is real output, not a line
	/// terminator.
	#[test]
	fn a_carriage_return_inside_the_line_is_preserved() {
		assert_eq!(dedup_consecutive_lines("10%\r20%\r30%\n"), "10%\r20%\r30%\n");
	}

	/// A lone carriage return at the end of the input normalizes the same way a
	/// missing newline does, rather than surviving as a stray byte.
	#[test]
	fn a_trailing_carriage_return_normalizes_to_a_newline() {
		assert_eq!(dedup_consecutive_lines("only\r"), "only\n");
	}
}

mod the_size_contract {
	use super::*;

	/// The universal contract: collapsing never produces more LINES than it was
	/// given. That is what the minimizer is actually reducing, and it holds for
	/// every input.
	///
	/// WHY LINES AND NOT BYTES. Bytes are not monotone here, and correctly so.
	/// Collapsing `a\na\n` yields `a (×2)\n`, which is four bytes in and seven
	/// out, because the counter costs six bytes and a one-character line
	/// repeated twice does not save that much. The count is real information
	/// about what the program printed, so paying six bytes for it is the right
	/// trade and a blanket "never grows in bytes" rule would be asserting the
	/// feature away. The byte rule is still exactly right for blank runs, where
	/// the annotation carries no information at all, and that case is asserted
	/// below.
	#[test]
	fn collapsing_never_produces_more_lines_than_it_was_given() {
		let inputs = [
			"",
			"\n",
			"\n\n",
			" \n \n \n",
			"a\na\n",
			"a\nb\nc\n",
			"error: x\nerror: x\n\n\nerror: x\n",
			"warning: unused\nwarning: unused\nwarning: unused\n",
			"\n\n\n\n\n\n\n\n\n\n",
		];

		for input in inputs {
			let output = dedup_consecutive_lines(input);

			assert!(
				output.lines().count() <= input.lines().count(),
				"{input:?} grew from {} to {} lines: {output:?}",
				input.lines().count(),
				output.lines().count(),
			);
		}
	}

	/// The byte rule, stated where it is true: whitespace-only input can never
	/// grow, because there is nothing in it worth annotating.
	///
	/// This is the exact property the fuzzer used to find the bug, kept at the
	/// precision that makes it sound. Blank and whitespace-only runs are the
	/// common case in real program output, so this covers the shape that
	/// matters.
	///
	/// Compared against the input's NORMALIZED length. The function terminates
	/// every line it emits, so input that did not end in a newline comes back
	/// one byte longer: `" "` becomes `" \n"`. That is the documented behaviour
	/// and is what the callers splice together, and the fuzzer reported it as
	/// growth until the rule was stated this way.
	#[test]
	fn whitespace_only_input_never_grows_in_bytes() {
		let inputs = [
			"",
			"\n",
			"\n\n",
			"\n\n\n\n\n\n\n\n\n\n",
			" \n \n \n",
			"\t\n\t\n",
			"  \n\n  \n",
			" ",
			"\t",
			"   ",
		];

		for input in inputs {
			let output = dedup_consecutive_lines(input);
			let normalized = if input.is_empty() || input.ends_with('\n') {
				input.len()
			} else {
				input.len() + 1
			};

			assert!(
				output.len() <= normalized,
				"{input:?} grew from {normalized} normalized bytes to {} bytes: {output:?}",
				output.len(),
			);
		}
	}

	/// The normalization itself, pinned so the rule above is not silently
	/// absorbing a real regression. A whitespace-only line gains exactly its
	/// terminator and nothing else.
	#[test]
	fn a_whitespace_line_gains_only_its_terminator() {
		assert_eq!(dedup_consecutive_lines(" "), " \n");
		assert_eq!(dedup_consecutive_lines("\t"), "\t\n");
		assert_eq!(dedup_consecutive_lines("   "), "   \n");
	}

	/// And the case the counter exists for: a line long enough that collapsing
	/// it genuinely saves bytes must actually save them.
	#[test]
	fn collapsing_a_repeated_diagnostic_saves_bytes() {
		let input = "warning: unused variable `x`\n".repeat(20);

		let output = dedup_consecutive_lines(&input);

		assert_eq!(output, "warning: unused variable `x` (×20)\n");
		assert!(output.len() < input.len() / 10, "collapsing 20 copies should be a large saving");
	}

	/// Idempotence. Filters chain, and output that has already been collapsed
	/// can be collapsed again by a wrapper or a replayed capture; a second pass
	/// must find nothing left to do rather than annotate its own annotations.
	#[test]
	fn collapsing_twice_is_the_same_as_collapsing_once() {
		let inputs = ["\n\n", "a\na\n", "error: x\nerror: x\n\n\nnote\n", "   \n   \n"];

		for input in inputs {
			let once = dedup_consecutive_lines(input);
			let twice = dedup_consecutive_lines(&once);

			assert_eq!(twice, once, "a second pass changed the output of {input:?}");
		}
	}
}
