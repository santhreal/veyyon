//! A line predicate must not turn on trailing whitespace, and the shared
//! entry point must not leave any behind for it to turn on.
//!
//! WHAT IT DID. `bun test` output at a non-zero exit runs through
//! `node_tests::failures_only`, which keeps a block of lines starting at a
//! failure header and drops everything else. One shape of header is
//! Playwright's numbered summary line, and the test for it asked that a number
//! be followed by `)` and then SOME WHITESPACE. That made the answer depend on
//! trailing whitespace: `" 0)\r"` was a header and `" 0)"` was not.
//!
//! A capture loses its trailing carriage returns on the way through, so the
//! same line was a header on the first pass and ordinary output on the second.
//! Everything above the next real header was kept once and dropped the next
//! time, which for the capture the fuzzer found meant five lines of program
//! output disappearing on a replay.
//!
//! WHY NORMALIZING CARRIAGE RETURNS DID NOT ALREADY COVER IT. `filters::filter`
//! normalizes trailing CRs before dispatching, precisely so predicates cannot
//! see one pass's leftovers. But the capture was `" 0)\r\r\r\r\x1b\x1b\x1b"`,
//! where the carriage returns are not trailing at all: three escape bytes sit
//! behind them. Normalizing left the line alone, the filter's own `strip_ansi`
//! then removed the escapes, and the carriage returns became trailing one step
//! after the pass that would have taken them. The next pass, handed a capture
//! with no escapes left, normalized them away and read the line differently.
//!
//! THE RULE NOW, in both places, because either alone would leave the class
//! open. `filters::filter` strips escapes BEFORE it normalizes carriage
//! returns, so no rewrite can hide work from the other; every filter in the
//! module strips ANSI as its first act anyway, so this costs nothing. And a
//! Playwright header must name a test, not merely be followed by a space, so a
//! line of nothing but a number and a bracket is not a header on any pass.
//!
//! Found by `fuzz/fuzz_targets/minimizer_filters.rs`, artifact
//! `crash-df53aa3c9a7c0a56e585941db0f96acd17e5dce8`.

use veyyon_shell::minimizer::{MinimizerConfig, MinimizerCtx, filters, primitives};

fn enabled() -> MinimizerConfig {
	MinimizerConfig { enabled: true, ..Default::default() }
}

fn bun_test<'a>(config: &'a MinimizerConfig) -> MinimizerCtx<'a> {
	MinimizerCtx { program: "bun", subcommand: Some("test"), command: "bun test", config }
}

mod the_capture_that_found_it {
	use super::*;

	/// THE regression, as the fuzzer reduced it. The first line carries four
	/// carriage returns hidden behind escape bytes, which is the whole
	/// mechanism.
	#[test]
	fn a_capture_whose_escapes_hide_carriage_returns_settles_after_one_pass() {
		let config = enabled();
		let ctx = bun_test(&config);
		// Short `concat!` chunks rather than one long literal: `format_strings =
		// true` makes rustfmt split anything wider than `max_width`, and its
		// splitting is escape-unaware, so a single literal of this shape has
		// already been corrupted once in this suite. See
		// crates/veyyon-shell/tests/a_formatted_string_still_says_what_it_said.rs.
		let input = concat!(
			")((-]\u{1b} ](\n\n 0)\r\r\r\r\u{1b}\u{1b}\u{1b}\u{1b}\u{1b}\u{1b}",
			"\u{1b}\n\r\n\n0(\t[0 0 )[0  \n-\u{1b}) )\u{1b}:00000||0  \n00) ",
			")\u{1b}:0000| [[:\u{1b}\u{1b})| [\n 0:0000\t [[\t\n\n\n\n\n\n\n",
			"\n\n\r\r\r\r\r\r\r\r\r\r",
		);

		let first = filters::filter(&ctx, input, -1).text;
		let second = filters::filter(&ctx, &first, -1).text;

		assert_eq!(second, first, "the answer must not depend on how many passes have run");
	}

