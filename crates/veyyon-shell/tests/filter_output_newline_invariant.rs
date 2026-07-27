//! Rewritten filter output is newline-terminated; passed-through output is not.
//!
//! WHY THE INVARIANT EXISTS. Filter output is line-oriented, and nearly every
//! path builds it a line at a time, so it already ended in a newline. The
//! exceptions were the paths that collapse a whole capture into a single
//! summary: `finish_filtered` in the C++ filter returned the bare literal
//! `"ctest: ok"`, and the JVM filter has four more of the same shape.
//!
//! THE BUG. Filters chain and captures get replayed, so a filter runs over its
//! own output as a matter of course. `filter("ctest", …)` answered
//! `"ctest: ok"`, and filtering THAT answered `"ctest: ok\n"`, because the
//! second pass read the summary as an ordinary line of program output and wrote
//! it back terminated. A filter whose result depends on how many times it has
//! run cannot be cached, compared across runs, or replayed, and nothing
//! reported the difference. Found by `fuzz/fuzz_targets/minimizer_filters.rs`,
//! whose property is that a filter does not change its own output on a second
//! pass.
//!
//! WHERE IT IS ENFORCED. At `MinimizerOutput::transformed`, the one constructor
//! meaning "this text was rewritten", rather than at the five places that
//! produced a summary. That covers any future summary path for free.
//! `passthrough` deliberately does not enforce it: it promises the program's
//! bytes unchanged, and appending would break the one case where the raw
//! capture is what the caller asked for.

use veyyon_shell::minimizer::{MinimizerOutput, filters};

mod common;

use common::{context, enabled};

/// A dispatch context for `program`, with no per-command config overlay.
/// Minimization enabled, everything else default.
mod the_constructor_carries_the_rule {
	use super::*;

	/// Rewritten text without a terminator gains one.
	///
	/// This is the whole fix in one assertion: the summary paths hand a bare
	/// literal to this constructor and it makes them line-shaped.
	#[test]
	fn transformed_output_gains_a_missing_newline() {
		let out = MinimizerOutput::transformed("ctest: ok".to_string(), 4096);
		assert_eq!(out.text, "ctest: ok\n");
	}

	/// Text that already ends in a newline is left exactly as it is.
	///
	/// The path almost every filter takes. A constructor that appended
	/// unconditionally would grow the output by one byte per pass, which is the
	/// same non-idempotence in the other direction.
	#[test]
	fn transformed_output_that_is_already_terminated_is_untouched() {
		let out = MinimizerOutput::transformed("error: boom\n".to_string(), 4096);
		assert_eq!(out.text, "error: boom\n");
	}

	/// Empty output stays empty rather than becoming a blank line.
	///
	/// A filter that legitimately reduces a capture to nothing must not have
	/// that turned into one line of whitespace, which downstream code would
	/// count as content.
	#[test]
	fn transformed_empty_output_stays_empty() {
		let out = MinimizerOutput::transformed(String::new(), 4096);
		assert_eq!(out.text, "");
		assert_eq!(out.output_bytes, 0);
	}

	/// The reported byte count matches the text after the newline is added.
	///
	/// `output_bytes` drives every downstream size decision, so a count taken
	/// before the append would understate the output by a byte forever.
	#[test]
	fn the_byte_count_is_taken_after_the_newline_is_added() {
		let out = MinimizerOutput::transformed("ctest: ok".to_string(), 4096);
		assert_eq!(out.output_bytes, out.text.len());
		assert_eq!(out.output_bytes, 10, "nine characters plus the newline");
	}

	/// A multi-line result missing only its final terminator gains just that.
	#[test]
	fn only_the_final_newline_is_added() {
		let out = MinimizerOutput::transformed("a\nb\nc".to_string(), 4096);
		assert_eq!(out.text, "a\nb\nc\n");
	}

	/// A dangling carriage return is replaced by the terminator, not followed
	/// by it.
	///
	/// Appending would have produced a CRLF, and the next pass strips carriage
	/// returns, so `"\r"` settled at `"\r\n"` on one pass and `"\n"` on the
	/// next. The append introduced that, which is why it is pinned here.
	#[test]
	fn a_dangling_carriage_return_becomes_the_terminator() {
		let out = MinimizerOutput::transformed("\r".to_string(), 4096);
		assert_eq!(out.text, "\n");
	}

	/// And a dangling CR after real text goes the same way.
	#[test]
	fn a_dangling_carriage_return_after_text_becomes_the_terminator() {
		let out = MinimizerOutput::transformed("warn\r".to_string(), 4096);
		assert_eq!(out.text, "warn\n");
	}

	/// CRLF line endings are normalized, wherever they are.
	///
	/// `dedup_consecutive_lines` already strips carriage returns wherever it
	/// runs, and explains why: a CR surviving into a rendered row moves the
	/// cursor to column 0 and corrupts the line. It is not the only way to build
	/// output, so a path that skipped it handed back CRLF that the next pass
	/// stripped, and the filter's answer depended on how many times it had run.
	/// The rule holds at the boundary now, so it holds for every filter.
	#[test]
	fn crlf_line_endings_are_normalized_throughout() {
		let out = MinimizerOutput::transformed("a\r\nb\r\n".to_string(), 4096);
		assert_eq!(out.text, "a\nb\n");
	}

