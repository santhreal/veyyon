//! In-process `which` builtin backed by brush's PATH-search helpers.
//!
//! Follows which(1) (debianutils) semantics: each name operand is looked up in
//! the shell's `PATH`; the first match is printed (all matches with `-a`).
//! Lookup failures are silent; the exit status is 0 only when every operand was
//! found, which means a run with NO operand exits 1, because it found nothing.
//!
//! A name containing a path separator is echoed AS TYPED rather than resolved:
//! `which bin/tool` prints `bin/tool`, not `<cwd>/bin/tool`. The existence
//! check still happens against the shell working directory.

use std::{
	ffi::OsString,
	io::{self, Write},
	path::{Path, PathBuf},
};

use brush_core::{
	Error,
	builtins::{BoxFuture, ContentOptions, ContentType, Registration},
	commands::{CommandArg, ExecutionContext},
	extensions::ShellExtensions,
	openfiles::{OpenFile, OpenFiles, null},
	pathsearch,
	results::ExecutionResult,
	sys,
};
use clap::{Parser, error::ErrorKind};

#[derive(Parser, Debug)]
#[command(name = "which", about = "Locate a command's executable in the shell's PATH")]
struct WhichCli {
	/// Print all matching executables in PATH, not just the first.
	#[arg(short = 'a', long = "all")]
	all: bool,

	/// Command names to locate.
	#[arg(value_name = "name")]
	names: Vec<String>,
}

/// Creates the `which` shell builtin registration.
pub fn which_builtin<SE: ShellExtensions>() -> Registration<SE> {
	fn execute<SE: ShellExtensions>(
		context: ExecutionContext<'_, SE>,
		args: Vec<CommandArg>,
	) -> BoxFuture<'_, Result<ExecutionResult, Error>> {
		Box::pin(std::future::ready(Ok(run_which(context, args))))
	}

	Registration {
		execute_func: execute::<SE>,
		content_func: which_content,
		disabled: false,
		special_builtin: false,
		declaration_builtin: false,
		transparent_background_wrapper: false,
	}
}

fn run_which<SE: ShellExtensions>(
	context: ExecutionContext<'_, SE>,
	args: Vec<CommandArg>,
) -> ExecutionResult {
	let mut stdout = context
		.try_fd(OpenFiles::STDOUT_FD)
		.unwrap_or_else(null_sink);
	let mut stderr = context
		.try_fd(OpenFiles::STDERR_FD)
		.unwrap_or_else(null_sink);
	let cwd = context.shell.working_dir().to_path_buf();
	let path_var = context
		.shell
		.env_str("PATH")
		.map(std::borrow::Cow::into_owned)
		.unwrap_or_default();
	let argv: Vec<OsString> = args
		.iter()
		.map(|arg| OsString::from(arg.to_string()))
		.collect();

	let cli = match WhichCli::try_parse_from(argv) {
		Ok(cli) => cli,
		Err(err) => {
			let rendered = err.to_string();
			let code = match err.kind() {
				ErrorKind::DisplayHelp | ErrorKind::DisplayVersion => {
					let _ = write!(stdout, "{rendered}");
					0
				},
				_ => {
					let _ = write!(stderr, "{rendered}");
					2
				},
			};
			return ExecutionResult::new(code);
		},
	};

	let outcome = locate_all(&cli, &path_var, &cwd);
	for path in &outcome.lines {
		let _ = writeln!(stdout, "{}", path.display());
	}
	ExecutionResult::new(outcome.code)
}

/// What a `which` run produced: the lines to print and the exit status.
struct WhichOutcome {
	lines: Vec<PathBuf>,
	code:  u8,
}

/// Resolve every operand and decide the exit status.
///
/// Split out from [`run_which`] so the whole behaviour is reachable from a test
/// without building an `ExecutionContext`. It was not, and the exit status
/// therefore had no coverage at all, which is how the no-operand case below
/// stayed wrong.
fn locate_all(cli: &WhichCli, path_var: &str, cwd: &Path) -> WhichOutcome {
	let mut lines = Vec::new();
	// A run with no operand found nothing, so it did not succeed. which(1) exits
	// 1 for `which` with no arguments; this used to report 0, because "every name
	// was found" is vacuously true of no names at all. Vacuous success is the
	// wrong answer for a script asking whether a tool exists.
	let mut all_found = !cli.names.is_empty();
	for name in &cli.names {
		let matches = find_matches(name, path_var, cwd, cli.all);
		if matches.is_empty() {
			// which(1) reports missing names via the exit status only.
			all_found = false;
		}
		lines.extend(matches);
	}
	WhichOutcome { lines, code: u8::from(!all_found) }
}