	/// A settling test alone would pass if both passes answered with the shorter
	/// capture, so the thing an operator actually reads is asserted separately:
	/// a real failure block sitting above a bare marker is kept in full, on
	/// every pass. The bare marker itself is correctly dropped now, on both
	/// passes rather than on the second only, because it names no test.
	#[test]
	fn a_real_failure_block_above_a_bare_marker_is_kept_on_every_pass() {
		let config = enabled();
		let ctx = bun_test(&config);
		// `concat!` chunks, not one literal: `format_strings = true` had already
		// split this one across a line continuation, and rustfmt's splitting is
		// escape-unaware, so the next edit that lengthens it could land the break
		// inside an escape instead of on a space. Chunks stay under `max_width`,
		// so there is nothing for the formatter to split. See
		// crates/veyyon-shell/tests/a_formatted_string_still_says_what_it_said.rs.
		let input = concat!(
			"FAIL a.test.ts\nError: boom\n  at a.test.ts:3:1\n",
			" 0)\r\r\u{1b}\u{1b}\nRan all test suites\n",
		);

		let first = filters::filter(&ctx, input, -1).text;
		let second = filters::filter(&ctx, &first, -1).text;

		assert!(first.contains("Error: boom"), "the failure survives pass one: {first:?}");
		assert!(first.contains("at a.test.ts:3:1"), "with its context: {first:?}");
		assert!(second.contains("Error: boom"), "and pass two: {second:?}");
		assert_eq!(second, first, "and the two passes agree");
	}

	/// And a third pass changes nothing, because "settled" means settled rather
	/// than "alternates with a period of two".
	#[test]
	fn and_a_third_pass_changes_nothing() {
		let config = enabled();
		let ctx = bun_test(&config);
		let input = " 0)\r\r\r\u{1b}\u{1b}\n0(\t[0 0 )[0  \n00) ) 0000| [\n";

		let first = filters::filter(&ctx, input, -1).text;
		let second = filters::filter(&ctx, &first, -1).text;
		let third = filters::filter(&ctx, &second, -1).text;

		assert_eq!(third, second);
		assert_eq!(second, first);
	}
}

mod the_order_the_shared_entry_point_rewrites_in {
	use super::*;

	/// The ordering rule stated on its own: a carriage return standing behind an
	/// escape byte is gone by the time a filter sees the line, exactly as a bare
	/// trailing one is. Asserted through `filter` rather than through a private
	/// helper, because the ordering is a property of the entry point.
	///
	/// The capture carries a `console.` line the filter drops, so the filter
	/// actually MINIMIZES. That is deliberate: a filter that changes nothing
	/// declines, and a declining filter hands back the program's own bytes
	/// escapes and all, which is the documented promise of
	/// `MinimizerOutput::passthrough` and would make this assertion test the
	/// wrong thing.
	#[test]
	fn a_carriage_return_behind_an_escape_is_removed_before_dispatch() {
		let config = enabled();
		let ctx = bun_test(&config);
		let input = "console.log noise\nFAIL a.test.ts\r\r\u{1b}\u{1b}\nError: boom\n";

		let output = filters::filter(&ctx, input, 1).text;

		assert!(!output.contains('\r'), "no carriage return survives: {output:?}");
		assert!(!output.contains('\u{1b}'), "and no escape survives: {output:?}");
		assert!(output.contains("Error: boom"), "the failure is still reported: {output:?}");
	}

	/// The other side of that promise, stated so nobody "fixes" it later: a
	/// filter that minimizes NOTHING hands back the raw capture, carriage
	/// returns and escapes included. Rewriting the bytes while reporting that
	/// nothing was minimized would break the one case where the raw capture is
	/// what the caller asked for.
	#[test]
	fn a_declining_filter_still_answers_with_the_programs_own_bytes() {
		let config = enabled();
		let ctx = bun_test(&config);
		let input = "FAIL a.test.ts\r\r\u{1b}\u{1b}\nError: boom\n";

		let output = filters::filter(&ctx, input, 1);

		assert_eq!(output.text, input, "the raw capture comes back untouched");
	}

	/// The two rewrites in the other order would leave the carriage return, so
	/// this pins the difference directly on the primitives rather than only
	/// through a filter. Normalizing first sees no TRAILING carriage return and
	/// changes nothing; stripping first exposes them.
	#[test]
	fn normalizing_before_stripping_would_not_have_removed_it() {
		let line = "x\r\r\u{1b}\u{1b}\n";

		let normalize_first = primitives::normalize_carriage_returns(line);
		assert!(normalize_first.contains('\r'), "the wrong order leaves it: {normalize_first:?}");

		let strip_first = primitives::normalize_carriage_returns(&primitives::strip_ansi(line));
		assert!(!strip_first.contains('\r'), "the right order removes it: {strip_first:?}");
	}