	/// Normalizing is idempotent, which is the property the whole rule exists
	/// for.
	#[test]
	fn normalizing_line_endings_settles_immediately() {
		let once = MinimizerOutput::transformed("a\r\nb\r".to_string(), 4096).text;
		assert_eq!(once, "a\nb\n");
		let twice = MinimizerOutput::transformed(once.clone(), 4096).text;
		assert_eq!(twice, once, "normalized text must not be rewritten again");
	}

	/// A doubled carriage return before a newline is fully normalized in one
	/// pass.
	///
	/// The reason this is done per line rather than by replacing the two-byte
	/// sequence: `"\r\r\n"` contains `"\r\n"` once, so a single textual replace
	/// leaves `"\r\n"` behind and the NEXT pass changes it again. Real captures
	/// do carry doubled carriage returns, and this exact input came out of the
	/// fuzzer.
	#[test]
	fn a_doubled_carriage_return_is_normalized_in_one_pass() {
		let once = MinimizerOutput::transformed("x-\n|\r\r\n\r\r\r\n".to_string(), 4096).text;
		assert_eq!(once, "x-\n|\n\n");
		let twice = MinimizerOutput::transformed(once.clone(), 4096).text;
		assert_eq!(twice, once, "one pass must be enough");
	}

	/// A lone carriage return in the MIDDLE of a line is content, not a line
	/// ending, and stays.
	///
	/// The boundary of the rule: only `\r\n` and a trailing `\r` are line
	/// endings. A program that prints a progress bar by returning to column 0
	/// mid-line is doing something the minimizer has no business rewriting into
	/// a line break.
	#[test]
	fn an_interior_lone_carriage_return_is_left_alone() {
		let out = MinimizerOutput::transformed("50%\r100%\n".to_string(), 4096);
		assert_eq!(out.text, "50%\r100%\n");
	}

	/// Passthrough keeps the program's bytes exactly, terminator or not.
	///
	/// The negative twin, and the reason the rule lives on `transformed` rather
	/// than on the dispatcher. Passthrough means "we did not rewrite this", and
	/// appending a byte would make that false.
	#[test]
	fn passthrough_output_is_never_given_a_newline() {
		let out = MinimizerOutput::passthrough("raw bytes, no terminator");
		assert_eq!(out.text, "raw bytes, no terminator");
		assert!(!out.changed, "passthrough must not claim it rewrote anything");
	}
}

mod a_filter_does_not_change_its_own_output {
	use super::*;

	/// The reduced case from the fuzzer, end to end through the dispatcher.
	///
	/// A successful ctest run with nothing worth showing collapses to a summary.
	/// Filtering that summary again has to return it unchanged.
	#[test]
	fn a_collapsed_ctest_summary_survives_a_second_pass() {
		let config = enabled();
		let ctx = context("ctest", Some("ctest"), "ctest", &config);
		let first = filters::filter(&ctx, "Test project /tmp/build\n", 0);
		assert_eq!(first.text, "ctest: ok\n", "a clean run collapses to a terminated summary");

		let second = filters::filter(&ctx, &first.text, 0);
		assert_eq!(second.text, first.text, "filtering a summary must not rewrite it");
	}

	/// And across several passes, since a fix that merely alternates between two
	/// answers would satisfy a single repeat.
	#[test]
	fn a_collapsed_summary_stays_fixed_across_repeated_passes() {
		let config = enabled();
		let ctx = context("ctest", Some("ctest"), "ctest", &config);
		let mut text = filters::filter(&ctx, "Test project /tmp/build\n", 0).text;
		let expected = text.clone();
		for pass in 1..=4 {
			text = filters::filter(&ctx, &text, 0).text;
			assert_eq!(text, expected, "pass {pass} rewrote a settled summary");
		}
	}

	/// The same shape in the package filter, which reaches the summary by a
	/// completely different route (a no-op short circuit rather than a
	/// filtered-to-nothing collapse).
	#[test]
	fn a_package_no_op_summary_survives_a_second_pass() {
		let config = enabled();
		let ctx = context("uv", Some("sync"), "uv sync", &config);
		let first =
			filters::filter(&ctx, "Resolved 42 packages in 123ms\nAudited 42 packages in 0.05ms\n", 0);
		assert_eq!(first.text, "ok (up to date)\n");

		let second = filters::filter(&ctx, &first.text, 0);
		assert_eq!(second.text, first.text, "the no-op summary must not gain a byte on re-filtering");
	}

	/// An unrouted program reaches the generic filter, which was already
	/// line-assembling and so already terminated its output.
	///
	/// Worth pinning because it shows where the invariant came from: every path
	/// that writes output a line at a time gets the terminator for free, which
	/// is exactly why the collapse-to-a-summary paths were the only ones that
	/// did not have it, and why they went unnoticed. The second pass then finds
	/// nothing to change and passes the bytes through.
	#[test]
	fn an_unrouted_program_is_terminated_once_and_then_settles() {
		let config = enabled();
		let ctx =
			context("definitely-not-a-known-tool", None, "definitely-not-a-known-tool", &config);
		let first = filters::filter(&ctx, "raw output with no terminator", 0);
		assert_eq!(first.text, "raw output with no terminator\n");
		assert!(first.changed, "adding the terminator is a rewrite");

		let second = filters::filter(&ctx, &first.text, 0);
		assert_eq!(second.text, first.text, "the settled text must not be rewritten again");
		assert!(!second.changed, "an unchanged pass must report itself as a passthrough");
	}
}