/// Collects the executable matches for a single `which` name operand.
///
/// A name containing a path separator is checked directly against `cwd`
/// (yielding at most one match) and reported AS TYPED; otherwise each `PATH`
/// entry — with relative and empty entries resolved against `cwd` — is probed
/// in `PATH` order. Returns only the first match unless `all` is set. Windows
/// `PATHEXT` resolution is handled by
/// [`brush_core::sys::fs::resolve_executable`].
fn find_matches(name: &str, path_var: &str, cwd: &Path, all: bool) -> Vec<PathBuf> {
	if sys::fs::contains_path_separator(name) {
		let typed = Path::new(name);
		let candidate = cwd.join(typed);
		if candidate.is_dir() {
			return Vec::new();
		}
		return sys::fs::resolve_executable(candidate)
			.into_iter()
			.map(|resolved| reported_path(typed, &resolved))
			.collect();
	}

	let dirs = sys::fs::split_paths(path_var).map(|dir| {
		if dir.as_os_str().is_empty() {
			// POSIX: an empty PATH entry names the current directory.
			cwd.to_path_buf()
		} else if dir.is_relative() {
			cwd.join(dir)
		} else {
			dir
		}
	});

	let mut found = pathsearch::search_for_executable(dirs, name);
	if all {
		found.collect()
	} else {
		found.next().into_iter().collect()
	}
}

/// What to print for an operand that contained a path separator.
///
/// which(1) echoes such an operand rather than resolving it: `which bin/tool`
/// prints `bin/tool` and `which ./bin/tool` prints `./bin/tool`. This builtin
/// printed the cwd-joined absolute path, so a caller substituting the output
/// back into a command got a different string from the one it asked about.
///
/// The resolved path wins in the one case where it says something the typed
/// name does not: Windows `PATHEXT` resolution can turn `bin/tool` into
/// `bin/tool.exe`, and reporting `bin/tool` there would name a file that does
/// not exist.
fn reported_path(typed: &Path, resolved: &Path) -> PathBuf {
	if typed.is_absolute() || resolved.file_name() != typed.file_name() {
		return resolved.to_path_buf();
	}
	typed.to_path_buf()
}

fn null_sink() -> OpenFile {
	null().unwrap_or_else(|_| OpenFile::from(io::stdout()))
}

