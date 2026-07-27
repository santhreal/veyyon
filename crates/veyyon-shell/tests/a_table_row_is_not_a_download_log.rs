//! The transfer-progress stripper deletes download logs, not table rows.
//!
//! WHAT IT DID. `filter_aws`, `filter_http_transfer` and everything else in the
//! cloud filter run `strip_transfer_progress` first, which drops the lines wget
//! and curl write while a download is running. One of its rules was "the line
//! starts with `--` and contains `://`", meant for wget's `--2024-05-01 12:00:00--  https://host/path`. A table border is
//! a run of dashes, so any row whose cells put a colon before two slashes
//! matched it and was DELETED, and nothing said a line had gone.
//!
//! It did it to its own output, which is how it was found. A bordered row
//! normalizes to a leading dash run once the pipes become tabs, so a row that
//! survived the first pass started with `--` on the second, matched, and
//! vanished. The same capture minimized twice came back shorter than the same
//! capture minimized once, and captures get replayed.
//!
//! THE RULE NOW. A URL is judged by its SCHEME, which RFC 3986 defines as a
//! letter followed by letters, digits, `+`, `-` or `.`. `https://` has one and `::///` does not. The meter
//! rule is tightened the same way: wget writes `45%[===>   ]`, so the bracket
//! follows the percentage, and asking only that a line hold a `%`, a `[` and a
//! `]` somewhere claimed JSON fragments and shell globs as well.
//!
//! Found by `fuzz/fuzz_targets/minimizer_filters.rs`.

use veyyon_shell::minimizer::{MinimizerConfig, MinimizerCtx, filters};

mod common;

use common::enabled;

const fn ctx<'a>(
	program: &'a str,
	command: &'a str,
	config: &'a MinimizerConfig,
) -> MinimizerCtx<'a> {
	MinimizerCtx { program, subcommand: None, command, config }
}

mod what_is_still_stripped {
	use super::*;

	/// wget's own download log still goes. The whole point of the stripper is
	/// that these lines are noise, and a fix that stopped removing them would
	/// trade one defect for a louder one.
	#[test]
	fn a_wget_download_log_is_removed() {
		let config = enabled();
		let ctx = ctx("wget", "wget https://example.com/f.tar.gz", &config);
		let input = "--2024-05-01 12:00:00--  https://example.com/f.tar.gz\nResolving \
		             example.com...\nSaving to: 'f.tar.gz'\ndone\n";

		let output = filters::filter(&ctx, input, 0).text;

		assert!(!output.contains("2024-05-01"), "the log line goes: {output:?}");
		assert!(output.contains("done"), "the real output stays: {output:?}");
	}

	/// Every scheme wget can be pointed at, not just `https`. The scheme rule
	/// accepts a letter followed by letters, digits, `+`, `-` or `.`, which is
	/// what a scheme is.
	#[test]
	fn every_url_scheme_is_recognized() {
		let config = enabled();
		for url in [
			"https://example.com/f",
			"http://example.com/f",
			"ftp://example.com/f",
			"ftps://example.com/f",
			"s3://bucket/key",
			"git+ssh://host/repo",
		] {
			let ctx = ctx("wget", "wget", &config);
			let input = format!("--2024-05-01 12:00:00--  {url}\nreal output\n");

			let output = filters::filter(&ctx, &input, 0).text;

			assert!(!output.contains("2024-05-01"), "{url} was not recognized: {output:?}");
		}
	}

	/// wget's meter still goes, and the tightened rule is what catches it.
	#[test]
	fn the_wget_meter_is_removed() {
		let config = enabled();
		let ctx = ctx("wget", "wget https://example.com/f", &config);
		let input = "f.tar.gz    45%[========>          ]  12.3M  1.2MB/s\nreal output\n";

		let output = filters::filter(&ctx, input, 0).text;

		assert!(!output.contains("========>"), "the meter goes: {output:?}");
		assert!(output.contains("real output"), "{output:?}");
	}
}

mod what_is_no_longer_eaten {
	use super::*;

