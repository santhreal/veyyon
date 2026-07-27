//! Condensing output that has already been condensed must change nothing.
//!
//! WHY THIS IS A CONTRACT AND NOT A NICETY. The minimizer's filters chain, and
//! a captured output can reach a condenser twice: a wrapper condenses what an
//! inner filter already condensed, or a stored capture is replayed through the
//! pipeline again. Condensing runs noise-stripping FIRST and annotation LAST,
//! so on the second pass the stripper is reading the first pass's own
//! annotations as though a program had printed them.
//!
//! THE BUG THAT PROMPTED THIS SUITE. `condense_lint_output("eslint", "0
//! (×2)\n")` returned the EMPTY STRING. `0 (×2)` is the repeat counter this
//! minimizer writes for two identical `0` lines, and it is shaped exactly like
//! a tsc code-frame body line: a line-number gutter followed by source text. So
//! the noise stripper deleted it, the input became empty, and the agent was
//! handed nothing at all for a command that had printed something. Not a
//! smaller summary, nothing. Found by
//! `fuzz/fuzz_targets/minimizer_lint_condense.rs` asserting idempotence.
//!
//! The fix is one predicate, `primitives::is_minimizer_annotation`, consulted
//! before any noise pattern runs. The tests below cover every annotation shape
//! the minimizer emits, because the counter was only the one the fuzzer
//! happened to reach first: the `N diagnostics in M files` header, the elision
//! markers, and the `Top codes:` summary are all shaped like something a linter
//! prints.

use veyyon_shell::minimizer::{
	filters::lint::{condense_lint_output, group_diagnostics},
	primitives::is_minimizer_annotation,
};

/// Every program arm with a lint condenser. A fix that only covered eslint
/// would leave the identical hazard in the others.
const PROGRAMS: [&str; 4] = ["tsc", "eslint", "biome", "oxlint"];

mod the_regression {
	use super::*;

	/// The exact reproducer, pinned per program.
	#[test]
	fn a_repeat_counter_survives_a_second_pass() {
		for program in PROGRAMS {
			let once = condense_lint_output(program, "0\n0\n", 1);
			let twice = condense_lint_output(program, &once, 1);

			assert_eq!(once, "0 (×2)\n", "{program} should collapse two identical lines with a count");
			assert_eq!(twice, once, "{program} changed its own output on a second pass");
		}
	}

	/// The failure mode stated directly: the second pass must not empty the
	/// output. Asserted separately from equality because "became empty" is the
	/// consequence that mattered and a future regression could reach it by
	/// another route.
	#[test]
	fn a_second_pass_never_empties_non_empty_output() {
		for program in PROGRAMS {
			for input in ["0\n0\n", "1 x\n1 x\n", "3\n3\n3\n", "  7 foo\n  7 foo\n"] {
				let once = condense_lint_output(program, input, 1);
				if once.is_empty() {
					continue;
				}
				let twice = condense_lint_output(program, &once, 1);

				assert!(!twice.is_empty(), "{program} turned {once:?} into nothing on a second pass");
			}
		}
	}
}

mod every_annotation_shape_survives {
	use super::*;

	/// The counter, the elision markers, the grouping header, the per-file rows,
	/// and the code summary. Each is checked through the predicate AND through a
	/// real condense pass, because the predicate being right is not the same as
	/// it being consulted.
	#[test]
	fn the_predicate_recognizes_every_shape_the_minimizer_writes() {
		for line in [
			"warning: unused (×4)",
			"0 (×2)",
			"[…12ln elided…]",
			"  […3 diagnostics elided…]",
			"7 diagnostics in 2 files",
			"src/lib.rs (4 diagnostics)",
			"src/lib.rs (1 diagnostic)",
			"Top codes: no-unused-vars×3",
			"Top rules: no-explicit-any×2",
		] {
			assert!(is_minimizer_annotation(line), "{line:?} is written by the minimizer");
		}
	}