	/// A capture with no escapes and no carriage returns takes the untouched
	/// path, which is the case that runs every time and must not start
	/// allocating or rewriting.
	#[test]
	fn an_ordinary_capture_is_dispatched_unchanged() {
		let config = enabled();
		let ctx = bun_test(&config);
		let input = "FAIL a.test.ts\nError: boom\n  at a.test.ts:3:1\n";

		let output = filters::filter(&ctx, input, 1).text;

		assert!(output.contains("Error: boom"), "{output:?}");
		assert!(output.contains("at a.test.ts:3:1"), "{output:?}");
	}
}

mod what_a_playwright_failure_header_is {
	use super::*;

	/// A real Playwright summary line still starts a kept block. This is the
	/// behaviour the predicate exists for, and a fix that lost it would trade
	/// one defect for a worse one: the numbered summary is where an operator
	/// reads which tests failed.
	#[test]
	fn a_numbered_line_that_names_a_test_starts_a_block() {
		let config = enabled();
		let ctx = MinimizerCtx {
			program:    "bunx",
			subcommand: Some("playwright"),
			command:    "bunx playwright test",
			config:     &config,
		};
		let input = "ok noise\n  1) tests/a.spec.ts:3:1 › renders\n     Error: expected 1\n";

		let output = filters::filter(&ctx, input, 1).text;

		assert!(output.contains("1) tests/a.spec.ts:3:1"), "the header is kept: {output:?}");
		assert!(output.contains("Error: expected 1"), "and its block: {output:?}");
	}

	/// Multi-digit numbers too, since a suite with ten failures is the ordinary
	/// case and a single-digit-only rule would silently drop the tenth onward.
	#[test]
	fn a_two_digit_number_names_a_test_just_as_well() {
		let config = enabled();
		let ctx = MinimizerCtx {
			program:    "bunx",
			subcommand: Some("playwright"),
			command:    "bunx playwright test",
			config:     &config,
		};
		let input = "noise\n  12) tests/b.spec.ts:9:1 › other\n     Error: nope\n";

		let output = filters::filter(&ctx, input, 1).text;

		assert!(output.contains("12) tests/b.spec.ts:9:1"), "{output:?}");
	}

	/// THE boundary the fix moved: a number and a bracket with nothing after
	/// them names no test, so it is not a header, whatever whitespace trails it.
	/// Stated as the pair, because "the same line with and without a carriage
	/// return" is precisely what used to disagree.
	#[test]
	fn a_bare_number_is_not_a_header_with_or_without_trailing_whitespace() {
		let config = enabled();
		let ctx = bun_test(&config);

		for suffix in ["", " ", "\t", "\r", "\r\r\r", "  \t "] {
			let input = format!("keep me\n 7){suffix}\nkeep me too\nFAIL a.test.ts\nError: x\n");

			let first = filters::filter(&ctx, &input, 1).text;
			let second = filters::filter(&ctx, &first, 1).text;

			assert_eq!(
				second, first,
				"a bare marker with suffix {suffix:?} answered differently on a second pass",
			);
		}
	}

	/// A line that merely ENDS in a bracket is not a header either, which is the
	/// shape ordinary program output takes and the reason the whole predicate
	/// has to be anchored.
	#[test]
	fn a_line_that_is_not_numbered_is_not_a_header() {
		let config = enabled();
		let ctx = MinimizerCtx {
			program:    "bunx",
			subcommand: Some("playwright"),
			command:    "bunx playwright test",
			config:     &config,
		};
		let input = "FAIL a.test.ts\nError: called foo(1) here\n  at a.test.ts:3:1\n";

		let output = filters::filter(&ctx, input, 1).text;

		assert!(output.contains("called foo(1) here"), "the line is kept as context: {output:?}");
	}
}

mod every_shape_of_hidden_carriage_return {
	use super::*;

	/// The property the fix is really about, over the shapes that reach the same
	/// entry point: an escape byte anywhere near a carriage return must not
	/// change how many passes it takes to settle.
	#[test]
	fn all_of_them_settle_after_one_pass() {
		let config = enabled();
		let ctx = bun_test(&config);
		let captures: &[&str] = &[
			" 0)\r\u{1b}\nrest\n",
			" 0)\u{1b}\r\nrest\n",
			" 0)\r\u{1b}\r\u{1b}\nrest\n",
			"1) a.spec.ts:1:1 › x\r\u{1b}\n  Error: e\n",
			"FAIL a.test.ts\r\r\u{1b}[0m\nError: boom\n",
			"\u{1b}[31m 9)\u{1b}[0m\r\nkeep\n",
		];

		for capture in captures {
			for exit_code in [1, -1, 2] {
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
