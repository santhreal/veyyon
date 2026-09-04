//! Behavioral contract tests driving [`crate::run`] under a
//! [`veyyon_uutils_ctx::scope`], the way the shell host does.

use std::{
	collections::HashMap,
	ffi::OsString,
	io::{self, Write},
	path::Path,
	sync::{Arc, atomic::AtomicBool},
};

use parking_lot::Mutex;

/// `Send` writer that appends every write to a shared buffer so the test can
/// inspect what the utility wrote to the scope's stdout/stderr.
#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<u8>>>);

impl Sink {
	fn contents(&self) -> Vec<u8> {
		self.0.lock().clone()
	}
}

impl Write for Sink {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		self.0.lock().extend_from_slice(buf);
		Ok(buf.len())
	}

	fn flush(&mut self) -> io::Result<()> {
		Ok(())
	}
}

/// Runs `xargs` with `argv` (sans the leading command name), feeding `stdin`
/// bytes, in `cwd`, with `env` as the scope's exported environment. Returns
/// `(exit code, stdout, stderr)`.
fn run_xargs(
	argv: &[&str],
	stdin: &[u8],
	cwd: &Path,
	env: &[(&str, &str)],
) -> (i32, String, String) {
	let out = Sink::default();
	let err = Sink::default();
	let mut full_argv = vec![OsString::from("xargs")];
	full_argv.extend(argv.iter().map(OsString::from));
	let env: HashMap<String, String> = env
		.iter()
		.map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
		.collect();
	let code = veyyon_uutils_ctx::scope(
		veyyon_uutils_ctx::ScopeIo {
			stdin: Box::new(io::Cursor::new(stdin.to_vec())),
			stdin_fd: None,
			stdin_is_search_input: false,
			stdout: Box::new(out.clone()),
			// A capture buffer is not a terminal.
			stdout_is_terminal: false,
			stderr: Box::new(err.clone()),
			cwd: cwd.to_path_buf(),
			env,
			cancel: Arc::new(AtomicBool::new(false)),
		},
		|| crate::run(full_argv),
	);
	(
		code,
		String::from_utf8(out.contents()).expect("utf8 stdout"),
		String::from_utf8(err.contents()).expect("utf8 stderr"),
	)
}

/// Same, with an empty environment and `.` as the working directory.
fn run_simple(argv: &[&str], stdin: &[u8]) -> (i32, String, String) {
	run_xargs(argv, stdin, Path::new("."), &[])
}

#[test]
fn child_stdout_is_captured_through_ctx() {
	let (code, out, err) = run_simple(&["echo"], b"a b c\n");
	assert_eq!(code, 0);
	assert_eq!(out, "a b c\n", "child echo output flows through ctx stdout");
	assert_eq!(err, "", "clean run leaves stderr empty");
}

#[test]
fn max_args_batches_into_two_invocations() {
	let (code, out, _) = run_simple(&["-n", "2", "echo"], b"a b c\n");
	assert_eq!(code, 0);
	assert_eq!(out, "a b\nc\n", "-n 2 splits three items into two runs");
}

#[test]
fn default_mode_honors_quotes() {
	// "a b" c → exactly two arguments for the child.
	let (code, out, _) = run_simple(&["sh", "-c", "echo $#", "_"], b"\"a b\" c\n");
	assert_eq!(code, 0);
	assert_eq!(out, "2\n", "quoted item stays a single argument");
}

#[test]
fn null_mode_preserves_spaces_and_newlines() {
	let (code, out, _) = run_simple(&["-0", "echo"], b"a b\0c\nd\0");
	assert_eq!(code, 0);
	assert_eq!(out, "a b c\nd\n", "NUL-split items keep spaces and newlines");
}

#[test]
fn replace_places_item_mid_command() {
	let (code, out, _) = run_simple(&["-I", "{}", "echo", "hello", "{}", "!"], b"world\n");
	assert_eq!(code, 0);
	assert_eq!(out, "hello world !\n", "-I substitutes mid-command");
}

#[test]
fn failing_child_yields_123() {
	let (code, out, _) = run_simple(&["false"], b"x\n");
	assert_eq!(code, 123, "any failed invocation maps to 123");
	assert_eq!(out, "");
}