#[allow(
	clippy::unnecessary_wraps,
	reason = "signature must match brush's CommandContentFunc fn pointer"
)]
fn which_content(
	_name: &str,
	_content_type: ContentType,
	_options: &ContentOptions,
) -> Result<String, Error> {
	Ok("which: which [-a] name [name ...]\n".to_string())
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
	use std::{
		fs,
		ops::Deref,
		os::unix::fs::PermissionsExt,
		path::{Path, PathBuf},
	};

	use super::{WhichCli, find_matches, locate_all};

	/// Creates a fresh, canonicalized temp directory (macOS `/var` is a
	/// symlink; canonicalizing keeps constructed and probed paths identical).
	///
	/// The tree is owned by `veyyon-test-scratch`, so it is removed when the
	/// test that made it ends, including when that test fails. Canonicalizing
	/// has to happen without giving up that ownership, which is why the guard
	/// is kept alongside the canonical path rather than replaced by it.
	fn temp_root(tag: &str) -> TempRoot {
		let tree = veyyon_test_scratch::scratch_dir(&format!("shell-which-{tag}"));
		let canonical = fs::canonicalize(tree.path()).expect("temp dir should canonicalize");
		TempRoot { canonical, _tree: tree }
	}

	/// A canonicalized view of a scratch tree, holding the tree alive.
	struct TempRoot {
		canonical: PathBuf,
		_tree:     veyyon_test_scratch::TempTree,
	}

	impl Deref for TempRoot {
		type Target = Path;

		fn deref(&self) -> &Path {
			&self.canonical
		}
	}

	impl AsRef<Path> for TempRoot {
		fn as_ref(&self) -> &Path {
			&self.canonical
		}
	}

	fn place_file(dir: &std::path::Path, name: &str, executable: bool) -> PathBuf {
		let path = dir.join(name);
		fs::write(&path, b"#!/bin/sh\n").expect("file should be written");
		let mode = if executable { 0o755 } else { 0o644 };
		fs::set_permissions(&path, fs::Permissions::from_mode(mode))
			.expect("permissions should be set");
		path
	}

	#[test]
	fn finds_only_executable_files() {
		let dir = temp_root("exec-only");
		let tool = place_file(&dir, "tool", true);
		place_file(&dir, "blob", false);
		let path_var = dir.display().to_string();

		assert_eq!(find_matches("tool", &path_var, &dir, false), vec![tool]);
		assert!(find_matches("blob", &path_var, &dir, false).is_empty());
		assert!(find_matches("missing", &path_var, &dir, false).is_empty());
	}

	#[test]
	fn all_flag_returns_matches_in_path_order() {
		let dir_a = temp_root("all-a");
		let dir_b = temp_root("all-b");
		let tool_a = place_file(&dir_a, "tool", true);
		let tool_b = place_file(&dir_b, "tool", true);
		let path_var = format!("{}:{}", dir_a.display(), dir_b.display());
		let cwd = temp_root("all-cwd");

		assert_eq!(find_matches("tool", &path_var, &cwd, true), vec![tool_a.clone(), tool_b]);
		// Without -a only the first PATH entry's match is returned.
		assert_eq!(find_matches("tool", &path_var, &cwd, false), vec![tool_a]);
	}

	/// A name containing a separator is checked against the working directory
	/// and reported AS TYPED, which is what which(1) prints.
	///
	/// THE BUG. This builtin returned the cwd-joined absolute path, so
	/// `which bin/tool` printed `/tmp/.../bin/tool` where which(1) prints
	/// `bin/tool`. Real which on this machine:
	///
	/// ```text
	/// which bin/tool    -> bin/tool
	/// which ./bin/tool  -> ./bin/tool
	/// ```
	///
	/// A caller that substitutes the output back into a command got a different
	/// string from the one it asked about, and the previous version of this test
	/// asserted the absolute form, so it locked the divergence in.
	#[test]
	fn name_with_separator_is_reported_as_typed() {
		let cwd = temp_root("slash");
		let bin = cwd.join("bin");
		fs::create_dir_all(&bin).expect("bin dir should be created");
		place_file(&bin, "tool", true);
		place_file(&bin, "blob", false);

		// PATH is irrelevant for names containing a separator.
		assert_eq!(find_matches("bin/tool", "", &cwd, false), vec![PathBuf::from("bin/tool")]);
		// The `./` form is echoed with its prefix intact.
		assert_eq!(find_matches("./bin/tool", "", &cwd, false), vec![PathBuf::from("./bin/tool")]);
		// An absolute operand has nothing to echo differently.
		let absolute = bin.join("tool");
		let typed = absolute.display().to_string();
		assert_eq!(find_matches(&typed, "", &cwd, false), vec![absolute]);
		// Not executable, and a directory, are both misses.
		assert!(find_matches("bin/blob", "", &cwd, false).is_empty());
		assert!(find_matches("./bin", "", &cwd, false).is_empty());
	}

	/// THE NON-VACUITY TWIN for the case above: the check really does happen
	/// against the working directory, so echoing the typed name did not turn the
	/// lookup into a no-op that reports whatever it was handed.
	#[test]
	fn a_typed_name_is_still_checked_against_the_working_directory() {
		let cwd = temp_root("slash-check");
		let elsewhere = temp_root("slash-elsewhere");
		let bin = cwd.join("bin");
		fs::create_dir_all(&bin).expect("bin dir should be created");
		place_file(&bin, "tool", true);

		assert_eq!(find_matches("bin/tool", "", &cwd, false), vec![PathBuf::from("bin/tool")]);
		assert!(
			find_matches("bin/tool", "", &elsewhere, false).is_empty(),
			"the same typed name must miss from a directory that does not contain it"
		);
	}

	/// The exit status, which had no coverage at all before this.
	///
	/// WHY THIS EXISTS. `locate_all` was inlined in `run_which`, reachable only
	/// through an `ExecutionContext`, so nothing tested it. The no-operand case
	/// was wrong as a result: `which` with no arguments reported SUCCESS,
	/// because "every operand was found" is vacuously true of no operands.
	/// which(1) exits 1, and a script asking "does this tool exist" got a yes
	/// for a question it never managed to ask.
	#[test]
	fn the_exit_status_answers_whether_every_operand_was_found() {
		let dir = temp_root("status");
		place_file(&dir, "tool", true);
		let path_var = dir.display().to_string();
		let outcome = |names: &[&str], all: bool| {
			let cli = WhichCli { all, names: names.iter().map(|name| (*name).to_string()).collect() };
			locate_all(&cli, &path_var, &dir)
		};

		let found = outcome(&["tool"], false);
		assert_eq!(found.code, 0);
		assert_eq!(found.lines.len(), 1);

		let missing = outcome(&["nope"], false);
		assert_eq!(missing.code, 1);
		assert!(missing.lines.is_empty(), "a miss prints nothing: {:?}", missing.lines);

		// A found name still prints when a later one is missing, and the status is
		// still a failure. This is which(1)'s behaviour and the reason the flag is
		// `all_found` rather than `any_found`.
		let mixed = outcome(&["tool", "nope"], false);
		assert_eq!(mixed.code, 1);
		assert_eq!(mixed.lines.len(), 1);

		// Order does not change the answer.
		let mixed_reversed = outcome(&["nope", "tool"], false);
		assert_eq!(mixed_reversed.code, 1);
		assert_eq!(mixed_reversed.lines.len(), 1);

		// THE BUG: no operands is a failure, not a vacuous success.
		let empty = outcome(&[], false);
		assert_eq!(empty.code, 1, "a run with no operand found nothing");
		assert!(empty.lines.is_empty());

		// -a does not change the status, only how many lines a hit produces.
		let all_flag = outcome(&["tool"], true);
		assert_eq!(all_flag.code, 0);
		assert_eq!(all_flag.lines.len(), 1);
		assert_eq!(outcome(&[], true).code, 1);
	}

	#[test]
	fn relative_path_entries_resolve_against_cwd() {
		let cwd = temp_root("rel-entry");
		let bin = cwd.join("bin");
		fs::create_dir_all(&bin).expect("bin dir should be created");
		let tool = place_file(&bin, "tool", true);

		assert_eq!(find_matches("tool", "bin", &cwd, false), vec![tool]);
	}
}
