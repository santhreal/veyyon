//! Deduping a line that already carries a repeat counter multiplies it.
//!
//! WHAT IT DID. `dedup_consecutive_lines` collapses a run of identical lines
//! into one line plus `(×n)`. Feed it its own output and the repeated line is
//! `warn (×3)`, which it treated as an ordinary line and annotated again,
//! producing `warn (×3) (×2)`. That says nothing an operator can read: three,
//! two, five, six? And it grows another bracket on every pass, so a capture
//! replayed four times reads `warn (×3) (×2) (×2) (×2)`.
//!
//! It is the same self-consumption shape as the filters that ate their own
//! output, in the primitive every one of them calls. See
//! `a_salvaged_nothing_is_not_a_compaction.rs` and
//! `an_escape_does_not_hide_a_carriage_return.rs`.
//!
//! THE RULE NOW. Two runs of three identical lines is six identical lines, so
//! the answer is `warn (×6)`: exactly what the capture would have said had it
//! been minimized once instead of twice. The counter is a count of ORIGINAL
//! lines, and that reading is what makes the operation composable.
//!
//! Found by `fuzz/fuzz_targets/minimizer_primitives.rs`, artifact
//! `crash-af260edc80e597cc317a64bb3b5657df3daf3f24`.

use veyyon_shell::minimizer::primitives;

mod the_capture_that_found_it {
	use super::*;

	/// THE regression, as the fuzzer reduced it.
	#[test]
	fn two_already_counted_lines_become_one_counter() {
		let input = "the same line (×3)\nthe same line (×3)\n";

		assert_eq!(primitives::dedup_consecutive_lines(input), "the same line (×6)\n");
	}

	/// The counters do not stack, stated directly, because the stacking is what
	/// an operator actually saw.
	#[test]
	fn no_second_bracket_is_ever_appended() {
		let output = primitives::dedup_consecutive_lines("warn (×3)\nwarn (×3)\n");

		assert!(!output.contains(") (×"), "counters must not stack: {output:?}");
	}

	/// And the count is right after any number of passes, which is the property
	/// that makes the operation composable at all.
	#[test]
	fn the_count_survives_repeated_passes() {
		let once = primitives::dedup_consecutive_lines("warn\nwarn\nwarn\n");
		assert_eq!(once, "warn (×3)\n");

		let twice = primitives::dedup_consecutive_lines(&format!("{once}{once}"));
		assert_eq!(twice, "warn (×6)\n");

		let thrice = primitives::dedup_consecutive_lines(&format!("{twice}{twice}"));
		assert_eq!(thrice, "warn (×12)\n");
	}
}

mod what_the_counter_counts {
	use super::*;

	/// A counted line appearing once keeps its count unchanged. Multiplying by
	/// one is the identity, and getting this wrong would inflate every capture
	/// that merely passed through twice without repeating.
	#[test]
	fn a_lone_counted_line_is_unchanged() {
		assert_eq!(primitives::dedup_consecutive_lines("warn (×3)\n"), "warn (×3)\n");
	}

	/// Three occurrences of a line already standing for four is twelve.
	#[test]
	fn three_runs_of_four_is_twelve() {
		let input = "warn (×4)\nwarn (×4)\nwarn (×4)\n";

		assert_eq!(primitives::dedup_consecutive_lines(input), "warn (×12)\n");
	}

	/// Ordinary deduping is untouched, which is the case that runs every time.
	#[test]
	fn an_uncounted_run_still_gets_its_first_counter() {
		assert_eq!(primitives::dedup_consecutive_lines("a\na\na\nb\n"), "a (×3)\nb\n");
	}

	/// Lines that differ are not merged just because both carry counters.
	#[test]
	fn two_different_counted_lines_stay_apart() {
		let input = "warn (×3)\nerror (×2)\n";

		assert_eq!(primitives::dedup_consecutive_lines(input), input);
	}
}

mod what_is_not_a_counter {
	use super::*;

	/// A program that prints its own parenthesized total keeps its text. The
	/// counter is recognized by shape, and `(×` followed by digits and a closing
	/// bracket is a narrow enough shape to be safe, but the rule still has to be
	/// stated: this line is the program's, not the minimizer's.
	#[test]
	fn a_program_line_that_merely_ends_in_a_bracket_is_left_alone() {
		let input = "total (12 items)\ntotal (12 items)\n";

		assert_eq!(primitives::dedup_consecutive_lines(input), "total (12 items) (×2)\n");
	}

	/// A counter with a non-numeric body is not one of ours either.
	#[test]
	fn a_bracket_without_digits_is_not_a_counter() {
		let input = "step (×many)\nstep (×many)\n";

		assert_eq!(primitives::dedup_consecutive_lines(input), "step (×many) (×2)\n");
	}

	/// An empty counter body is not a counter.
	#[test]
	fn an_empty_counter_body_is_not_a_counter() {
		let input = "step (×)\nstep (×)\n";

		assert_eq!(primitives::dedup_consecutive_lines(input), "step (×) (×2)\n");
	}

	/// A blank run is still never annotated, because annotating whitespace
	/// invents a message. This is the rule the counter fix must not disturb.
	#[test]
	fn a_blank_run_is_still_not_counted() {
		let output = primitives::dedup_consecutive_lines("\n\n\n");

		assert_eq!(output, "\n");
		assert!(!output.contains('×'), "whitespace is not annotated: {output:?}");
	}
}
