//! `veyyon_uu_diff::uu_app()`: argument parsing for the in-process `diff` builtin.
//!
//! WHY THE PARSER AND NOT THE COMMAND. `veyyon-uu-diff` exposes `run(argv) -> i32`, and that is the
//! wrong thing to point a fuzzer at: `run` opens files, walks directories, and writes to the scope's
//! stdout, so fuzzing it would generate filesystem operations on the machine running the fuzzer at a
//! few thousand executions a second. What is worth fuzzing is the part that decides rather than the
//! part that acts, and for a command-line utility that is `uu_app().try_get_matches_from`, which
//! touches nothing outside the argv it is handed.
//!
//! WHAT CAN ACTUALLY BE WRONG HERE. `clap` panics rather than returns an error when the command is
//! misconfigured: a long flag defined twice, a short flag colliding with another, a `default_missing_value`
//! that its own `value_parser` rejects, a `num_args` range that no invocation can satisfy. Those
//! checks fire when an invocation reaches the affected argument, not when the `Command` is built, so
//! a misconfiguration can sit in a release for as long as nobody passes that particular combination.
//! `diff` has three of the shapes that go wrong most often: `infer_long_args(true)`, so every unique
//! prefix of a long flag is also a long flag and two flags can become ambiguous; `--color` with
//! `require_equals` and `num_args(0..=1)`, which is the optional-value case; and a required
//! positional taking exactly two values, which interacts with everything before it.
//!
//! WHAT IS CHECKED BEYOND "IT DID NOT PANIC".
//!
//! 1. A successful parse always yields exactly two file operands. `num_args(2)` and `required(true)`
//!    together promise that, and every later line of `run` indexes into the result assuming it.
//! 2. `-U NUM` parses to a `usize` whenever it is accepted, so the accept decision and the value
//!    decision cannot disagree. If they ever did, the caller would see a present flag with no value.
//! 3. Parsing is deterministic. The same argv parsed twice gives the same verdict and the same
//!    operands, which is what makes a reported reproducer meaningful.
//! 4. Rendering an error never panics. `run` writes the error out, so a parse that fails and then
//!    panics while explaining itself is the same crash to a user as one that panicked outright.

#![no_main]

use std::ffi::OsString;

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use veyyon_fuzz::{ArgLike, MAX_ARGV_LEN};

/// Argument spellings the command actually distinguishes.
///
/// Taken from the arms of `uu_app` plus the ones every CLI reserves. Without
/// this table a byte-level generator reaches `-u` occasionally and `--color=auto`
/// essentially never, so the optional-value and inference paths would go
/// untested while the fuzzer spent its whole run on the unknown-flag arm. The
/// deliberately odd entries are the point: `--un` is an ambiguous prefix under
/// `infer_long_args` because both `unified` and `unified-flag` start with it,
/// `--color` without a value exercises `require_equals`, and `--` and `-` are
/// end-of-options and stdin.
const KNOWN_ARGS: &[&str] = &[
	"-u",
	"-U",
	"-U3",
	"--unified",
	"--unified=3",
	"--unified=",
	"--unified=-1",
	"--un",
	"--unified-flag",
	"-q",
	"--brief",
	"-r",
	"--recursive",
	"-N",
	"--new-file",
	"--color",
	"--color=auto",
	"--color=never",
	"--color never",
	"--help",
	"--version",
	"-h",
	"-V",
	"--",
	"-",
	"-uqrN",
	"a",
	"b",
];

/// One generated argument: a known spelling, or arbitrary bytes.
///
/// Both arms are needed. The table alone would only ever produce invocations
/// someone could have typed, and the byte arm alone would almost never produce
/// a recognized flag.
#[derive(Arbitrary, Debug)]
enum Token {
	Known(u8),
	Raw(ArgLike),
}

impl Token {
	fn to_os_string(&self) -> OsString {
		match self {
			Self::Known(index) => {
				OsString::from(KNOWN_ARGS[usize::from(*index) % KNOWN_ARGS.len()])
			},
			Self::Raw(arg) => arg.to_os_string(),
		}
	}
}

fuzz_target!(|tokens: Vec<Token>| {
	if tokens.len() > MAX_ARGV_LEN {
		return;
	}

	// `try_get_matches_from` reads the first element as the program name, exactly as a real
	// invocation does, so the generated tokens start at index one.
	let mut argv: Vec<OsString> = Vec::with_capacity(tokens.len() + 1);
	argv.push(OsString::from("diff"));
	argv.extend(tokens.iter().map(Token::to_os_string));

	let first = veyyon_uu_diff::uu_app().try_get_matches_from(argv.clone());
	let second = veyyon_uu_diff::uu_app().try_get_matches_from(argv.clone());

	match (first, second) {
		(Ok(matches), Ok(again)) => {
			let files: Vec<&OsString> = matches
				.get_many::<OsString>("files")
				.expect("a successful parse must carry the required file operands")
				.collect();
			assert_eq!(
				files.len(),
				2,
				"accepted {argv:?} with {} operands, but `diff` takes exactly two",
				files.len()
			);

			if matches.contains_id("unified") {
				assert!(
					matches.get_one::<usize>("unified").is_some(),
					"`-U` was accepted for {argv:?} without a parsed value"
				);
			}

			let again_files: Vec<&OsString> = again
				.get_many::<OsString>("files")
				.expect("the second parse must agree with the first")
				.collect();
			assert_eq!(files, again_files, "parsing {argv:?} twice gave different operands");
		},
		(Err(error), Err(again)) => {
			assert_eq!(
				error.kind(),
				again.kind(),
				"parsing {argv:?} twice gave different error kinds"
			);
			// `run` prints this, so it has to be renderable rather than merely constructible.
			let rendered = error.render().to_string();
			assert!(
				!rendered.is_empty(),
				"rejected {argv:?} with an error that renders to nothing"
			);
		},
		(first, second) => {
			panic!(
				"parsing {argv:?} twice disagreed: {:?} then {:?}",
				first.map(|_| "ok").map_err(|e| e.kind()),
				second.map(|_| "ok").map_err(|e| e.kind())
			);
		},
	}
});
