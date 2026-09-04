//! The argument surface of the `grep` and `rg` builtins, checked without
//! searching anything.
//!
//! WHY THIS SUITE EXISTS. Both commands used to parse inline inside `run`,
//! which meant the only way to ask what an invocation is accepted as was to run
//! it against a real directory and read the output. So nothing checked the flag
//! table directly, and questions with exact answers, such as whether two long
//! flags are ambiguous under prefix inference or whether an option that
//! requires a value rejects an argv that ends before giving it one, were
//! answered by inspection. Splitting `try_parse_argv` out of `run` made them
//! answerable, and these cases are the answers.
//!
//! WHAT IS AT STAKE. `clap` panics rather than returns an error when the
//! command is misconfigured, and it does so only once an invocation reaches the
//! affected argument, so a duplicate long flag or a default value its own
//! parser rejects can ship and stay hidden until somebody types the combination
//! that reveals it. The `-NUM` rewrite matters for a quieter reason: it runs
//! before clap and rewrites arguments, so a rewrite that touches one it should
//! not have produces a search that succeeds with the wrong parameters, which no
//! exit code reports.

use std::{
	collections::HashMap,
	ffi::OsString,
	io::{self, Write},
	path::PathBuf,
	sync::{Arc, Mutex, atomic::AtomicBool},
};

use veyyon_uu_grep::{normalize_context_args, try_parse_argv, try_parse_rg_argv};
use veyyon_uutils_ctx::ScopeIo;

/// A writer that appends to a buffer the test can read afterwards.
#[derive(Clone)]
struct Shared(Arc<Mutex<Vec<u8>>>);

impl Write for Shared {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		self
			.0
			.lock()
			.expect("the sink is never poisoned")
			.extend_from_slice(buf);
		Ok(buf.len())
	}

	fn flush(&mut self) -> io::Result<()> {
		Ok(())
	}
}

/// Run `f` inside a uutils scope, collecting what it wrote to stderr.
///
/// The builtins write through the scope rather than to the process streams, so
/// without one there is nothing to read back and nothing isolating the test
/// from the terminal.
fn capture(stderr: &mut Vec<u8>, f: impl FnOnce() -> i32) -> i32 {
	let sink = Arc::new(Mutex::new(Vec::new()));
	let io = ScopeIo {
		stdin:                 Box::new(io::empty()),
		stdin_fd:              None,
		stdin_is_search_input: false,
		stdout:                Box::new(io::sink()),
		stdout_is_terminal:    false,
		stderr:                Box::new(Shared(Arc::clone(&sink))),
		cwd:                   PathBuf::from("."),
		env:                   HashMap::new(),
		cancel:                Arc::new(AtomicBool::new(false)),
	};

	let code = veyyon_uutils_ctx::scope(io, f);
	stderr.extend_from_slice(&sink.lock().expect("the sink is never poisoned"));
	code
}

fn argv(args: &[&str]) -> Vec<OsString> {
	std::iter::once(OsString::from("grep"))
		.chain(args.iter().map(OsString::from))
		.collect()
}

fn rg_argv(args: &[&str]) -> Vec<OsString> {
	std::iter::once(OsString::from("rg"))
		.chain(args.iter().map(OsString::from))
		.collect()
}

fn rewritten(args: &[&str]) -> Vec<String> {
	normalize_context_args(argv(args))
		.into_iter()
		.map(|arg| arg.to_string_lossy().into_owned())
		.collect()
}

// ─── grep: what the command accepts ─────────────────────────────────────────

/// The ordinary invocation, which every other case is a deviation from.
#[test]
fn accepts_a_pattern_and_a_file() {
	assert!(try_parse_argv(argv(&["pattern", "file.txt"])).is_ok());
}

/// A pattern alone is valid: the file list defaults to stdin.
#[test]
fn accepts_a_pattern_with_no_file() {
	assert!(try_parse_argv(argv(&["pattern"])).is_ok());
}

/// A bare `grep` parses, and is refused a step later. This is deliberate.
///
/// The pattern cannot be a required positional, because `-e PATTERN` and `-f
/// FILE` supply it just as legitimately and neither fills the positional slot.
/// So clap accepts an argv with no pattern at all, and `resolve_patterns` is
/// what refuses it, with the usage line. Pinned here because the
/// natural assumption is the opposite one, and somebody marking the positional
/// `required` to "fix" this would break `grep -e pattern file`, which is the
/// spelling scripts use.
#[test]
fn accepts_an_argv_with_no_pattern_and_leaves_the_refusal_to_the_next_step() {
	assert!(try_parse_argv(argv(&[])).is_ok());
	assert!(try_parse_argv(argv(&["-e", "pattern", "file.txt"])).is_ok());
}