	/// The converse, and the one that matters more: ordinary program output must
	/// NOT be treated as an annotation, or the guard would preserve the noise
	/// the filters exist to remove.
	#[test]
	fn the_predicate_does_not_claim_ordinary_program_output() {
		for line in [
			"src/lib.rs:3:1: error unused variable",
			"3 │ interface Props {",
			"~~~~~",
			"^^^",
			"Checked 12 files",
			"found 0 problems",
			"✖ 3 problems (2 errors, 1 warning)",
			"1 error and 2 warnings found",
			"",
			"  at Object.<anonymous> (/a/b.js:1:1)",
		] {
			assert!(
				!is_minimizer_annotation(line),
				"{line:?} came from the program, not the minimizer"
			);
		}
	}

	/// A grouped diagnostic report fed back through grouping is unchanged. This
	/// is the header and per-file rows in their real context rather than as
	/// isolated strings.
	#[test]
	fn a_grouped_report_regroups_to_itself() {
		let input = "src/a.ts:1:1: error one\nsrc/a.ts:2:1: error two\nsrc/b.ts:1:1: error three\n";

		let once = group_diagnostics(input);
		let twice = group_diagnostics(&once);

		assert!(once.starts_with("3 diagnostics in 2 files\n"), "unexpected header: {once:?}");
		assert_eq!(twice, once, "regrouping a grouped report changed it");
	}
}

mod realistic_output_is_stable {
	use super::*;

	/// Real eslint stylish output, condensed twice. The suite would be
	/// decorative without one case that looks like what the tool actually
	/// captures.
	#[test]
	fn eslint_stylish_output_is_stable_under_a_second_pass() {
		let input = "\
/repo/src/app.ts
  1:1   error    'x' is defined but never used  no-unused-vars
  2:10  warning  Unexpected any                 @typescript-eslint/no-explicit-any

/repo/src/other.ts
  5:3   error    'y' is defined but never used  no-unused-vars

✖ 3 problems (2 errors, 1 warning)
  2 errors and 0 warnings potentially fixable with the `--fix` option.
";

		let once = condense_lint_output("eslint", input, 1);
		let twice = condense_lint_output("eslint", &once, 1);

		assert!(once.contains("3 diagnostics in 2 files"), "unexpected condensation: {once:?}");
		assert!(once.contains("Top rules:"), "the rule summary should survive: {once:?}");
		assert_eq!(twice, once, "condensing eslint output twice changed it");
	}

	/// tsc output through the same path, since the code-frame patterns that ate
	/// the counter are the tsc ones.
	#[test]
	fn tsc_output_is_stable_under_a_second_pass() {
		let input = "\
src/app.ts(3,1): error TS2304: Cannot find name 'x'.
src/app.ts(4,1): error TS2304: Cannot find name 'y'.
3 interface Props {
  ~~~~~~~~~
Found 2 errors in 1 file.
";

		let once = condense_lint_output("tsc", input, 2);
		let twice = condense_lint_output("tsc", &once, 2);

		assert_eq!(twice, once, "condensing tsc output twice changed it");
		assert!(!once.is_empty(), "tsc output should not condense to nothing");
	}

	/// A run of blank lines among the UNGROUPED remainder. The grouped branch of
	/// `group_diagnostics` pushed those lines verbatim, so forty blanks spent
	/// the whole ungrouped budget and the lines that said something were elided
	/// instead. Worse for this suite: the run survived the first pass, was
	/// collapsed by the second, and the elision count moved with it, so the same
	/// capture condensed to two different things depending on how many times it
	/// had been through. Found by `minimizer_lint_condense`.
	#[test]
	fn a_blank_run_among_ungrouped_lines_collapses_on_the_first_pass() {
		let mut input = String::from("src/a.ts:1:1: error one\n");
		input.push_str("noise\n");
		input.push_str(&"\n".repeat(50));
		input.push_str("the line that actually matters\n");

		let once = group_diagnostics(&input);
		let twice = group_diagnostics(&once);

		assert_eq!(twice, once, "a blank run made grouping depend on how many passes had run");
		assert!(
			once.contains("the line that actually matters"),
			"blank lines should not spend the ungrouped budget: {once:?}",
		);
	}

	/// Three passes, because idempotence proved at two can still drift at three
	/// if a pass alternates between two forms.
	#[test]
	fn a_third_pass_changes_nothing_either() {
		for program in PROGRAMS {
			let first = condense_lint_output(program, "warn\nwarn\nwarn\n", 1);
			let second = condense_lint_output(program, &first, 1);
			let third = condense_lint_output(program, &second, 1);

			assert_eq!(second, first, "{program} is not stable at the second pass");
			assert_eq!(third, second, "{program} is not stable at the third pass");
		}
	}
}

/// The two ways grouped output failed to survive being grouped again.
///
/// Both were found by `fuzz/fuzz_targets/minimizer_lint_condense.rs` after the
/// annotation predicate above had already fixed the noise-stripping half. They
/// are separate defects in `group_diagnostics` itself, and the second is the
/// more serious of the two.
mod grouped_output_survives_regrouping {
	use veyyon_shell::minimizer::filters::lint::group_diagnostics;

