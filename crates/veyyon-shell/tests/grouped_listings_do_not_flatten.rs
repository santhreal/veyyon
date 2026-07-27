//! A listing grouped by file stays grouped when it is filtered again.
//!
//! WHAT GROUPING IS. `primitives::group_by_file` turns a run of
//! `path:line:col: message` diagnostics into a `path:` header with the rest of
//! each line indented two spaces underneath it. That is most of the size win on
//! a compiler capture, and it is what makes a hundred diagnostics across six
//! files readable.
//!
//! THE BUG. Filters chain and captures get replayed, so a filter runs over its
//! own output as a matter of course, and the filters that group also normalize
//! each incoming line with `trim()`. The trim removed the two-space indent, so
//! the second pass saw a bare `path:` header with nothing under it, had nothing
//! left to group, and handed back a FLATTENED listing. The grouping simply came
//! undone, and it did so silently.
//!
//! `golangci-lint` gave `"\x1b:0"` -> `"\x1b:\n  0\n"` on one pass and
//! `"\x1b:\n0\n"` on the next, which is how the fuzzer found it, but the shape
//! that matters is the ordinary one: a cargo or dotnet or go build capture that
//! has been filtered twice loses the per-file structure the filter exists to
//! produce. A filter whose answer depends on how many times it has run also
//! cannot be cached, compared across runs, or replayed.
//!
//! THE RULE NOW. `is_grouped_listing` recognizes the shape, `group_by_file`
//! returns an already-grouped listing untouched, and the filters that trim on
//! the way in check before they trim. The indent itself has one owner
//! (`GROUP_ENTRY_INDENT`), because a listing whose reader and writer disagree
//! by one space is a listing that never settles. Found by
//! `fuzz/fuzz_targets/minimizer_filters.rs`, whose property is that a filter
//! does not change its own output on a second pass.

use std::fmt::Write as _;

use veyyon_shell::minimizer::{
	MinimizerCtx, filters,
	primitives::{group_by_file, is_grouped_listing},
};

mod common;

use common::{context, enabled};