/// And the invocation with no pattern really is refused, with the exit code a
/// script reads.
///
/// Checked through `run` because that is where the refusal lives, and it is
/// safe to call for this argv specifically: the pattern is resolved before any
/// path is opened, so nothing touches the filesystem. Exit code 2 is grep's
/// "the invocation was wrong", distinct from 1, which means the search ran and
/// found nothing.
#[test]
fn running_with_no_pattern_exits_two_without_searching() {
	let mut stderr = Vec::new();

	let code = capture(&mut stderr, || veyyon_uu_grep::run(argv(&[])));

	assert_eq!(code, 2);
	assert_eq!(
		String::from_utf8_lossy(&stderr),
		"grep: no pattern given\nUsage: grep [OPTION]... PATTERN [FILE]...\n"
	);
}

/// An option that takes a value must not silently accept an argv that ends
/// first.
///
/// This is the case that would otherwise consume the next argument, or worse,
/// be treated as absent: `grep -e` with nothing after it would then search for
/// whatever the following operand was.
#[test]
fn refuses_an_option_whose_value_is_missing() {
	let error = try_parse_argv(argv(&["-e"])).expect_err("`-e` requires a pattern");

	assert_eq!(error.kind(), clap::error::ErrorKind::InvalidValue);
}

/// An unknown flag is rejected rather than treated as a pattern.
///
/// Treating it as a pattern is the dangerous alternative, because the search
/// would succeed and report no matches, which reads as "nothing found" rather
/// than "you typed it wrong".
#[test]
fn refuses_an_unknown_flag() {
	let error = try_parse_argv(argv(&["--not-a-real-flag", "pattern"]))
		.expect_err("an unrecognized long flag is not a pattern");

	assert_eq!(error.kind(), clap::error::ErrorKind::UnknownArgument);
}

/// After `--`, an argument beginning with a dash is a pattern, not a flag.
///
/// The only way to search for a literal `-v`, and it has to survive both the
/// `-NUM` rewrite and clap.
#[test]
fn treats_a_dashed_operand_after_the_separator_as_a_pattern() {
	assert!(try_parse_argv(argv(&["--", "-v", "file.txt"])).is_ok());
}

/// A non-UTF-8 filename parses, because a filename is bytes rather than text.
///
/// Rejecting it would make files that exist on any Unix system unsearchable,
/// and the rewrite ahead of clap has to pass such an argument through untouched
/// rather than failing to decode it.
#[test]
#[cfg(unix)]
fn accepts_a_file_argument_that_is_not_utf8() {
	use std::os::unix::ffi::OsStringExt;

	let mut args = vec![OsString::from("grep"), OsString::from("pattern")];
	args.push(OsString::from_vec(vec![0x66, 0xff, 0x6f]));

	assert!(try_parse_argv(args).is_ok());
}

/// `--help` and `--version` are reported as errors with their own kinds.
///
/// They are not failures, and the caller distinguishes them to choose stdout
/// over stderr and exit zero. Collapsing them into an ordinary error would send
/// help text to stderr with a failing exit code, which breaks anything piping
/// it.
#[test]
fn reports_help_and_version_with_their_own_error_kinds() {
	let help = try_parse_argv(argv(&["--help"])).expect_err("help is delivered as a clap error");
	let version =
		try_parse_argv(argv(&["--version"])).expect_err("version is delivered the same way");

	assert_eq!(help.kind(), clap::error::ErrorKind::DisplayHelp);
	assert_eq!(version.kind(), clap::error::ErrorKind::DisplayVersion);
	assert!(!help.render().to_string().is_empty());
}

// ─── grep: the `-NUM` rewrite ───────────────────────────────────────────────

/// `-3` means three lines of context, which clap cannot express, so it is
/// rewritten first.
#[test]
fn rewrites_a_numeric_shorthand_into_the_long_form() {
	assert_eq!(rewritten(&["-3", "pattern"]), vec![
		"grep".to_string(),
		"--context=3".to_string(),
		"pattern".to_string()
	]);
}

/// Multiple digits are one number, not several one-digit flags.
#[test]
fn rewrites_a_multi_digit_shorthand_as_a_single_number() {
	assert_eq!(rewritten(&["-12"])[1], "--context=12");
}

/// A lone `-` is stdin and must survive untouched.
#[test]
fn leaves_a_bare_dash_alone() {
	assert_eq!(rewritten(&["-"])[1], "-");
}

/// A flag whose value happens to look numeric is a value, not a shorthand.
///
/// `grep -A 3` asks for three lines after each match. Rewriting the `3` into
/// `--context=3` would leave `-A` without its value and change what the command
/// searches for, which is the exact class of bug this rewrite can cause and no
/// exit code would report.
#[test]
fn does_not_rewrite_the_value_of_a_preceding_option() {
	assert_eq!(rewritten(&["-A", "3", "pattern"]), vec![
		"grep".to_string(),
		"-A".to_string(),
		"3".to_string(),
		"pattern".to_string()
	]);
}

