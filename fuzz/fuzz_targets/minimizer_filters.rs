#![no_main]

//! Fuzzes the shell output minimizer's filter dispatch in `veyyon-shell`.
//!
//! WHAT IS UNDER TEST. `minimizer::filters::filter` takes a program name, an
//! optional subcommand, and the raw stdout/stderr of a command, and rewrites
//! the output into something shorter before it reaches the agent. Behind that
//! one call sit two dozen hand-written parsers: git status, cargo diagnostics,
//! gradle phases, pytest summaries, docker tables, gh output, and more.
//!
//! WHY THIS IS THE HIGHEST-RISK PARSER SURFACE IN THE PROJECT. The input is the
//! output of an arbitrary program the user chose to run. Nobody controls it, it
//! is not a format with a specification, and each filter recognizes it by
//! looking for punctuation at particular offsets in particular lines. Every one
//! of those parsers is line arithmetic over text that can be truncated
//! mid-line, interrupted by an ANSI escape, or simply not be what the program
//! name implied. A panic here takes down the shell tool for a command that
//! merely printed something odd.
//!
//! THE PROPERTY THAT IS NOT "IT DID NOT PANIC". A minimizer that reports
//! `changed: true` while handing back the identical string makes the caller
//! persist a redundant artifact for every command forever, and one that reports
//! byte counts inconsistent with the strings it returned makes every downstream
//! size decision wrong. Both are asserted below, because both are silent.

use libfuzzer_sys::fuzz_target;
use veyyon_fuzz::{MAX_TEXT_BYTES, OutputLike};
use veyyon_shell::minimizer::{MinimizerConfig, MinimizerCtx, filters};

/// Program names the dispatcher routes differently.
///
/// Taken from the arms of `filters::supports` so the fuzzer reaches every
/// filter rather than whichever one an arbitrary string happens to hash to. The
/// last two entries are deliberately unrouted: an unknown program must fall
/// through to passthrough, and that arm is as load-bearing as the rest.
const PROGRAMS: &[&str] = &[
	"git",
	"yadm",
	"gt",
	"bun",
	"bunx",
	"cargo",
	"go",
	"golangci-lint",
	"cmake",
	"ctest",
	"ninja",
	"gtest",
	"dotnet",
	"mvn",
	"gradle",
	"gradlew",
	"ls",
	"tree",
	"find",
	"grep",
	"rg",
	"wc",
	"cat",
	"stat",
	"du",
	"df",
	"jq",
	"aws",
	"curl",
	"wget",
	"psql",
	"docker",
	"kubectl",
	"helm",
	"gh",
	"glab",
	"pytest",
	"ruff",
	"mypy",
	"python",
	"python3",
	"rspec",
	"rake",
	"rails",
	"rubocop",
	"rustfmt",
	"xxd",
	"strings",
	"od",
	"tsc",
	"eslint",
	"biome",
	"shellcheck",
	"markdownlint",
	"hadolint",
	"yamllint",
	"",
	"definitely-not-a-real-program",
];

/// Subcommands that change which branch a filter takes. `None` is generated
/// too.
const SUBCOMMANDS: &[&str] = &[
	"status", "diff", "log", "add", "commit", "push", "pull", "clone", "build", "test", "run",
	"check", "clippy", "install", "add", "ps", "images", "logs", "apply", "get", "pr", "issue",
	"clean", "",
];

/// Exit codes worth distinguishing: success, generic failure, a signal-shaped
/// code, and a negative one that a filter doing arithmetic on it may not
/// expect.
const EXIT_CODES: &[i32] = &[0, 1, 2, 101, 130, 255, -1, i32::MIN];

