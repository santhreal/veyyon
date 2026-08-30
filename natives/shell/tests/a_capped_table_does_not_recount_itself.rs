//! A capped `docker` table keeps its row count when it is filtered again.
//!
//! WHAT THE FILTER DOES. `docker ps` and its siblings print a header row and
//! then one row per container. When there are more rows than fit, the minimizer
//! keeps the header, writes a bare `N rows` tally, shows the first few rows,
//! and closes with `[…N rows elided…]`.
//!
//! THE BUG. The compactor counts every non-blank line as a row, and on a second
//! pass two of those lines were its own: the tally and the elision marker. So a
//! capture that reported `13 rows` reported `14 rows` after being filtered
//! again, with the previous tally listed underneath as though it were a
//! container, and the elided count moved with it. Filters chain and captures
//! get replayed, so this reaches real callers, and a count that grows every
//! time the output is re-minimized is worse than no count at all: it is a
//! number the agent has no reason to distrust. Found by
//! `fuzz/fuzz_targets/minimizer_filters.rs`, whose property is that a filter
//! does not change its own output on a second pass.
//!
//! THE RULE NOW. `primitives::is_row_count_annotation` owns the shape, the
//! compactor recognizes its own tally and stops, and `is_minimizer_annotation`
//! reads the same predicate so every other filter treats the tally as ours too.
//! The BARE form only: psql writes `(13 rows)` with parentheses, and that is
//! the program's own summary.

use std::fmt::Write as _;

use veyyon_shell::minimizer::{MinimizerCtx, filters, primitives::is_row_count_annotation};

mod common;

use common::{context, enabled};