/// Everything after `--` is an operand, including something shaped like a
/// shorthand.
#[test]
fn leaves_operands_after_the_separator_untouched() {
	assert_eq!(rewritten(&["--", "-3"]), vec![
		"grep".to_string(),
		"--".to_string(),
		"-3".to_string()
	]);
}

/// A `--` in value position is a pattern, not a separator, so what follows is
/// still options.
///
/// Surfaced by the `uu_grep_argv` fuzzer, which first asserted the simpler and
/// WRONG rule that nothing after any `--` is ever rewritten. `grep -e -- -3`
/// searches for the literal two-dash pattern in three lines of context, because
/// `-e` consumes the `--` as its value and the separator was therefore never
/// given. Pinned because the rule is genuinely subtle, and because the naive
/// reading of it is what a reader is most likely to "fix" the rewrite to match.
#[test]
fn treats_a_separator_in_value_position_as_a_value() {
	assert_eq!(rewritten(&["-e", "--", "-3"]), vec![
		"grep".to_string(),
		"-e".to_string(),
		"--".to_string(),
		"--context=3".to_string()
	]);
}

/// And a real separator still ends the options, even with a value-taking flag
/// before it.
#[test]
fn honours_a_separator_that_is_not_a_value() {
	assert_eq!(rewritten(&["-e", "pattern", "--", "-3"]), vec![
		"grep".to_string(),
		"-e".to_string(),
		"pattern".to_string(),
		"--".to_string(),
		"-3".to_string()
	]);
}

/// The program name is never examined, whatever it looks like.
#[test]
fn never_rewrites_the_program_name() {
	let rewritten = normalize_context_args(vec![OsString::from("-3"), OsString::from("pattern")]);

	assert_eq!(rewritten[0], OsString::from("-3"));
}

/// The rewrite changes what some arguments say and never how many there are.
///
/// A rewrite that split or merged an argument would shift every operand after
/// it, so the pattern and the file list would swap places for an invocation
/// that looked ordinary.
#[test]
fn preserves_the_argument_count() {
	let original = argv(&["-3", "-A", "2", "--", "-x", "file.txt"]);

	assert_eq!(normalize_context_args(original.clone()).len(), original.len());
}

/// Rewriting twice is the same as rewriting once.
///
/// The long form the rewrite emits must not itself look like something to
/// rewrite. Idempotence is what makes it safe to apply wherever the argument
/// surface is examined, rather than exactly once at a place everyone has to
/// remember.
#[test]
fn is_idempotent() {
	let once = normalize_context_args(argv(&["-3", "-A", "2", "pattern"]));

	assert_eq!(normalize_context_args(once.clone()), once);
}

/// A non-UTF-8 argument is passed through rather than dropped or replaced.
#[test]
#[cfg(unix)]
fn passes_through_an_argument_it_cannot_decode() {
	use std::os::unix::ffi::OsStringExt;

	let undecodable = OsString::from_vec(vec![0x2d, 0xff]);
	let original = vec![OsString::from("grep"), undecodable.clone()];

	assert_eq!(normalize_context_args(original), vec![OsString::from("grep"), undecodable]);
}

// ─── rg: the second command in the same crate ───────────────────────────────

/// `rg` takes a pattern and optional paths, like `grep`, and shares nothing
/// else with it.
#[test]
fn rg_accepts_a_pattern_and_a_path() {
	assert!(try_parse_rg_argv(rg_argv(&["pattern", "src"])).is_ok());
}

/// `rg --files` lists files and takes no pattern, so it must parse without one.
#[test]
fn rg_accepts_files_mode_without_a_pattern() {
	assert!(try_parse_rg_argv(rg_argv(&["--files"])).is_ok());
}

/// An unknown flag is refused here too, rather than becoming a pattern.
#[test]
fn rg_refuses_an_unknown_flag() {
	let error = try_parse_rg_argv(rg_argv(&["--not-a-real-flag"]))
		.expect_err("an unrecognized long flag is not a pattern");

	assert_eq!(error.kind(), clap::error::ErrorKind::UnknownArgument);
}

/// The `-NUM` shorthand is a `grep` feature and is deliberately not applied to
/// `rg`.
///
/// Pinned so the rewrite is not extended to `rg` by accident: ripgrep has no
/// such shorthand, and adding one silently would make an argument mean
/// something different in one command than in the other for no stated reason.
#[test]
fn rg_does_not_take_the_grep_numeric_shorthand() {
	let error =
		try_parse_rg_argv(rg_argv(&["-3", "pattern"])).expect_err("`rg` has no `-NUM` shorthand");

	assert_eq!(error.kind(), clap::error::ErrorKind::UnknownArgument);
}