	/// A diagnostic with no message text must not print a line holding only its
	/// indent.
	///
	/// The indent is written before the text, so an empty message produced `"
	/// \n"`. Pass two's noise-stripping drops a whitespace-only line, so the
	/// two passes disagreed: `"…(1 diagnostics)\n  \n"` became `"…(1
	/// diagnostics)\n"`. The count stays truthful, because the diagnostic
	/// really was reported; there is simply nothing to show for it.
	#[test]
	fn an_empty_diagnostic_message_prints_no_line_at_all() {
		let input = "-/-|:1:1:\n";
		let once = group_diagnostics(input);

		assert!(
			!once
				.lines()
				.any(|line| !line.is_empty() && line.trim().is_empty()),
			"grouping emitted a whitespace-only line: {once:?}",
		);
		assert_eq!(group_diagnostics(&once), once, "grouping is not idempotent for an empty message");
	}

	/// THE serious one: grouping must not read its own summary back as a
	/// diagnostic.
	///
	/// Grouped output is shaped `<file> (<n> diagnostics)`, and
	/// `split_diagnostic` reads that back happily, because `-/:0 (1
	/// diagnostics)` splits into the path `-/` and a rest beginning with
	/// the line number `0`. So a second pass grouped the summary into a
	/// diagnostic ABOUT the summary and emitted a second header. Output that
	/// grows a layer every time it is condensed is the worst shape this can
	/// take, because captures do get re-minimized.
	#[test]
	fn a_summary_line_is_not_regrouped_into_a_diagnostic_about_itself() {
		let once = group_diagnostics("-/:0:1: something went wrong\n");
		let twice = group_diagnostics(&once);

		assert_eq!(twice, once, "grouping consumed its own summary: {once:?} -> {twice:?}");
		assert_eq!(
			twice.matches(" diagnostics in ").count(),
			once.matches(" diagnostics in ").count(),
			"a second pass added another header: {twice:?}",
		);
	}

	/// The exact bytes the fuzzer reduced to, pinned so the reproducer itself is
	/// the test.
	#[test]
	fn the_reduced_reproducer_is_stable() {
		let once = "1 diagnostics in 1 files\n-/:0 (1 diagnostics)\n";

		assert_eq!(group_diagnostics(once), once, "the fuzzer's own output was not a fixed point");
	}

	/// When every line is one this minimizer wrote, nothing groups and the input
	/// comes back untouched. That is what idempotence means for this function,
	/// stated directly rather than inferred from a round trip.
	#[test]
	fn output_made_entirely_of_annotations_is_returned_verbatim() {
		let annotations = "2 diagnostics in 1 files\nTop codes: E1 x2\nsrc/a.ts (2 diagnostics)\n";

		assert_eq!(group_diagnostics(annotations), annotations);
	}
}