/// Filter `input`, then filter the result, and return both.
fn two_passes(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> (String, String) {
	let first = filters::filter(ctx, input, exit_code).text;
	let second = filters::filter(ctx, &first, exit_code).text;
	(first, second)
}

/// A `docker ps` capture with `rows` containers.
fn ps_output(rows: usize) -> String {
	let mut out = String::from("CONTAINER ID   IMAGE          STATUS\n");
	for n in 1..=rows {
		let _ = writeln!(out, "c{n:04}          nginx:latest   Up 3 hours");
	}
	out
}

mod the_tally_predicate {
	use super::*;

	/// The shape the compactor writes is the shape the predicate reads.
	#[test]
	fn the_bare_tally_is_recognized() {
		assert!(is_row_count_annotation("13 rows"));
		assert!(is_row_count_annotation("1 rows"));
		assert!(is_row_count_annotation("  200 rows  "));
	}

	/// The program's own parenthesized count is NOT ours.
	///
	/// psql closes a result set with `(13 rows)`, and claiming that line would
	/// stop the psql compactor from ever running on a real result.
	#[test]
	fn a_parenthesized_count_is_the_programs_own() {
		assert!(!is_row_count_annotation("(13 rows)"));
		assert!(!is_row_count_annotation("(1 row)"));
	}

	/// Prose that ends in the word rows is not the tally.
	///
	/// The negative twin: the tally is a count and nothing else, so anything
	/// carrying words with it belongs to the program.
	#[test]
	fn a_sentence_ending_in_rows_is_not_the_tally() {
		assert!(!is_row_count_annotation("deleted 13 rows"));
		assert!(!is_row_count_annotation("rows"));
		assert!(!is_row_count_annotation(" rows"));
		assert!(!is_row_count_annotation("13 rows affected"));
		assert!(!is_row_count_annotation(""));
	}
}

mod a_capped_table_survives_a_second_pass {
	use super::*;

	/// THE regression: the tally must not grow.
	#[test]
	fn the_row_count_does_not_grow_on_a_second_pass() {
		let config = enabled();
		let ctx = context("docker", Some("ps"), "docker ps -a", &config);
		let (first, second) = two_passes(&ctx, &ps_output(30), 0);

		assert!(first.contains("\n30 rows\n"), "the first pass counts the containers: {first:?}");
		assert!(second.contains("\n30 rows\n"), "and the second pass must agree: {second:?}");
		assert_eq!(second, first, "a capped table must not be capped again");
	}

	/// The elided count does not move either.
	///
	/// It is derived from the same total, so it drifted with it. Pinned
	/// separately because the two numbers are written in different places and a
	/// partial fix could hold one still while the other moved.
	#[test]
	fn the_elided_count_does_not_move() {
		let config = enabled();
		let ctx = context("docker", Some("ps"), "docker ps -a", &config);
		let (first, second) = two_passes(&ctx, &ps_output(30), 0);

		let elision = |text: &str| {
			text
				.lines()
				.find(|line| line.contains("rows elided"))
				.map(str::to_string)
		};
		assert!(elision(&first).is_some(), "the first pass elides: {first:?}");
		assert_eq!(elision(&second), elision(&first), "and the count must not move");
	}

	/// And it holds over several passes, since a fix that merely alternated
	/// between two answers would satisfy a single repeat.
	#[test]
	fn a_capped_table_stays_fixed_across_repeated_passes() {
		let config = enabled();
		let ctx = context("docker", Some("ps"), "docker ps -a", &config);
		let mut text = filters::filter(&ctx, &ps_output(30), 0).text;
		let expected = text.clone();
		for pass in 1..=4 {
			text = filters::filter(&ctx, &text, 0).text;
			assert_eq!(text, expected, "pass {pass} rewrote a settled table");
		}
	}

	/// The tally still matches the containers the capture actually held.
	///
	/// This is the invariant the bug broke, stated directly rather than through
	/// string equality: the tally is a claim about the capture, and a pass that
	/// counts the minimizer's own lines makes the claim false. Several sizes,
	/// because the drift was one line per pass and a single size proves less
	/// than it looks like it does. All of them are above the twelve rows
	/// `docker ps` shows in full, since a table that is not capped has no tally
	/// to check.
	#[test]
	fn the_tally_matches_the_number_of_containers() {
		let config = enabled();
		let ctx = context("docker", Some("ps"), "docker ps -a", &config);
		for rows in [14usize, 25, 40] {
			let (first, second) = two_passes(&ctx, &ps_output(rows), 0);
			assert!(first.contains(&format!("\n{rows} rows\n")), "{rows} containers: {first:?}");
			assert_eq!(second, first, "{rows} containers changed on a second pass");
		}
	}
}

mod ordinary_docker_output_is_unaffected {
	use super::*;

	/// A table small enough to show in full is not capped at all.
	///
	/// `docker ps` shows twelve rows before it caps, so three is comfortably
	/// under. This is the boundary of the compactor, and the reason the guard
	/// has to key on the tally rather than on "does this look like a table": a
	/// short table has no tally, and re-filtering it must still do nothing.
	#[test]
	fn a_short_table_is_left_alone() {
		let config = enabled();
		let ctx = context("docker", Some("ps"), "docker ps", &config);
		let input = ps_output(3);
		let (first, second) = two_passes(&ctx, &input, 0);

		assert!(!first.contains(" rows\n"), "nothing to cap, so no tally: {first:?}");
		assert!(first.contains("c0001"), "and every row is shown: {first:?}");
		assert_eq!(second, first, "and a second pass changes nothing");
	}

	/// A long table is still capped, which is what the filter is for.
	///
	/// The negative twin for the whole guard: if it fired on ordinary output the
	/// minimizer would stop minimizing the captures it was written for, and
	/// every idempotence check would still pass, because doing nothing is
	/// perfectly idempotent.
	#[test]
	fn a_long_table_is_still_capped_and_shrunk() {
		let config = enabled();
		let ctx = context("docker", Some("ps"), "docker ps -a", &config);
		let input = ps_output(200);
		let first = filters::filter(&ctx, &input, 0).text;

		assert!(first.contains("\n200 rows\n"), "got: {first:?}");
		assert!(first.contains("rows elided"), "got: {first:?}");
		assert!(first.starts_with("CONTAINER ID"), "the header is kept: {first:?}");
		assert!(first.len() < input.len() / 2, "and the whole point is that it got much smaller");
	}
}