#[test]
fn missing_command_yields_127() {
	let (code, _, err) = run_simple(&["definitely-not-a-real-command-xyz"], b"x\n");
	assert_eq!(code, 127, "command not found maps to 127");
	assert!(err.contains("Command not found"), "diagnostic lands on ctx stderr, got: {err:?}");
}

#[test]
fn exit_255_child_yields_124() {
	let (code, _, err) = run_simple(&["sh", "-c", "exit 255", "_"], b"x\n");
	assert_eq!(code, 124, "a 255 exit aborts with 124");
	assert!(err.contains("255"), "diagnostic mentions the urgent exit, got: {err:?}");
}

#[test]
fn no_run_if_empty_skips_command() {
	let (code, out, err) = run_simple(&["-r", "echo"], b"");
	assert_eq!(code, 0);
	assert_eq!(out, "", "-r with no input runs nothing");
	assert_eq!(err, "");
}

#[test]
fn empty_input_without_r_runs_default_echo_once() {
	// Upstream findutils 0.8.0 (like GNU) still runs the built-in echo once
	// on empty input, producing a single empty line.
	let (code, out, _) = run_simple(&[], b"");
	assert_eq!(code, 0);
	assert_eq!(out, "\n", "default echo prints one empty line");
}

#[test]
fn verbose_echoes_command_line_to_stderr() {
	let (code, out, err) = run_simple(&["-t", "echo", "a"], b"b\n");
	assert_eq!(code, 0);
	assert_eq!(out, "a b\n");
	assert_eq!(err, "echo a b\n", "-t prints the command line on stderr");
}

#[test]
fn children_run_in_scope_cwd() {
	let dir = tempfile::TempDir::new().expect("tempdir");
	let (code, _, err) =
		run_xargs(&["sh", "-c", "touch \"$1\"", "_"], b"made.txt\n", dir.path(), &[]);
	assert_eq!(code, 0, "stderr: {err:?}");
	assert!(
		dir.path().join("made.txt").exists(),
		"relative paths in the child resolve against the scope cwd"
	);
}

#[test]
fn children_see_scope_environment() {
	let (code, out, _) =
		run_simple_env(&["sh", "-c", "echo \"$XVAR\"", "_"], b"x\n", &[("XVAR", "hello")]);
	assert_eq!(code, 0);
	assert_eq!(out, "hello\n", "scope env reaches the child via env_snapshot");
}

fn run_simple_env(argv: &[&str], stdin: &[u8], env: &[(&str, &str)]) -> (i32, String, String) {
	run_xargs(argv, stdin, Path::new("."), env)
}

#[test]
fn arg_file_resolves_against_scope_cwd() {
	let dir = tempfile::TempDir::new().expect("tempdir");
	std::fs::write(dir.path().join("items.txt"), "a b\n").expect("write items");
	let (code, out, _) = run_xargs(&["-a", "items.txt", "echo"], b"", dir.path(), &[]);
	assert_eq!(code, 0);
	assert_eq!(out, "a b\n", "-a file opens relative to the scope cwd");
}

/// An empty batch in replace mode: the recorded panic, and its whole class.
///
/// THE DEFECT. `CommandBuilder::execute` read `self.extra_args[0]` to build the
/// substitution, and `process_input` runs the command once on empty input for
/// GNU compatibility unless `-r` is given. In replace mode that batch carries
/// no arguments, so the index panicked: `index out of bounds: the len is 0 but
/// the index is 0`, seven times in the recorded crash logs, on a tokio worker
/// inside the host shell. The fix returns without spawning, because GNU xargs
/// runs the command zero times when there is nothing to substitute.
///
/// THE CLASS. Every spelling of replace mode, and every way the input can
/// produce no arguments. The fix landed without a test, so nothing held the
/// other spellings: `-I R`, `-i`, `--replace=R`, with whitespace-only input,
/// with a NUL delimiter, with an empty `-a` file, and with `-r` also given.
/// Each asserts the command ran ZERO times by its side effect on the
/// filesystem, not only that the exit code was 0 — an exit code cannot tell
/// "ran once and did nothing" from "did not run".
///
/// WHAT THIS DOES NOT CATCH. It fixes the batch at zero arguments. A batch of
/// one is the case upstream always ran, and a limiter that hands `execute` a
/// batch it did not build is out of reach from here.
#[cfg(test)]
mod empty_batch_in_replace_mode {
	use super::{run_simple, run_xargs};