	/// THE regression: a border-looking row whose cells hold a colon and two
	/// slashes.
	#[test]
	fn a_dashed_row_with_a_bare_double_slash_survives() {
		let config = enabled();
		let ctx = ctx("aws", "aws describe", &config);
		let input = "--]0:::: ::///]\nreal output\n";

		let output = filters::filter(&ctx, input, 1).text;

		assert!(output.contains("::///"), "the row survives: {output:?}");
	}

	/// A line that opens with a dash run and happens to hold `://` inside a WORD
	/// is a URL and still goes; the same line with no scheme in front of it
	/// does not. Stated as a pair, because it is the exact boundary the fix
	/// moved.
	#[test]
	fn the_boundary_is_the_scheme_and_nothing_else() {
		let config = enabled();
		let ctx = ctx("aws", "aws describe", &config);

		let with_scheme = filters::filter(&ctx, "-- see http://host/p\nkeep\n", 1).text;
		assert!(!with_scheme.contains("host/p"), "a real URL still goes: {with_scheme:?}");

		let without_scheme = filters::filter(&ctx, "-- see ://host/p\nkeep\n", 1).text;
		assert!(without_scheme.contains("://host/p"), "no scheme, no strip: {without_scheme:?}");
	}

	/// A JSON fragment holding a percentage, a bracket and a closing bracket is
	/// not a meter. This is the second over-broad rule, and it needed no table
	/// to fire: any capture with those three characters lost the line.
	#[test]
	fn a_bracketed_percentage_is_not_a_meter() {
		let config = enabled();
		let ctx = ctx("aws", "aws describe", &config);
		let input = "usage: [cpu 90% of quota]\nreal output\n";

		let output = filters::filter(&ctx, input, 1).text;

		assert!(output.contains("90% of quota"), "the line survives: {output:?}");
	}
}

mod it_does_not_eat_its_own_output {
	use super::*;

	/// THE capture the fuzzer reduced, whole. A bordered table whose rows
	/// normalize to a leading dash run: the row survives the first pass and
	/// used to vanish on the second.
	#[test]
	fn the_fuzzers_capture_settles_after_one_pass() {
		let config = enabled();
		let command = "::[:::--\t\n \n\n|+|\r \n+-\t+\n\n\n\n\n\n\n\n";
		let ctx = ctx("aws", command, &config);
		// Short `concat!` chunks, not one long literal: `format_strings = true` makes
		// rustfmt split anything wider than `max_width`, and its splitting is
		// escape-unaware. It had already split this capture between the `\` and the `n`
		// of an escape, dropping a literal backslash, a raw newline and 13 spaces
		// into the middle of it. An idempotence test asserts a property of whatever
		// input it gets, so nothing failed and the mangled capture stopped being the
		// one the fuzzer found. Chunks stay under the width, so the formatter has
		// nothing to split. See crates/veyyon-shell/tests/
		// a_formatted_string_still_says_what_it_said.rs.
		let input = concat!(
			" ((((\n\n((((\r-x|\n\n\n|-------+---]0:::: ::///+|||||||",
			"|||||||||||\u{1b}||\n\n\n\n\n--]0:::: ::///]|||||||",
			"\u{1b}\nx\n\n\n\n\n\n\n\n\n|\n\n\n\n\n\n\n\r)]]\n|\n)/\n",
			"\n/\r\n\n\n\n\n\n\n||||||||/|+//:-:",
		);

		let first = filters::filter(&ctx, input, i32::MIN).text;
		let second = filters::filter(&ctx, &first, i32::MIN).text;

		assert_eq!(second, first, "the answer must not depend on how many passes have run");
		assert!(
			first.contains("-------+---]0"),
			"and the row the stripper used to eat is there on the first pass: {first:?}",
		);
	}

	/// The mechanism on its own, without the fuzzer's noise: a bordered table
	/// row that becomes a dash-leading line once its pipes are gone.
	#[test]
	fn a_bordered_row_that_normalizes_to_a_dash_run_survives_both_passes() {
		let config = enabled();
		let ctx = ctx("aws", "aws describe", &config);
		let input = "| name | url |\n|------+-----|\n| --a  | ://x |\n";

		let first = filters::filter(&ctx, input, 1).text;
		let second = filters::filter(&ctx, &first, 1).text;

		assert!(first.contains("://x"), "the row survives the first pass: {first:?}");
		assert_eq!(second, first, "and the second pass changes nothing");
	}
}