/// Filter `input`, then filter the result, and return both.
fn two_passes(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> (String, String) {
	let first = filters::filter(ctx, input, exit_code).text;
	let second = filters::filter(ctx, &first, exit_code).text;
	(first, second)
}

mod the_predicate_recognizes_exactly_what_the_grouper_writes {
	use super::*;

	/// A header with an entry under it is a grouped listing.
	#[test]
	fn a_header_followed_by_an_indented_entry_is_recognized() {
		assert!(is_grouped_listing("src/main.rs:\n  10:5: error[E0308]: mismatched types\n"));
	}

	/// The grouper's own output is recognized, which is the property that makes
	/// the whole rule self-consistent.
	///
	/// Asserted through `group_by_file` rather than against a hand-written
	/// string so that changing the indent cannot break the reader without
	/// breaking this test.
	#[test]
	fn the_grouper_output_is_recognized_as_grouped() {
		let grouped =
			group_by_file("src/main.rs:10:5: mismatched types\nsrc/main.rs:12:1: unused import\n", 20);
		assert!(grouped.starts_with("src/main.rs:\n"), "sanity: {grouped:?}");
		assert!(
			is_grouped_listing(&grouped),
			"the grouper must recognize its own output: {grouped:?}"
		);
	}

	/// A header with nothing under it is not a listing.
	///
	/// This is the flattened form the bug produced. It has to read as ordinary
	/// program output, otherwise a genuinely ungrouped capture that happens to
	/// end a line with a colon would never be grouped at all.
	#[test]
	fn a_header_with_no_entry_under_it_is_not_a_listing() {
		assert!(!is_grouped_listing("src/main.rs:\n10:5: error\n"));
	}

	/// An indented header does not open a group.
	///
	/// The grouper writes headers at column zero, and it refuses to group a line
	/// that starts with a space, so an indented `path:` came from the program.
	#[test]
	fn an_indented_header_is_not_a_listing() {
		assert!(!is_grouped_listing("  src/main.rs:\n    10:5: error\n"));
	}

	/// A deeper indent under a header is program output, not an entry.
	///
	/// The boundary of the shape: entries are indented by exactly the grouper's
	/// indent. Anything else is a block the program formatted itself, and
	/// treating it as a listing would stop that block from ever being minimized.
	#[test]
	fn a_deeper_indent_under_a_header_is_not_an_entry() {
		assert!(!is_grouped_listing("note:\n      expected `u32`, found `String`\n"));
	}

	/// A blank indented line does not count as an entry.
	#[test]
	fn a_blank_indented_line_is_not_an_entry() {
		assert!(!is_grouped_listing("src/main.rs:\n  \n"));
	}

	/// Ordinary diagnostics carry no listing, however many colons they contain.
	#[test]
	fn ungrouped_diagnostics_are_not_a_listing() {
		assert!(!is_grouped_listing(
			"src/main.rs:10:5: error[E0308]: mismatched types\nsrc/lib.rs:3:1: warning: unused\n"
		));
	}

	/// Empty input is not a listing, and asking must not panic.
	#[test]
	fn empty_input_is_not_a_listing() {
		assert!(!is_grouped_listing(""));
		assert!(!is_grouped_listing("\n\n\n"));
		assert!(!is_grouped_listing(":"));
	}
}

mod the_grouper_leaves_its_own_listing_alone {
	use super::*;

	/// THE regression at the primitive. Regrouping a listing would read
	/// `10:5: message` as a file called `10`.
	#[test]
	fn regrouping_a_listing_returns_it_unchanged() {
		let once =
			group_by_file("src/main.rs:10:5: mismatched types\nsrc/lib.rs:3:1: unused import\n", 20);
		assert_eq!(group_by_file(&once, 20), once, "a settled listing must not be regrouped");
	}

	/// And the entries keep their real content rather than becoming headers.
	///
	/// The negative twin: a guard that merely returned early on any input would
	/// pass the assertion above, so the content is pinned too.
	#[test]
	fn a_listing_keeps_its_entries_under_the_right_headers() {
		let once =
			group_by_file("src/main.rs:10:5: mismatched types\nsrc/main.rs:12:1: unused import\n", 20);
		assert_eq!(once, "src/main.rs:\n  10:5: mismatched types\n  12:1: unused import\n");
		assert_eq!(group_by_file(&once, 20), once);
	}

	/// Grouping an ungrouped capture still works, which is the whole point of
	/// the primitive and the thing the guard must not break.
	#[test]
	fn an_ungrouped_capture_is_still_grouped() {
		let grouped = group_by_file("a.go:1:1: first\nb.go:2:2: second\na.go:3:3: third\n", 20);
		assert_eq!(grouped, "a.go:\n  1:1: first\n  3:3: third\nb.go:\n  2:2: second\n");
	}

	/// The per-file cap and its "more" line are part of the listing and survive
	/// a second pass too.
	///
	/// The elision line is indented like an entry, so a reader that only looked
	/// at indent would already stop; this pins that the count itself does not
	/// drift, which is how the elision-marker family of bugs presented.
	#[test]
	fn the_per_file_cap_line_does_not_drift() {
		let mut input = String::new();
		for n in 1..=5 {
			let _ = writeln!(input, "a.go:{n}:1: issue {n}");
		}
		let once = group_by_file(&input, 2);
		assert_eq!(once, "a.go:\n  1:1: issue 1\n  2:1: issue 2\n  … 3 more\n");
		assert_eq!(group_by_file(&once, 2), once, "the cap line must not be recounted");
	}
}

mod filters_that_trim_check_before_they_trim {
	use super::*;

	/// THE regression as the fuzzer reported it, through the real dispatcher.
	///
	/// A single diagnostic is grouped under its file header on the first pass,
	/// and the second pass used to trim the indent back off, so the same text
	/// meant two different things depending on how many times it had been
	/// filtered. The fuzzer's own reduced input was `"\x1b:0"`, and it no longer
	/// reaches the grouper: `strip_ansi` drops the stray escape, leaving a line
	/// whose file part is empty. The mechanism is identical and the shape below
	/// is the one an operator actually sees.
	#[test]
	fn golangci_lint_does_not_flatten_its_own_grouping() {
		let config = enabled();
		let ctx = context("golangci-lint", Some("apply"), "", &config);
		let (first, second) = two_passes(&ctx, "x:0\n\n\n\n\n\n", 101);
		assert_eq!(first, "x:\n  0\n", "the first pass groups: {first:?}");
		assert_eq!(second, first, "the second pass must not un-indent it");
	}

	/// A realistic golangci-lint capture keeps its grouping across passes.
	///
	/// The reduced case above proves the mechanism; this proves the thing an
	/// operator actually reads, because a flattened listing is a readability
	/// regression on every real capture, not just on the fuzzer's input.
	#[test]
	fn a_real_lint_capture_keeps_its_per_file_grouping() {
		let config = enabled();
		let ctx = context("golangci-lint", Some("run"), "golangci-lint run", &config);
		let input = "main.go:12:6: exported func Foo should have comment (golint)\nmain.go:31:2: \
		             ineffectual assignment to err (ineffassign)\nutil/str.go:8:1: don't use \
		             underscores (golint)\n";
		let (first, second) = two_passes(&ctx, input, 1);

		assert!(first.contains("main.go:\n  12:6:"), "the first pass groups by file: {first:?}");
		assert!(first.contains("util/str.go:\n  8:1:"), "every file gets a header: {first:?}");
		assert_eq!(second, first, "and the grouping survives a second pass");
	}

	/// The go build filter takes the same trim-then-group route.
	#[test]
	fn go_build_does_not_flatten_its_own_grouping() {
		let config = enabled();
		let ctx = context("go", Some("build"), "go build ./...", &config);
		let input = "# example.com/app\nmain.go:10:2: undefined: Foo\nmain.go:14:9: undefined: Bar\n";
		let (first, second) = two_passes(&ctx, input, 1);

		assert!(first.contains("main.go:\n  10:2: undefined: Foo"), "got: {first:?}");
		assert_eq!(second, first, "the grouping must survive a second pass");
	}

	/// And so does go vet.
	#[test]
	fn go_vet_does_not_flatten_its_own_grouping() {
		let config = enabled();
		let ctx = context("go", Some("vet"), "go vet ./...", &config);
		let input = "# example.com/app\nmain.go:7:2: unreachable code\nmain.go:19:4: printf: wrong \
		             arg count\n";
		let (first, second) = two_passes(&ctx, input, 1);

		assert!(first.contains("main.go:\n  7:2: unreachable code"), "got: {first:?}");
		assert_eq!(second, first, "the grouping must survive a second pass");
	}

	/// And the dotnet build filter, which trims for a different reason (it
	/// truncates long `MSBuild` lines) and lost the indent the same way.
	#[test]
	fn dotnet_build_does_not_flatten_its_own_grouping() {
		let config = enabled();
		let ctx = context("dotnet", Some("build"), "dotnet build", &config);
		let input = "src/App.cs(10,5): error CS1002: ; expected\nsrc/App.cs(14,1): error CS0103: \
		             name not found\n";
		let (first, second) = two_passes(&ctx, input, 1);

		assert!(first.starts_with("dotnet build: failed\n"), "got: {first:?}");
		assert!(first.contains("error CS1002"), "the diagnostics survive: {first:?}");
		assert_eq!(second, first, "and the whole block settles after one pass");
	}

	/// Grouped output stays fixed across several passes, since a fix that merely
	/// alternated between two answers would satisfy a single repeat.
	#[test]
	fn a_grouped_listing_stays_fixed_across_repeated_passes() {
		let config = enabled();
		let ctx = context("golangci-lint", Some("run"), "golangci-lint run", &config);
		let mut text =
			filters::filter(&ctx, "a.go:1:1: first (govet)\nb.go:2:2: second (govet)\n", 1).text;
		let expected = text.clone();
		for pass in 1..=4 {
			text = filters::filter(&ctx, &text, 1).text;
			assert_eq!(text, expected, "pass {pass} rewrote a settled listing");
		}
	}
}

mod lifting_lines_out_does_not_leave_a_gap {
	use super::*;

	/// Grouping must not leave two blank lines where it removed a line.
	///
	/// THE BUG. Grouping LIFTS the diagnostics out of the middle of the capture
	/// and reprints them at the top, so anything that surrounded them closes up
	/// behind them. Two blanks that the program printed one line apart end up
	/// adjacent, and that run was never in the capture: the grouping invented
	/// it.
	///
	/// WHY IT NEVER SETTLED. Every filter downstream squeezes blank runs, so the
	/// pass that grouped emitted the run and the pass after it removed one, and
	/// the two answers disagreed forever. `cargo fmt` and `pipe` both did this
	/// on `"find: 2 paths in 2 dirs\n\n./ 10:5: boom\n\nsrc/ main.rs:\n"`.
	/// Found by `every_arm_settles_on_every_other_arms_output`, which is the
	/// only test that feeds one filter's output to another filter's parser.
	#[test]
	fn a_lifted_diagnostic_does_not_leave_a_double_blank_behind() {
		let grouped = group_by_file("first\n\na.rs:1:1: boom\n\nlast\n", 20);

		assert!(
			grouped.starts_with("a.rs:\n  1:1: boom\n"),
			"the diagnostic is grouped: {grouped:?}"
		);
		assert!(!grouped.contains("\n\n\n"), "and the gap it left is closed: {grouped:?}");
		assert_eq!(grouped, "a.rs:\n  1:1: boom\nfirst\n\nlast\n");
	}

	/// A blank the program really printed is still kept.
	///
	/// The negative twin: the rule is about a run the grouping created, not
	/// about deleting the separators the program used to structure its output.
	#[test]
	fn a_single_blank_between_two_ungrouped_lines_survives() {
		let grouped = group_by_file("a.rs:1:1: boom\nheading\n\nbody\n", 20);
		assert_eq!(grouped, "a.rs:\n  1:1: boom\nheading\n\nbody\n");
	}

	/// Several lifted diagnostics in a row collapse to one gap, not none and not
	/// three.
	#[test]
	fn several_lifted_diagnostics_leave_exactly_one_blank() {
		let grouped = group_by_file("top\n\na.rs:1:1: one\n\nb.rs:2:2: two\n\nbottom\n", 20);
		assert_eq!(grouped, "a.rs:\n  1:1: one\nb.rs:\n  2:2: two\ntop\n\nbottom\n");
	}

	/// And the capture that found it settles through the real filters.
	#[test]
	fn the_capture_that_found_it_settles_after_one_pass() {
		let config = enabled();
		let input = "find: 2 paths in 2 dirs\n\n./ 10:5: boom\n\nsrc/ main.rs:\n";
		for (program, subcommand, command) in
			[("cargo", Some("fmt"), "cargo fmt"), ("pipe", None, "pipe")]
		{
			let ctx = context(program, subcommand, command, &config);
			let (first, second) = two_passes(&ctx, input, 0);
			assert_eq!(second, first, "{program} changed its own output on a second pass");
			assert!(!first.contains("\n\n\n"), "{program} invented a blank run: {first:?}");
		}
	}
}