	/// Argv that would create `ran.txt` if the child ran even once.
	fn touching(replace_flag: &[&str], token: &str) -> Vec<String> {
		let mut argv: Vec<String> = replace_flag.iter().map(|s| (*s).to_string()).collect();
		argv.extend(
			["sh", "-c", "touch ran.txt; echo \"$1\"", "_", token]
				.iter()
				.map(|s| (*s).to_string()),
		);
		argv
	}

	/// Runs `argv` in a fresh temp dir; returns `(code, stdout, stderr, ran)`.
	fn run_in_tempdir(argv: &[String], stdin: &[u8]) -> (i32, String, String, bool) {
		let dir = tempfile::TempDir::new().expect("tempdir");
		let borrowed: Vec<&str> = argv.iter().map(String::as_str).collect();
		let (code, out, err) = run_xargs(&borrowed, stdin, dir.path(), &[]);
		(code, out, err, dir.path().join("ran.txt").exists())
	}

	#[test]
	fn every_replace_spelling_runs_zero_commands_on_empty_input() {
		// `-i` and `--replace` take their value with `=`; `-I` takes it positionally.
		let spellings: [&[&str]; 4] = [&["-I", "{}"], &["-i"], &["--replace=@"], &["-I", "REPL"]];
		for spelling in spellings {
			let token = match spelling {
				["--replace=@"] => "@",
				["-I", "REPL"] => "REPL",
				_ => "{}",
			};
			let (code, out, err, ran) = run_in_tempdir(&touching(spelling, token), b"");
			assert_eq!(code, 0, "{spelling:?} on empty input should succeed, stderr: {err:?}");
			assert_eq!(out, "", "{spelling:?} should produce no output");
			assert!(!ran, "{spelling:?} ran the command on an empty batch");
		}
	}

	#[test]
	fn input_that_yields_no_arguments_runs_zero_commands() {
		// Every one of these was checked against GNU findutils 4.9.0, which runs the
		// command zero times for all of them. `"   "` is the one that used to reach
		// the command: the whitespace reader hit EOF with an empty item and returned
		// it as an argument instead of ending the stream.
		//
		// NOT COVERED: a line of literal quote characters. GNU quote-processes the
		// line it substitutes, so `printf '""'` yields an empty line and runs
		// nothing, while this xargs substitutes the two quote bytes verbatim.
		// Replace mode here does not quote-process at all, which is a wider gap than
		// this defect, and half-implementing it would be worse than naming it.
		for stdin in [&b"   "[..], &b"\n"[..], &b" \t\n \n"[..], &b""[..]] {
			let (code, out, err, ran) = run_in_tempdir(&touching(&["-I", "{}"], "{}"), stdin);
			assert_eq!(code, 0, "input {stdin:?} should succeed, stderr: {err:?}");
			assert_eq!(out, "", "input {stdin:?} should produce no output");
			assert!(!ran, "input {stdin:?} ran the command");
		}
		let mut null_argv = vec!["-0".to_string()];
		null_argv.extend(touching(&["-I", "{}"], "{}"));
		let (code, out, _, ran) = run_in_tempdir(&null_argv, b"");
		assert_eq!(code, 0, "-0 with empty input should succeed");
		assert_eq!(out, "", "-0 with empty input should produce no output");
		assert!(!ran, "-0 with empty input ran the command");
	}

