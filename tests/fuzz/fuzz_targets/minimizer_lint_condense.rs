#![no_main]

//! Fuzzes the lint-output condenser in `veyyon-shell`.
//!
//! WHAT IS UNDER TEST. `condense_lint_output` collapses the diagnostics of a
//! linter or type checker into a summary, and `group_diagnostics` is the
//! grouping pass underneath it. Both are `&str -> String` with no
//! configuration, which makes them the two cleanest fuzz targets in the crate
//! and the two whose failures are hardest to notice: they do not crash, they
//! quietly drop a diagnostic, and the agent then believes the file is clean.
//!
//! WHY IT IS SPLIT OUT OF `minimizer_filters`. The dispatch target reaches
//! these functions only through the `tsc`/`eslint`/`biome` arms and only with
//! whatever text the generator produced. Fuzzing them directly removes the
//! dispatcher from the search space, so every execution is spent on the parser
//! rather than on rediscovering which program name routes to it. A shared
//! corpus between the two targets is the point, not an accident: `cargo fuzz`
//! writes minimized inputs per target and they cross-pollinate through
//! `corpus/`.
//!
//! IDEMPOTENCE IS THE REAL ASSERTION. Condensing already-condensed output must
//! be a no-op. The minimizer can run over output that has already passed
//! through it (a wrapper script that echoes a previous run, a test that
//! captures and replays) and a condenser that keeps eating its own output
//! converges on nothing.

use libfuzzer_sys::fuzz_target;
use veyyon_fuzz::{MAX_TEXT_BYTES, OutputLike};
use veyyon_shell::minimizer::filters::lint;

/// Linters whose output shapes `condense_lint_output` recognizes. Includes one
/// unrecognized name so the passthrough arm stays covered.
const LINTERS: &[&str] = &[
	"tsc",
	"eslint",
	"biome",
	"shellcheck",
	"markdownlint",
	"hadolint",
	"yamllint",
	"not-a-linter",
];

const EXIT_CODES: &[i32] = &[0, 1, 2, 255, -1];

/// Length of `input` once the filters' documented trailing-newline
/// normalization is applied.
///
/// These filters rebuild their output line by line and terminate every line, so
/// input that did not end in a newline comes back one byte longer. That is
/// correct and is what the callers splice together, but it means a raw byte
/// comparison reports `" "` becoming `" \n"` as growth. Found by this target
/// on its second run, after the first version of the byte rule had already done
/// its job.
fn normalized_len(input: &str) -> usize {
	if input.is_empty() || input.ends_with('\n') {
		input.len()
	} else {
		input.len() + 1
	}
}

fuzz_target!(|input: (u8, u8, OutputLike)| {
	let (linter_byte, exit_byte, output) = input;
	if output.0.len() > MAX_TEXT_BYTES {
		return;
	}
	let program = LINTERS[usize::from(linter_byte) % LINTERS.len()];
	let exit_code = EXIT_CODES[usize::from(exit_byte) % EXIT_CODES.len()];

	let condensed = lint::condense_lint_output(program, &output.0, exit_code);

	// Grouping trades LINES for BYTES, and the bound has to say so.
	//
	// A file with k diagnostics costs a `path (k diagnostics)` row plus k indented
	// entries, so the grouped form is always LONGER in lines than what it grouped.
	// The win is that the path is printed once instead of k times, which is bytes.
	// An earlier version of this assertion said condensing never grows the line
	// count, and that is simply false about this filter: it fired on an ordinary
	// two-file report and would have had the grouping removed to satisfy it.
	//
	// NOT BYTES EITHER, and that distinction was worth its own round of this
	// fuzzer. The first version asserted bytes, and it correctly found that two
	// blank lines came back as a line reading ` (×2)`. But it also fires on
	// `a\na\n` becoming `a (×2)\n`, which is right: the counter costs six bytes
	// and tells you the program repeated itself. Asserting bytes universally would
	// be asserting the feature away. The byte rule is kept below for
	// whitespace-only input, where no annotation can be worth anything, which is
	// the case that found that bug.
	//
	// What must hold is that the growth is BOUNDED BY THE STRUCTURE: at worst one
	// file row per input line, plus the count header, plus the optional
	// `Top codes:` line. Anything past that is the filter reading its own output
	// back and layering a second summary over the first, which is the runaway this
	// target exists to catch -- `group_diagnostics` did exactly that before it
	// learned to recognize its own header.
	//
	// The INPUT and the OUTPUT are both named, not just the counts. A failure here
	// is reproduced by hand, and "3 lines became 5" without the bytes that produced
	// them sends you guessing at which of eight linters and five exit codes the
	// fuzzer picked. Reproducing one of these cost more time than fixing it.
	assert!(
		condensed.lines().count() <= 2 * output.0.lines().count() + 2,
		"{program:?} exit {exit_code} grew {} lines of lint output into {} lines, past one row per line plus two summary lines; input {:?}, output {condensed:?}",
		output.0.lines().count(),
		condensed.lines().count(),
		output.0,
	);
	if output.0.trim().is_empty() {
		assert!(
			condensed.len() <= normalized_len(&output.0),
			"{program:?} exit {exit_code} turned {} bytes of whitespace into {} bytes; input {:?}, output {condensed:?}",
			output.0.len(),
			condensed.len(),
			output.0,
		);
	}

	// Idempotence: the second pass has nothing left to remove.
	let twice = lint::condense_lint_output(program, &condensed, exit_code);
	assert_eq!(
		twice, condensed,
		"{program:?} exit {exit_code} is not idempotent; a second pass changed its own output; \
		 original input {:?}",
		output.0,
	);

	// The grouping pass on its own, under the same properties. It is called
	// directly by other filters, so it has to hold independently of the condenser
	// that usually wraps it.
	let grouped = lint::group_diagnostics(&output.0);
	// Same bound as above, and for the same reason: one file row per input line
	// plus the two summary lines is the most structure grouping can add.
	assert!(
		grouped.lines().count() <= 2 * output.0.lines().count() + 2,
		"group_diagnostics grew {} lines into {} lines, past one row per line plus two summary lines; input {:?}, output {grouped:?}",
		output.0.lines().count(),
		grouped.lines().count(),
		output.0,
	);
	if output.0.trim().is_empty() {
		assert!(
			grouped.len() <= normalized_len(&output.0),
			"group_diagnostics turned {} bytes of whitespace into {} bytes; input {:?}, output {grouped:?}",
			output.0.len(),
			grouped.len(),
			output.0,
		);
	}
	// The original capture is named alongside the two outputs, for the same reason
	// the assertions above name theirs: without the bytes that produced them a
	// failure here is a guessing game.
	assert_eq!(
		lint::group_diagnostics(&grouped),
		grouped,
		"group_diagnostics is not idempotent; original input {:?}",
		output.0,
	);
});
