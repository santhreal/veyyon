//! A capture with CRLF line endings minimizes to the same thing as its LF twin.
//!
//! THE ASYMMETRY THAT CAUSED THIS. `MinimizerOutput::transformed` strips a
//! trailing carriage return from every line, and has since the first
//! idempotence fix: a CR surviving into a rendered row moves the cursor to
//! column 0 and corrupts the line. So a filter's OWN output never carries
//! one. Nothing stripped them on the way IN, and a raw capture routinely has
//! them: any program run on Windows, any tool writing through a PTY, any log
//! copied out of a CI system.
//!
//! WHAT WENT WRONG. Every line predicate in every filter compares
//! `line.trim_start()` against a literal, and `"00)\r"` is not `"00)"`. `bun
//! test` on a failing run reads a playwright numbered failure header to decide
//! where the failure block starts; with the CR attached it recognized
//! nothing, kept nothing, and fell back to a head/tail window of the whole
//! capture. That window is written through `transformed`, so it came back with
//! the carriage returns stripped, and the next pass over the very same text
//! recognized the header, kept only the failure block, and answered with a much
//! shorter capture. The same output minimized to two different things depending
//! on how many times it had been through, and filters chain and captures get
//! replayed, so both answers reached real callers. Found by
//! `fuzz/fuzz_targets/minimizer_filters.rs`.
//!
//! THE RULE NOW. `filters::filter` normalizes carriage returns before it
//! dispatches, so every filter sees exactly the bytes a second pass would see.
//! A filter that DECLINES still hands back the program's own bytes, because
//! `passthrough` promises the capture unchanged and a caller that asked for the
//! raw output should get the raw output.

use veyyon_shell::minimizer::{filters, primitives::normalize_carriage_returns};

mod common;

use common::{context, enabled};

mod the_normalizer {
	use super::*;

	/// The ordinary case, and the whole rule: a trailing CR is not content.
	#[test]
	fn a_crlf_capture_becomes_an_lf_capture() {
		assert_eq!(normalize_carriage_returns("a\r\nb\r\n"), "a\nb\n");
	}

	/// Doubled carriage returns go in one pass, not one per pass.
	///
	/// THE BUG A `replace("\r\n", "\n")` WOULD HAVE. `"\r\r\n"` becomes `"\r\n"`
	/// under that rewrite, so the next pass changes it again and the text never
	/// settles. Real captures do contain doubled carriage returns: the one the
	/// fuzzer found started with `"00)\r\r\n"`.
	#[test]
	fn doubled_carriage_returns_all_go_at_once() {
		assert_eq!(normalize_carriage_returns("00)\r\r\n"), "00)\n");
		assert_eq!(normalize_carriage_returns("a\r\r\r\nb\r\r\n"), "a\nb\n");
	}

	/// Applying it twice is applying it once.
	#[test]
	fn it_is_a_fixed_point() {
		for text in ["a\r\nb", "\r", "\r\n\r\n", "00)\r\r\n0\r\n", "plain\ntext\n", ""] {
			let once = normalize_carriage_returns(text);
			assert_eq!(
				normalize_carriage_returns(&once),
				once,
				"{text:?} is not settled after one pass"
			);
		}
	}

	/// A capture with no final newline does not gain one.
	///
	/// The normalizer's job is carriage returns. Adding a terminator is
	/// `MinimizerOutput::transformed`'s job and belongs to the output contract,
	/// not to the input: a filter that declines must be able to hand back
	/// exactly what it was given.
	#[test]
	fn it_does_not_add_a_line_ending() {
		assert_eq!(normalize_carriage_returns("a\r\nb"), "a\nb");
		assert_eq!(normalize_carriage_returns("no newline here"), "no newline here");
	}

	/// A carriage return in the MIDDLE of a line is content, and is kept.
	///
	/// Progress bars redraw with a bare CR, and a filter that deleted them would
	/// join the redraws into one unreadable line. Only a trailing run is a line
	/// ending.
	#[test]
	fn a_carriage_return_inside_a_line_survives() {
		assert_eq!(normalize_carriage_returns("50%\r75%\r100%\n"), "50%\r75%\r100%\n");
	}

	/// Text with no carriage return at all is returned as it was.
	#[test]
	fn text_without_carriage_returns_is_untouched() {
		assert_eq!(normalize_carriage_returns("a\nb\n"), "a\nb\n");
	}
}

mod the_capture_that_found_it {
	use super::*;

	/// THE regression, as the fuzzer reduced it.
	///
	/// `00)` reads as a playwright numbered failure header and `"00)\r"` does
	/// not, so the first pass fell back to a head/tail window and the second
	/// pass filtered properly.
	#[test]
	fn a_failing_bun_test_capture_settles_after_one_pass() {
		let config = enabled();
		let ctx = context("bun", Some("test"), "bun test", &config);
		let input = "00)\r\r\n0            \n\n\n \n00)(000\n0:\n\n\n\n00) \n\n\n 00\n";

		let first = filters::filter(&ctx, input, -1).text;
		let second = filters::filter(&ctx, &first, -1).text;
		assert_eq!(second, first, "the answer must not depend on how many passes have run");
	}

