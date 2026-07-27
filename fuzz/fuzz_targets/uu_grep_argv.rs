//! `veyyon_uu_grep::try_parse_argv`: argument parsing for the in-process `grep` and `rg` builtins.
//!
//! WHY THIS TARGET AND NOT `run`. Both commands expose `run(argv) -> i32`, and both search the
//! filesystem, so generating inputs for the obvious entry point would generate directory walks on
//! the machine running the fuzzer rather than parses. `try_parse_argv` is the deciding half with the
//! acting half removed. On the `grep` side it is not a second implementation: `run` and this call
//! share one private `parse`, so a defect found here is a defect users hit.
//!
//! WHY IT IS WORTH THE RUN. This is the larger of the two builtin flag tables by a wide margin, and
//! `clap` panics rather than errors on a misconfigured command, at the moment an invocation reaches
//! the affected argument. A duplicate long flag or a default that its own value parser rejects can
//! therefore sit in a release until somebody types the combination that reveals it. `grep` also
//! rewrites its argv before clap sees it, because `grep -3` is a valid way to ask for three lines of
//! context, and a rewrite that changes an argument it was not supposed to touch is a wrong search
//! rather than a crash, which is the failure mode nobody notices.
//!
//! WHAT IS CHECKED BEYOND "IT DID NOT PANIC".
//!
//! 1. Parsing is deterministic: the same argv gives the same verdict twice, and the same error kind.
//! 2. The `-NUM` rewrite preserves the program name and never loses or invents an argument, so an
//!    invocation cannot silently gain or drop an operand on its way to the parser.
//! 3. The only rewrite that happens is `-NUM` into `--context=NUM`. Any argument that changed in any
//!    other way is one the rewrite had no business touching. Stated this way rather than as "nothing
//!    after `--` changes", which is not actually invariant: a `--` in value position (`grep -e --`)
//!    is a pattern rather than a separator, and telling the two apart means reimplementing the
//!    parser inside the oracle, which is how an oracle starts agreeing with a bug. The `--` cases
//!    are pinned with fixed argv in `crates/veyyon-uu-grep/tests/argument_surface.rs` instead.
//! 4. The rewrite is idempotent. It rewrites `-3` into a long form, and running it again must not
//!    rewrite that form into something else, which is what would happen if it recognized its own
//!    output.

#![no_main]

use std::ffi::OsString;

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use veyyon_fuzz::{ArgLike, MAX_ARGV_LEN};

/// Argument spellings the two commands actually distinguish.
///
/// A byte-level generator reaches `-i` from time to time and `--context=3` never,
/// so without this table the run would be spent almost entirely on the
/// unknown-flag arm. The context shorthands are over-represented because they are
/// the ones rewritten before parsing, `--` and `-` are end-of-options and stdin,
/// and the value-taking flags appear both spellings so the `=` form and the
/// separate-argument form are both reached.
const KNOWN_ARGS: &[&str] = &[
	"-3",
	"-0",
	"-12",
	"-A",
	"-A2",
	"-B",
	"-C",
	"--after-context=2",
	"--before-context",
	"--context=1",
	"-e",
	"-e pattern",
	"--regexp=pattern",
	"-f",
	"--file=list.txt",
	"-i",
	"--ignore-case",
	"-v",
	"--invert-match",
	"-w",
	"-x",
	"-c",
	"--count",
	"-l",
	"-L",
	"-n",
	"-o",
	"-q",
	"-r",
	"-R",
	"--recursive",
	"-s",
	"-h",
	"-H",
	"--include=*.rs",
	"--exclude-dir=target",
	"--devices=skip",
	"--directories=recurse",
	"--color=never",
	"--json",
	"--type-list",
	"--files",
	"--vimgrep",
	"--only-matching",
	"--max-count=1",
	"--help",
	"--version",
	"--",
	"-",
	"pattern",
	"file.txt",
];

/// One generated argument: a known spelling, or arbitrary bytes.
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

/// Which of the two commands to parse as. They share a crate and nothing else.
#[derive(Arbitrary, Debug)]
enum Command {
	Grep,
	Rg,
}

#[derive(Arbitrary, Debug)]
struct Case {
	command: Command,
	tokens:  Vec<Token>,
}

/// The rewrite must not change how many arguments there are, only what some of
/// them say, and must leave everything after `--` exactly as it was.
fn check_context_rewrite(argv: &[OsString]) {
	let rewritten = veyyon_uu_grep::normalize_context_args(argv.to_vec());

	assert_eq!(
		rewritten.first(),
		argv.first(),
		"the rewrite changed the program name"
	);
	assert_eq!(
		rewritten.len(),
		argv.len(),
		"the rewrite changed how many arguments there are"
	);

	for (before, after) in argv.iter().zip(&rewritten) {
		if before == after {
			continue;
		}
		// The only rewrite there is. Anything else that changed is an argument the rewrite had no
		// business touching, and stating it this way needs no model of which position an argument is
		// in, which is the part a fuzz oracle cannot afford to reimplement.
		let digits = before
			.to_str()
			.and_then(|text| text.strip_prefix('-'))
			.expect("only a decodable `-NUM` argument is ever rewritten");
		assert!(
			!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()),
			"the rewrite changed {before:?} into {after:?}, which is not the `-NUM` shorthand"
		);
		assert_eq!(
			after,
			&OsString::from(format!("--context={digits}")),
			"the shorthand {before:?} was rewritten into something other than its long form"
		);
	}

	// Idempotence: rewriting the rewrite must be a no-op, or the long form the
	// rewrite emits is itself being recognized as something to rewrite.
	assert_eq!(
		veyyon_uu_grep::normalize_context_args(rewritten.clone()),
		rewritten,
		"the context rewrite is not idempotent for {argv:?}"
	);
}

fuzz_target!(|case: Case| {
	if case.tokens.len() > MAX_ARGV_LEN {
		return;
	}

	let program = match case.command {
		Command::Grep => "grep",
		Command::Rg => "rg",
	};
	let mut argv: Vec<OsString> = Vec::with_capacity(case.tokens.len() + 1);
	argv.push(OsString::from(program));
	argv.extend(case.tokens.iter().map(Token::to_os_string));

	let (first, second) = match case.command {
		Command::Grep => {
			check_context_rewrite(&argv);
			(
				veyyon_uu_grep::try_parse_argv(argv.clone()),
				veyyon_uu_grep::try_parse_argv(argv.clone()),
			)
		},
		Command::Rg => (
			veyyon_uu_grep::try_parse_rg_argv(argv.clone()),
			veyyon_uu_grep::try_parse_rg_argv(argv.clone()),
		),
	};

	match (first, second) {
		(Ok(()), Ok(())) => {},
		(Err(error), Err(again)) => {
			assert_eq!(
				error.kind(),
				again.kind(),
				"parsing {argv:?} twice gave different error kinds"
			);
			// The caller prints this, so a parse that fails and then panics while
			// explaining itself is the same crash to a user as one that panicked outright.
			assert!(
				!error.render().to_string().is_empty(),
				"rejected {argv:?} with an error that renders to nothing"
			);
		},
		(first, second) => {
			panic!(
				"parsing {argv:?} twice disagreed: {:?} then {:?}",
				first.map(|()| "ok").map_err(|e| e.kind()),
				second.map(|()| "ok").map_err(|e| e.kind())
			);
		},
	}
});
