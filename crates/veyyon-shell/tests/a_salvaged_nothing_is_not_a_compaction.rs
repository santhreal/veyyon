//! A psql capture the table reshaper could not salvage settles on the first
//! pass.
//!
//! THE MECHANISM, WHICH IS THE SAME SHAPE AS THE OTHER SELF-CONSUMPTION BUGS.
//! `filter_psql` reshapes a result set and wraps that in
//! `primitives::or_original`, which hands back the ORIGINAL capture when the
//! reshaping produces nothing. That guard exists because the reshaper drops
//! borders and empty cells on the way in, so a capture of nothing but
//! borders compacts to the empty string, and answering "nothing" for a capture
//! that had content would be worse than answering with the content.
//!
//! The guard turns on emptiness, and an annotation this minimizer wrote is not
//! empty. A table of nothing but border-ish rows compacts to empty,
//! `or_original` returns the original, and the dedup that runs after it
//! collapses the two identical rows into `… (×2)`. Feed that answer back in and
//! the reshaper now recognizes the repeat counter as a line to keep, its output
//! is no longer empty, so the RESHAPED version wins this time and
//! a leading whitespace-only line the first pass had kept is gone. The same
//! capture minimized to two different things depending on how many times it had
//! been through, and filters chain and captures get replayed, so both answers
//! reached callers.
//!
//! THE RULE NOW, and it lives in `primitives::or_original` because every table
//! reshaper reaches the same decision through it. A compaction that holds no
//! program content is the same answer as nothing, and a capture that printed
//! ANYTHING at all is never answered with nothing. The guard used to require
//! program content in the capture too, which is what let this through: a
//! capture that has already been through a pass can hold nothing but this
//! minimizer's own annotations, and it still must not be thrown away, because a
//! repeat counter stands in for the output that was dropped.
//!
//! Found by `fuzz/fuzz_targets/minimizer_filters.rs`.

use veyyon_shell::minimizer::{MinimizerConfig, MinimizerCtx, filters, primitives};

fn enabled() -> MinimizerConfig {
	MinimizerConfig { enabled: true, ..Default::default() }
}

fn psql<'a>(command: &'a str, config: &'a MinimizerConfig) -> MinimizerCtx<'a> {
	MinimizerCtx { program: "psql", subcommand: Some("clean"), command, config }
}

mod the_capture_that_found_it {
	use super::*;

	/// THE regression, as the fuzzer reduced it: two identical border-ish rows,
	/// a leading whitespace-only line, and a long run of blanks.
	#[test]
	fn a_table_of_nothing_but_borders_settles_after_one_pass() {
		let config = enabled();
		let ctx = psql("", &config);
		// The capture is spelled as short `concat!` chunks rather than one long literal
		// because `format_strings = true` makes rustfmt split a literal that exceeds
		// `max_width`, and its splitting is escape-unaware. It had already split this
		// one between the `\` and the `n` of an escape, leaving a literal backslash,
		// a raw newline and 13 spaces in the middle of a fuzzer capture; the repaired
		// value is the two border rows followed by 38 blank lines, as the doc above
		// says. Nothing failed, because an idempotence test asserts a property of
		// whatever it is given. Chunks stay under the width, so there is nothing left
		// for the formatter to split. See
		// crates/veyyon-shell/tests/a_formatted_string_still_says_what_it_said.rs.
		let input = concat!(
			"\t\t\t \t\n\n| \t\r\t\t-+----\n| \t\r\t\t-+----\n\n\n\n",
			"\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n",
			"\n\n\n\n\n\n",
		);

		let first = filters::filter(&ctx, input, -1).text;
		let second = filters::filter(&ctx, &first, -1).text;

		assert_eq!(second, first, "the answer must not depend on how many passes have run");
	}

	/// And a third pass changes nothing either, because "settled" means settled,
	/// not "alternates with a period of two".
	#[test]
	fn and_a_third_pass_changes_nothing() {
		let config = enabled();
		let ctx = psql("", &config);
		let input = "\t\t\t \t\n\n| \t\r\t\t-+----\n| \t\r\t\t-+----\n\n\n";

		let first = filters::filter(&ctx, input, -1).text;
		let second = filters::filter(&ctx, &first, -1).text;
		let third = filters::filter(&ctx, &second, -1).text;

		assert_eq!(third, second);
		assert_eq!(second, first);
	}

	/// The content the first pass kept is still there. A settling test alone
	/// would pass if both passes answered with the empty string, which is the
	/// failure mode that matters most here: an operator told a capture is empty
	/// stops looking.
	#[test]
	fn the_capture_is_not_thrown_away_to_make_it_settle() {
		let config = enabled();
		let ctx = psql("", &config);
		let input = "\t\t\t \t\n\n| \t\r\t\t-+----\n| \t\r\t\t-+----\n\n\n";

		let first = filters::filter(&ctx, input, -1).text;

		assert!(first.contains("-+----"), "the row survives: {first:?}");
		assert!(!first.trim().is_empty(), "an unsalvageable capture is not answered with nothing");
	}
}

mod a_real_result_set_is_still_compacted {
	use super::*;