	/// The same hole outside replace mode: a spurious empty argument.
	///
	/// GNU runs `echo BEGIN` for whitespace-only input, and prints `BEGIN`. This
	/// used to print `BEGIN ` — one empty argument appended, from the same EOF
	/// branch — so the defect was never only about replace mode.
	#[test]
	fn whitespace_only_input_appends_no_empty_argument() {
		for stdin in [&b"   "[..], &b"\t"[..], &b"\n"[..]] {
			let (code, out, err) = run_simple(&["echo", "BEGIN"], stdin);
			assert_eq!(code, 0, "stderr: {err:?}");
			assert_eq!(out, "BEGIN\n", "input {stdin:?} appended an empty argument");
		}
		// A real trailing item with no terminator is still an item.
		let (code, out, _) = run_simple(&["echo", "BEGIN"], b"tail");
		assert_eq!(code, 0);
		assert_eq!(out, "BEGIN tail\n", "an unterminated real item must survive");
	}

	/// Replace mode's line rule, checked against GNU findutils 4.9.0 case by
	/// case.
	///
	/// GNU strips the LEADING blanks off the line it substitutes, keeps the
	/// trailing ones, and runs nothing for a line that is blanks only. An
	/// explicit delimiter means the item is the item: `-0` keeps both sides.
	#[test]
	fn replace_mode_strips_leading_blanks_and_skips_blank_lines() {
		let echoing = ["-I", "{}", "sh", "-c", "echo \"[$1]\"", "_", "{}"];
		for stdin in [&b"   \n"[..], &b"  \t \n"[..], &b"\t"[..], &b"   "[..]] {
			let (code, out, err) = run_simple(&echoing, stdin);
			assert_eq!(code, 0, "stderr: {err:?}");
			assert_eq!(out, "", "a blanks-only line ran the command: {stdin:?}");
		}
		let (code, out, _) = run_simple(&echoing, b" a \n");
		assert_eq!(code, 0);
		assert_eq!(out, "[a ]\n", "leading blanks are stripped, trailing blanks are kept");

		let (code, out, _) = run_simple(&echoing, b"\ta\nb\n\n c\n");
		assert_eq!(code, 0);
		assert_eq!(out, "[a]\n[b]\n[c]\n", "a blank line between items is skipped, not substituted");

		// An explicit delimiter names the terminator, so the item keeps its blanks.
		let (code, out, _) =
			run_simple(&["-0", "-I", "{}", "sh", "-c", "echo \"[$1]\"", "_", "{}"], b" a \0");
		assert_eq!(code, 0);
		assert_eq!(out, "[ a ]\n", "-0 must not strip the item's blanks");
	}

	#[test]
	fn no_run_if_empty_and_an_empty_arg_file_agree_with_it() {
		let mut with_r = vec!["-r".to_string()];
		with_r.extend(touching(&["-I", "{}"], "{}"));
		let (code, out, _, ran) = run_in_tempdir(&with_r, b"");
		assert_eq!(code, 0, "-r with replace mode should succeed");
		assert_eq!(out, "", "-r should produce no output");
		assert!(!ran, "-r ran the command on empty input");

		let dir = tempfile::TempDir::new().expect("tempdir");
		std::fs::write(dir.path().join("empty.txt"), b"").expect("write items");
		let (code, out, err) = run_xargs(
			&["-a", "empty.txt", "-I", "{}", "sh", "-c", "touch ran.txt; echo \"$1\"", "_", "{}"],
			b"",
			dir.path(),
			&[],
		);
		assert_eq!(code, 0, "an empty -a file should succeed, stderr: {err:?}");
		assert_eq!(out, "", "an empty -a file should produce no output");
		assert!(!dir.path().join("ran.txt").exists(), "an empty -a file ran the command");
	}

	/// The positive control: replace mode is not simply refusing to run.
	#[test]
	fn one_argument_still_runs_exactly_once() {
		let (code, out, err, ran) = run_in_tempdir(&touching(&["-I", "{}"], "{}"), b"item\n");
		assert_eq!(code, 0, "stderr: {err:?}");
		assert_eq!(out, "item\n", "the substituted item reaches the child");
		assert!(ran, "a one-argument batch must still run the command");
		// And the non-replace path on the same empty input keeps its GNU behavior,
		// so the guard did not widen into a general no-run.
		let (code, out, _) = run_simple(&[], b"");
		assert_eq!(code, 0);
		assert_eq!(out, "\n", "default echo still runs once on empty input");
	}
}