fuzz_target!(|input: (u8, u8, u8, OutputLike, OutputLike)| {
	let (program_byte, subcommand_byte, exit_byte, output, command) = input;
	if output.0.len() > MAX_TEXT_BYTES {
		return;
	}

	let program = PROGRAMS[usize::from(program_byte) % PROGRAMS.len()];
	// The high bit selects `None`, so "no subcommand" is reached as often as any
	// individual named one rather than being one case in twenty-five.
	let subcommand = if subcommand_byte & 0x80 == 0 {
		Some(SUBCOMMANDS[usize::from(subcommand_byte) % SUBCOMMANDS.len()])
	} else {
		None
	};
	let exit_code = EXIT_CODES[usize::from(exit_byte) % EXIT_CODES.len()];

	let config = MinimizerConfig::default();
	let ctx = MinimizerCtx { program, subcommand, command: &command.0, config: &config };

	// `supports` is a cheap predicate the engine consults before calling
	// `filter`, and it must not disagree with itself between calls.
	assert_eq!(
		filters::supports(program, subcommand),
		filters::supports(program, subcommand),
		"filters::supports is not a pure function for {program:?}/{subcommand:?}",
	);

	let result = filters::filter(&ctx, &output.0, exit_code);

	// The byte counts are what the caller uses to decide whether minimizing was
	// worth it and what to log. They must describe the strings actually returned.
	assert_eq!(
		result.input_bytes,
		output.0.len(),
		"{program:?} reported {} input bytes for a {}-byte input",
		result.input_bytes,
		output.0.len(),
	);
	assert_eq!(
		result.output_bytes,
		result.text.len(),
		"{program:?} reported {} output bytes for {} bytes of text",
		result.output_bytes,
		result.text.len(),
	);

	// `changed` gates whether the caller persists the original as an artifact and
	// splices an `artifact://` reference into the text. A filter that claims to
	// have changed nothing while returning different text loses the original; one
	// that claims a change it did not make stores a duplicate of every command's
	// output for the life of the session.
	assert_eq!(
		result.changed,
		result.text != output.0,
		"{program:?}/{subcommand:?} reported changed={} but text {} the input",
		result.changed,
		if result.text == output.0 {
			"equals"
		} else {
			"differs from"
		},
	);

	// `original_text` is documented as present only when the filter rewrote the
	// output, and it must be the input verbatim: it is what the caller persists
	// and what the agent later fetches when it needs the untruncated version.
	match &result.original_text {
		Some(original) => {
			assert!(result.changed, "{program:?} carried an original without reporting a change",);
			assert_eq!(original, &output.0, "{program:?} carried an altered original");
		},
		None => {},
	}

	// Determinism. The minimizer runs on a hot path and its output is quoted back
	// into the conversation, so two identical commands must minimize identically.
	let repeat = filters::filter(&ctx, &output.0, exit_code);
	assert_eq!(result.text, repeat.text, "{program:?} is not deterministic");
	assert_eq!(result.filter, repeat.filter, "{program:?} took a different dispatch path");

	// Idempotence, across every filter rather than only the lint ones.
	//
	// WHY IT BELONGS HERE AND NOT ONLY IN `minimizer_lint_condense`. Filters
	// chain, and a captured output can reach one twice: a wrapper condenses what
	// an inner filter already condensed, or a stored capture is replayed. Every
	// filter runs noise-stripping FIRST and annotation LAST, so the second pass
	// reads the first pass's own annotations as though a program had printed
	// them. That is not a lint-specific hazard, it is the shape of the pipeline,
	// and it produced a real bug: `condense_lint_output("eslint", "0 (×2)\n")`
	// returned the EMPTY STRING, because `0 (×2)` is this minimizer's own repeat
	// counter and is shaped exactly like a tsc code-frame body line.
	let second = filters::filter(&ctx, &result.text, exit_code);

	// The catastrophic direction first, stated separately because it is the
	// consequence that mattered: the agent was handed nothing at all for a
	// command that had printed something. A future regression could reach this by
	// a different route than the equality below.
	if !result.text.trim().is_empty() {
		assert!(
			!second.text.trim().is_empty(),
			"{program:?} turned {:?} into nothing on a second pass",
			result.text,
		);
	}

	// The INPUT is named, not just the two outputs. A failure here is reproduced
	// by hand, and "these two strings differ" without the bytes that produced
	// them sends you guessing at which of two dozen subcommands and eight exit
	// codes the fuzzer picked. Reproducing one of these cost more time than
	// fixing it.
	assert_eq!(
		second.text, result.text,
		"{program:?}/{subcommand:?} exit {exit_code} changed its own output on a second pass; \
		 command {:?}, input {:?}",
		command.0, output.0,
	);
});