	/// THE OTHER HALF, and the one a careless fix breaks. Making the reshaper
	/// report "nothing salvaged" more eagerly would turn every result set into
	/// a passthrough, which settles perfectly and minimizes nothing.
	#[test]
	fn a_result_set_with_rows_is_reshaped() {
		let config = enabled();
		let ctx = psql("psql -c 'select 1'", &config);
		let input = " id | name  \n----+-------\n  1 | ada\n  2 | grace\n(2 rows)\n";

		let output = filters::filter(&ctx, input, 0).text;

		assert!(output.contains("ada"), "the data survives: {output:?}");
		assert!(output.contains("grace"), "every row survives: {output:?}");
		assert!(!output.contains("----+-------"), "and the border is dropped: {output:?}");
	}

	/// A row count alone is program content: `(2 rows)` is the program's own
	/// answer and is what a caller reads when the rows themselves are elided.
	#[test]
	fn a_row_count_alone_counts_as_salvaged_output() {
		let config = enabled();
		let ctx = psql("psql -c 'select 1'", &config);
		let input = "----+-------\n(2 rows)\n";

		let output = filters::filter(&ctx, input, 0).text;

		assert!(output.contains("(2 rows)"), "the count survives: {output:?}");
	}

	/// An error line is program content too, and is the one line an operator
	/// most needs.
	#[test]
	fn an_error_line_counts_as_salvaged_output() {
		let config = enabled();
		let ctx = psql("psql -c 'select 1'", &config);
		let input = "----+-------\nERROR:  relation \"nope\" does not exist\n";

		let output = filters::filter(&ctx, input, 1).text;

		assert!(output.contains("does not exist"), "the error survives: {output:?}");
	}

	/// A large result set still elides, and the notice says how many rows went.
	/// The elision notice is an annotation, so a fix that stopped counting
	/// annotations as salvage must not stop them being WRITTEN.
	#[test]
	fn a_large_result_set_still_reports_what_it_elided() {
		let config = enabled();
		let ctx = psql("psql -c 'select 1'", &config);
		let mut input = String::from(" id | name\n----+------\n");
		for row in 0..200 {
			input.push_str(&format!("  {row} | name-{row}\n"));
		}
		input.push_str("(200 rows)\n");

		let output = filters::filter(&ctx, &input, 0).text;

		assert!(output.contains("rows elided"), "the elision is reported: {output:?}");
		assert!(output.contains("(200 rows)"), "and the program's own count survives: {output:?}");
		assert!(output.len() < input.len(), "the capture actually got smaller");
	}
}

mod the_rule_itself {
	use super::*;

	/// The fix lives in `or_original`, so it is stated here directly rather than
	/// only through psql. Every table reshaper reaches this decision, and a
	/// later filter that reproduces the rule inline instead of calling this
	/// would drift away from it.
	#[test]
	fn a_capture_of_nothing_but_an_annotation_is_still_a_capture() {
		let original = "| -+---- (×2)\n";

		assert_eq!(
			primitives::or_original(String::new(), original),
			original,
			"a capture that printed something is never answered with nothing",
		);
	}

	/// The same holds when the compaction is not empty but holds only
	/// annotations, which is the shape a reshaper produces on a second pass: it
	/// recognizes the previous pass's marker as a line worth keeping and keeps
	/// nothing else.
	#[test]
	fn a_compaction_of_nothing_but_an_annotation_counts_as_nothing() {
		let original = "| -+---- (×2)\n";

		for compaction in ["| -+---- (×2)\n", "[…3 lines elided…]\n", "\t-+---- (×2)\n"] {
			assert_eq!(
				primitives::or_original(compaction.to_string(), original),
				original,
				"an annotation-only compaction is the same answer as an empty one: {compaction:?}",
			);
		}
	}

	/// The original case the guard was written for still holds: a capture with
	/// real rows that compacts to nothing comes back whole.
	#[test]
	fn a_capture_with_rows_that_compacts_to_nothing_comes_back_whole() {
		let original = "  1 | ada\n  2 | grace\n";

		assert_eq!(primitives::or_original(String::new(), original), original);
	}

	/// And a real compaction is passed through untouched, which is the case that
	/// runs every time.
	#[test]
	fn a_compaction_with_program_content_is_kept() {
		assert_eq!(
			primitives::or_original("1\tada\n".to_string(), "  1 | ada\n  2 | grace\n"),
			"1\tada\n",
		);
	}

	/// A capture that really was empty is still allowed to answer empty. Without
	/// this the guard would report a phantom passthrough for every command that
	/// printed nothing.
	#[test]
	fn a_capture_that_printed_nothing_may_answer_nothing() {
		assert_eq!(primitives::or_original(String::new(), ""), "");
		assert_eq!(primitives::or_original(String::new(), "  \n\t\n"), "");
	}
}

mod every_shape_of_unsalvageable_capture {
	use super::*;

	/// The property the fix is really about, over the shapes that reach the same
	/// guard: a capture with nothing a reshaper can use must answer the same on
	/// every pass.
	#[test]
	fn all_of_them_settle_after_one_pass() {
		let config = enabled();
		let ctx = psql("", &config);
		let captures: &[&str] = &[
			"| \t-+-\n| \t-+-\n",
			"---+---\n---+---\n---+---\n",
			"+------+\n+------+\n",
			" \n\n| -+- |\n| -+- |\n \n",
			"| |\n| |\n---+---\n",
			"\t\t\n| \r\t-+----\n| \r\t-+----\n\t\t\n",
		];

		for capture in captures {
			for exit_code in [0, 1, -1] {
				let first = filters::filter(&ctx, capture, exit_code).text;
				let second = filters::filter(&ctx, &first, exit_code).text;
				assert_eq!(
					second, first,
					"{capture:?} at exit {exit_code} answered differently on a second pass",
				);
			}
		}
	}
}