	/// And the two spellings of the same capture give the same answer.
	///
	/// This is the property the fix is really about: whether a program used CRLF
	/// is not something the agent should be able to tell from the minimized
	/// output.
	#[test]
	fn the_crlf_capture_and_its_lf_twin_minimize_the_same_way() {
		let config = enabled();
		let ctx = context("bun", Some("test"), "bun test", &config);
		let crlf =
			"FAIL src/a.test.ts\r\n  ● it works\r\n    expected 1 to be 2\r\n  ✓ it also works\r\n";
		let lf = crlf.replace("\r\n", "\n");

		let from_crlf = filters::filter(&ctx, crlf, 1).text;
		let from_lf = filters::filter(&ctx, &lf, 1).text;

		assert_eq!(from_crlf, from_lf);
		assert!(from_crlf.contains("expected 1 to be 2"), "the failure survives: {from_crlf:?}");
		assert!(!from_crlf.contains('\r'), "and no carriage return reaches the agent: {from_crlf:?}");
	}
}

mod what_a_declining_filter_gives_back {
	use super::*;

	/// A filter that does not minimize hands back the program's OWN bytes,
	/// carriage returns and all.
	///
	/// Normalizing is for the filters' benefit. `passthrough` promises the
	/// capture unchanged, and a caller that asked for raw output and got a
	/// silently rewritten copy has been lied to about the one thing that
	/// constructor guarantees.
	#[test]
	fn a_passthrough_keeps_the_carriage_returns() {
		let config = enabled();
		let ctx =
			context("unknown-program-with-no-filter", None, "unknown-program-with-no-filter", &config);
		let input = "one\r\ntwo\r\n";

		let output = filters::filter(&ctx, input, 0);
		if !output.changed {
			assert_eq!(output.text, input, "a declined capture must come back byte for byte");
		}
	}

	/// A filter that DID minimize writes LF, because that is the output
	/// contract.
	#[test]
	fn a_rewrite_never_carries_a_carriage_return_out() {
		let config = enabled();
		let ctx = context("cargo", Some("build"), "cargo build", &config);
		let input = "   Compiling veyyon-shell v1.0.0\r\n   Compiling serde v1.0.0\r\nerror[E0308]: \
		             mismatched types\r\n  --> src/main.rs:1:1\r\n";

		let output = filters::filter(&ctx, input, 1);
		assert!(!output.text.contains('\r'), "got: {:?}", output.text);
		assert!(output.text.contains("E0308"), "and the diagnostic survives: {:?}", output.text);
	}
}

mod every_program_agrees_with_itself_about_line_endings {
	use super::*;

	/// The two spellings of one capture give one answer, for every program the
	/// minimizer knows.
	///
	/// The `bun test` case is one predicate on one filter, and there are several
	/// hundred line predicates across the filters. Rather than audit them, this
	/// asserts the property the normalization exists to provide, over every arm
	/// at once: a capture's line endings must not change what the agent is
	/// told.
	#[test]
	fn crlf_and_lf_captures_minimize_alike_for_every_arm() {
		let config = enabled();
		let arms: &[(&str, Option<&str>, &str)] = &[
			("cargo", Some("build"), "cargo build"),
			("cargo", Some("test"), "cargo test"),
			("bun", Some("test"), "bun test"),
			("bun", Some("install"), "bun install"),
			("git", Some("status"), "git status"),
			("git", Some("diff"), "git diff"),
			("go", Some("build"), "go build ./..."),
			("dotnet", Some("build"), "dotnet build"),
			("tsc", None, "tsc --noEmit"),
			("eslint", None, "eslint ."),
			("docker", Some("ps"), "docker ps -a"),
			("psql", Some("log"), "psql -c 'select 1'"),
			("ls", None, "ls -la"),
			("find", None, "find ."),
			("pytest", None, "pytest"),
			("jest", None, "jest"),
		];
		let captures: &[&str] = &[
			"FAIL src/a.test.ts\n  ● it works\n    expected 1 to be 2\n",
			"error[E0308]: mismatched types\n  --> src/main.rs:10:5\n   |\n10 |     let x: u8 = \
			 \"s\";\n",
			"a.ts:1:1: error TS2322: Type 'string' is not assignable\nb.ts:2:2: error TS2304: Cannot \
			 find name\n",
			" id | name  \n----+-------\n  1 | ada\n(1 row)\n",
			"./src/main.rs\n./src/lib.rs\n./tests/it.rs\n",
			"00)\n0\n\n00)(000\n0:\n",
			"warning: unused\nwarning: unused\nwarning: unused\n",
		];

		for &(program, subcommand, command) in arms {
			let ctx = context(program, subcommand, command, &config);
			for capture in captures {
				let crlf = capture.replace('\n', "\r\n");
				for exit_code in [0, 1] {
					let from_lf = filters::filter(&ctx, capture, exit_code).text;
					let from_crlf = filters::filter(&ctx, &crlf, exit_code).text;
					let from_crlf = normalize_carriage_returns(&from_crlf);
					assert_eq!(
						from_crlf, from_lf,
						"{program} {subcommand:?} exit {exit_code} answers differently for CRLF and LF \
						 spellings of {capture:?}",
					);
				}
			}
		}
	}
}
