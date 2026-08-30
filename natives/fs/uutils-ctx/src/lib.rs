//! Thread-local I/O + working-directory context for running uutils utilities
//! in-process as shell builtins.
//!
//! uutils utilities write to the process-global `std::io::stdout()`/`stderr()`,
//! read the process-global `std::io::stdin()`, and resolve relative paths
//! against the process-global current directory. None of that is correct when
//! the utility runs as a builtin inside a long-lived shell process: output must
//! go to the command's (possibly piped/redirected) file descriptors, and
//! relative paths must resolve against the *shell's* working directory.
//!
//! This crate provides a thread-local context that vendored uutils crates are
//! patched to consult instead of the process globals. The shell host installs a
//! context for the duration of a single utility invocation on a dedicated
//! blocking thread (so concurrent pipeline stages, each on their own thread,
//! stay isolated), runs the utility, then tears the context down.

use std::{
	cell::{Cell, RefCell},
	collections::HashMap,
	io::{self, Read, Write},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

struct Ctx {
	stdin:                 Box<dyn Read + Send>,
	/// Raw fd backing `stdin` when it is a real OS file/pipe, used for
	/// cancellable readiness polling on unix. `None` for non-fd readers.
	stdin_fd:              Option<i32>,
	/// Whether stdin is a shell pipe/stream that should be searched implicitly.
	stdin_is_search_input: bool,
	stdout:                Box<dyn Write + Send>,
	/// Whether `stdout` is a terminal, as declared by the host. Not derivable
	/// here: `stdout` is a `Box<dyn Write>`, so this side cannot ask an fd.
	stdout_is_terminal:    bool,
	stderr:                Box<dyn Write + Send>,
	cwd:                   PathBuf,
	env:                   HashMap<String, String>,
	/// Set by the host when the command is aborted/timed out; makes a blocked
	/// `stdin` read return EOF so the utility unwinds promptly.
	cancel:                Arc<AtomicBool>,
	exit_code:             i32,
}

thread_local! {
	static CTX: RefCell<Option<Ctx>> = const { RefCell::new(None) };
	/// Borrow-free count of active [`scope`] frames on this thread. The native
	/// crash hook reads this from inside a panic (see [`is_active`]); a `Cell`
	/// is used because the panicking code may already hold `CTX`'s `RefCell`
	/// borrow, and a second `RefCell` read there would panic again and abort.
	static SCOPE_DEPTH: Cell<usize> = const { Cell::new(0) };
}

static RAYON_GLOBAL_POOL_AVAILABLE: AtomicBool = AtomicBool::new(!cfg!(target_os = "windows"));

/// I/O streams, working directory, environment, and cancel flag for a single
/// utility invocation. Grouped into one value to keep [`scope`] readable.
pub struct ScopeIo {
	/// Standard input reader.
	pub stdin:                 Box<dyn Read + Send>,
	/// Raw fd backing `stdin` when it is a real OS file/pipe (unix), used for
	/// cancellable readiness polling; `None` for non-fd readers.
	pub stdin_fd:              Option<i32>,
	/// Whether stdin should be used as `rg PATTERN`'s implicit input.
	pub stdin_is_search_input: bool,
	/// Standard output writer.
	pub stdout:                Box<dyn Write + Send>,
	/// Whether [`Self::stdout`] is a terminal.
	///
	/// The host declares it because only the host can know: by the time a
	/// utility sees stdout it is a `Box<dyn Write>` with no descriptor behind
	/// it, and the process-global `std::io::stdout()` answers for the SHELL's
	/// stdout rather than this command's, which is the wrong answer the moment
	/// the command is redirected or is one stage of a pipeline. A host with a
	/// real descriptor computes it once with
	/// `std::io::IsTerminal::is_terminal`; a test or a capture buffer passes
	/// `false`, which is the truth about a `Vec<u8>`.
	///
	/// Utilities read it through [`stdout_is_terminal`] for decisions a terminal
	/// changes: `rg` line-buffers to a terminal and block-buffers to a pipe, the
	/// same way ripgrep does.
	pub stdout_is_terminal:    bool,
	/// Standard error writer.
	pub stderr:                Box<dyn Write + Send>,
	/// Working directory that relative paths resolve against.
	pub cwd:                   PathBuf,
	/// Exported shell environment.
	pub env:                   HashMap<String, String>,
	/// Set by the host on abort/timeout to unblock a stalled `stdin` read.
	pub cancel:                Arc<AtomicBool>,
}

/// Installs `io` as the current thread's uutils context, runs `f`, then
/// restores whatever context (if any) was previously installed — even if `f`
/// panics. Returns the value produced by `f`.
///
/// The previous context is saved and restored rather than cleared, so nested
/// scopes (and leftover state across tests sharing a thread) stay correct.
pub fn scope<R>(io: ScopeIo, f: impl FnOnce() -> R) -> R {
	struct Guard {
		prev: Option<Ctx>,
	}
	impl Drop for Guard {
		fn drop(&mut self) {
			CTX.with(|c| {
				*c.borrow_mut() = self.prev.take();
			});
			SCOPE_DEPTH.with(|d| d.set(d.get().saturating_sub(1)));
		}
	}

	let prev = CTX.with(|c| {
		c.borrow_mut().replace(Ctx {
			stdin:                 io.stdin,
			stdin_fd:              io.stdin_fd,
			stdin_is_search_input: io.stdin_is_search_input,
			stdout:                io.stdout,
			stdout_is_terminal:    io.stdout_is_terminal,
			stderr:                io.stderr,
			cwd:                   io.cwd,
			env:                   io.env,
			cancel:                io.cancel,
			exit_code:             0,
		})
	});
	SCOPE_DEPTH.with(|d| d.set(d.get() + 1));
	let _guard = Guard { prev };
	f()
}

/// Whether a uutils scope is active on the current thread.
///
/// The native crash hook consults this from inside a panic: a panic raised
/// while a scope is active is, by construction, about to be caught at the
/// uutils boundary (see `run_uutil` in veyyon-shell's `coreutils`), so the hook
/// treats it as recoverable and keeps it out of the user-facing crash report.
/// Reads the borrow-free [`SCOPE_DEPTH`] counter rather than `CTX`, because the
/// panicking code may already hold `CTX`'s borrow — a `RefCell` read there
/// would panic inside the panic hook and abort the process.
#[must_use]
pub fn is_active() -> bool {
	SCOPE_DEPTH.with(|d| d.get() > 0)
}

/// Records whether patched native callsites may use Rayon's process-global
/// worker pool without risking lazy initialization under Windows commit
/// pressure.
pub fn set_rayon_global_pool_available(available: bool) {
	RAYON_GLOBAL_POOL_AVAILABLE.store(available, Ordering::SeqCst);
}

/// Returns whether patched native callsites may enter Rayon's process-global
/// worker pool.
#[must_use]
pub fn rayon_global_pool_available() -> bool {
	RAYON_GLOBAL_POOL_AVAILABLE.load(Ordering::SeqCst)
}

/// Returns the exit code accumulated via [`set_exit_code`] during the current
/// scope (0 when none was set or no context is installed).
pub fn exit_code() -> i32 {
	CTX.with(|c| c.borrow().as_ref().map_or(0, |ctx| ctx.exit_code))
}

/// Records a non-zero exit code (uutils' `show!`/`show_if_err!` analogues call
/// this when a recoverable error is reported but processing continues).
pub fn set_exit_code(code: i32) {
	CTX.with(|c| {
		if let Some(ctx) = c.borrow_mut().as_mut() {
			ctx.exit_code = code;
		}
	});
}

/// The shell working directory of the current scope, or `.` when unset.
pub fn cwd() -> PathBuf {
	CTX.with(|c| {
		c.borrow()
			.as_ref()
			.map_or_else(|| PathBuf::from("."), |ctx| ctx.cwd.clone())
	})
}

/// Resolves `p` against the scope's working directory when relative; absolute
/// paths are returned unchanged. uutils utilities are patched to resolve every
/// path argument through this before touching the filesystem.
pub fn resolve(p: impl AsRef<Path>) -> PathBuf {
	let p = p.as_ref();
	if p.is_absolute() {
		p.to_path_buf()
	} else {
		cwd().join(p)
	}
}

/// Looks up an environment variable from the scope's environment map (the
/// shell's exported variables). uutils utilities are patched to read the
/// environment through this rather than `std::env::var`, because the embedding
/// shell's exported variables are not present in the host process environment.
pub fn var(key: &str) -> Option<String> {
	CTX.with(|c| {
		c.borrow()
			.as_ref()
			.and_then(|ctx| ctx.env.get(key).cloned())
	})
}

/// Returns a snapshot of the scope's entire environment map (the shell's
/// exported variables), or an empty vector when no scope is installed.
/// Utilities that spawn child processes use this to build the child
/// environment (`env_clear().envs(..)`), because the shell's exported
/// variables are not present in the host process environment.
#[must_use]
pub fn env_snapshot() -> Vec<(String, String)> {
	CTX.with(|c| {
		c.borrow().as_ref().map_or_else(Vec::new, |ctx| {
			ctx.env
				.iter()
				.map(|(k, v)| (k.clone(), v.clone()))
				.collect()
		})
	})
}
/// Resolves a program name to the file a shell would run for it.
///
/// A name holding a path separator names a file directly and is resolved
/// against the scope's working directory. A bare name is looked up in the
/// scope's `PATH`, entry by entry and in order; an empty entry means the
/// working directory, which is what POSIX says it means. `None` means no
/// executable of that name is reachable, and the caller reports it rather than
/// guessing.
///
/// Lookup cannot be left to the operating system here. `Command::new` resolves
/// a bare name through the HOST process's `PATH`, and a builtin's `PATH` is the
/// shell's exported one, so a caller who put a directory of their own tools on
/// `PATH` and then ran a builtin that spawns a child would watch the child be
/// looked up somewhere else entirely. Every builtin that starts a process
/// resolves its program through here first.
#[must_use]
pub fn resolve_program(program: impl AsRef<Path>) -> Option<PathBuf> {
	let program = program.as_ref();
	let named_directly = program
		.as_os_str()
		.to_string_lossy()
		.contains(std::path::is_separator);
	if named_directly {
		let candidate = resolve(program);
		return executable(&candidate).then_some(candidate);
	}
	let path = var("PATH").unwrap_or_default();
	for dir in path.split(PATH_SEPARATOR) {
		// An empty entry is the working directory. Joining an empty path would produce
		// the bare program name, which resolves against the HOST process directory.
		let dir = if dir.is_empty() { cwd() } else { resolve(dir) };
		let candidate = dir.join(program);
		if executable(&candidate) {
			return Some(candidate);
		}
		#[cfg(windows)]
		if let Some(found) = windows_extension_candidates(&candidate).find(|p| executable(p)) {
			return Some(found);
		}
	}
	None
}

/// The character that separates `PATH` entries: `:` everywhere but Windows.
const PATH_SEPARATOR: char = if cfg!(windows) { ';' } else { ':' };

/// Whether this path names a file the current user may execute.
///
/// On Unix a file is executable when any of the three execute bits is set AND
/// the user is allowed to use it, which only `access(2)` can answer: a mode of
/// `0o700` on a file owned by somebody else is not executable by us. On Windows
/// the question is only whether the file exists, since executability is carried
/// by the extension.
fn executable(path: &Path) -> bool {
	if !path.is_file() {
		return false;
	}
	#[cfg(unix)]
	{
		use std::os::unix::ffi::OsStrExt;

		let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
			return false;
		};
		// SAFETY: `c_path` is a valid NUL-terminated string for the duration of the
		// call and `access` only reads it.
		unsafe { libc::access(c_path.as_ptr(), libc::X_OK) == 0 }
	}
	#[cfg(not(unix))]
	true
}

/// The `name.ext` candidates Windows adds for a bare program name, from
/// `PATHEXT`.
#[cfg(windows)]
fn windows_extension_candidates(candidate: &Path) -> impl Iterator<Item = PathBuf> + '_ {
	// The four the system falls back to when `PATHEXT` is unset, in the order
	// `cmd.exe` tries them.
	let pathext = var("PATHEXT").unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string());
	pathext
		.split(PATH_SEPARATOR)
		.filter(|ext| !ext.is_empty())
		.map(|ext| {
			let mut with_ext = candidate.as_os_str().to_os_string();
			with_ext.push(ext);
			PathBuf::from(with_ext)
		})
		.collect::<Vec<_>>()
		.into_iter()
}

/// Returns true when scoped stdin is a shell pipe or custom stream that should
/// be treated as `rg PATTERN`'s implicit input instead of searching `.`.
#[must_use]
pub fn stdin_is_search_input() -> bool {
	CTX.with(|c| {
		c.borrow()
			.as_ref()
			.is_some_and(|ctx| ctx.stdin_is_search_input)
	})
}

/// Returns true when the active scope's stdout is a terminal.
///
/// Returns false when no scope is installed, which is deliberate and is the
/// conservative answer rather than a guess: with no scope there is no command
/// whose stdout could be asked about, and the two decisions that read this
/// (output buffering, and anything else that would stream for a human) are the
/// ones where being wrong towards a terminal means flushing every line of a
/// large redirected run.
#[must_use]
pub fn stdout_is_terminal() -> bool {
	CTX.with(|c| {
		c.borrow()
			.as_ref()
			.is_some_and(|ctx| ctx.stdout_is_terminal)
	})
}

/// Returns true when the host has asked the active scope to cancel (e.g. on
/// shell `abort`/`timeout`). uutils utilities running long internal loops —
/// recursive directory walks in particular — poll this so cancellation is
/// observed without waiting for stdin or for the whole work item to finish.
///
/// Returns false when no scope is installed; the cancel flag itself is the
/// same one observed by [`CtxStdin::read`].
#[must_use]
pub fn is_cancelled() -> bool {
	CTX.with(|c| {
		c.borrow()
			.as_ref()
			.is_some_and(|ctx| ctx.cancel.load(Ordering::Relaxed))
	})
}

macro_rules! ctx_writer {
	($name:ident, $field:ident, $doc:literal) => {
		#[doc = $doc]
		#[derive(Clone, Copy)]
		pub struct $name;

		impl $name {
			/// Mirror of `std::io::Stdout::lock`; the handle is already the
			/// lockable target, so this is the identity. Lets patched uutils
			/// code keep its `let out = ...; let out = out.lock();` shape.
			#[must_use]
			pub fn lock(self) -> Self {
				self
			}
		}

		impl Write for $name {
			fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
				CTX.with(|c| match c.borrow_mut().as_mut() {
					Some(ctx) => ctx.$field.write(buf),
					// No context installed: discard rather than leak onto the
					// host process's real fd.
					None => Ok(buf.len()),
				})
			}

			fn flush(&mut self) -> io::Result<()> {
				CTX.with(|c| match c.borrow_mut().as_mut() {
					Some(ctx) => ctx.$field.flush(),
					None => Ok(()),
				})
			}
		}
	};
}

ctx_writer!(CtxStdout, stdout, "Context-aware stand-in for `std::io::Stdout`.");
ctx_writer!(CtxStderr, stderr, "Context-aware stand-in for `std::io::Stderr`.");

/// Context-aware stand-in for `std::io::Stdin`.
#[derive(Clone, Copy)]
pub struct CtxStdin;

impl CtxStdin {
	/// Identity lock, mirroring `std::io::Stdin::lock`.
	#[must_use]
	pub fn lock(self) -> Self {
		self
	}
}

impl Read for CtxStdin {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		CTX.with(|c| {
			let mut guard = c.borrow_mut();
			let Some(ctx) = guard.as_mut() else {
				return Ok(0);
			};
			if ctx.cancel.load(Ordering::Relaxed) {
				return Ok(0);
			}
			// On unix, wait for readiness in short slices so an abort/timeout is
			// observed even when input never arrives on a blocked pipe: the
			// utility then sees EOF and unwinds cleanly (no detached thread, no
			// writes after the host has moved on).
			#[cfg(unix)]
			if let Some(fd) = ctx.stdin_fd {
				loop {
					if ctx.cancel.load(Ordering::Relaxed) {
						return Ok(0);
					}
					let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
					// SAFETY: one `pollfd` valid for the call; `fd` is owned by the
					// live `OpenFile` held in this context.
					let r = unsafe { libc::poll(&mut pfd, 1, 200) };
					if r < 0 {
						let err = io::Error::last_os_error();
						if err.kind() == io::ErrorKind::Interrupted {
							continue;
						}
						return Err(err);
					}
					if r > 0 {
						break;
					}
				}
			}
			ctx.stdin.read(buf)
		})
	}
}

/// Returns the context stdout handle.
#[must_use]
pub fn stdout() -> CtxStdout {
	CtxStdout
}

/// Returns the context stderr handle.
#[must_use]
pub fn stderr() -> CtxStderr {
	CtxStderr
}

/// Returns the context stdin handle.
#[must_use]
pub fn stdin() -> CtxStdin {
	CtxStdin
}

/// The size of the scope's standard input, when it is a regular file.
///
/// This exists because some utilities lay their output out to fit the largest
/// number the input can produce, and they read that off the input's size rather
/// than discovering it as they go. `grep -T` is the case that asked for it: GNU
/// grep 3.11 right-aligns its line-number and byte-offset fields in a column
/// whose width is the digit count of the input's size, so `grep -T -n x < file`
/// on a 999-byte file aligns to four columns and `cat file | grep -T -n x`
/// aligns to nineteen, the width of the largest size a file could have.
///
/// Returns `None` when standard input is not a regular file, which is the
/// honest answer for a pipe or a terminal: its length is not knowable in
/// advance, and the caller is expected to say so rather than guess a small
/// number. Also `None` when the host handed over no descriptor, which is what
/// an in-process reader such as a test's `Cursor` looks like, and on platforms
/// without `fstat`.
#[must_use]
pub fn stdin_size() -> Option<u64> {
	#[cfg(unix)]
	{
		let fd = CTX.with(|c| c.borrow().as_ref().and_then(|ctx| ctx.stdin_fd))?;
		// SAFETY: `fstat` writes the whole struct and the result is read only when
		// the call reported success. `fd` is owned by the `OpenFile` the live
		// context holds, so it is open for the duration of this call.
		let stat = unsafe {
			let mut stat = std::mem::zeroed::<libc::stat>();
			if libc::fstat(fd, &mut stat) != 0 {
				return None;
			}
			stat
		};
		if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
			return None;
		}
		u64::try_from(stat.st_size).ok()
	}
	#[cfg(not(unix))]
	{
		None
	}
}

/// Generate the usage string for clap without evaluating argv-dependent
/// statics.
///
/// This is a panic-safe, argv-independent replacement for
/// `uucore::format_usage`. It indents all but the first line by 7 spaces to
/// align with clap's "Usage: " prefix. Callers must provide explicit usage
/// strings (with actual command names) and avoid `{}` placeholders.
#[must_use]
pub fn format_usage(s: &str) -> String {
	debug_assert!(
		!s.contains("{}"),
		"format_usage shim does not support placeholder '{{}}' - use explicit command names instead"
	);
	s.replace('\n', "\n       ")
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_format_usage_indentation() {
		let usage = "cat [OPTION]... [FILE]...\nSome descriptive text\nAnother line";
		let formatted = format_usage(usage);
		assert_eq!(
			formatted,
			"cat [OPTION]... [FILE]...\n       Some descriptive text\n       Another line"
		);
	}

	#[test]
	fn test_format_usage_empty() {
		let formatted = format_usage("");
		assert_eq!(formatted, "");
	}

	fn empty_io() -> ScopeIo {
		ScopeIo {
			stdin:                 Box::new(io::empty()),
			stdin_fd:              None,
			stdin_is_search_input: false,
			stdout:                Box::new(io::sink()),
			stdout_is_terminal:    false,
			stderr:                Box::new(io::sink()),
			cwd:                   PathBuf::from("."),
			env:                   HashMap::new(),
			cancel:                Arc::new(AtomicBool::new(false)),
		}
	}

	/// WHETHER STDOUT IS A TERMINAL IS THE HOST'S ANSWER, PER COMMAND.
	///
	/// WHY THIS SUITE EXISTS. This cannot be derived on this side: a utility
	/// sees stdout as a `Box<dyn Write>` with no descriptor behind it, and the
	/// process-global `std::io::stdout()` answers for the SHELL's stdout, which
	/// is the wrong answer for every redirected command and every stage of a
	/// pipeline. So the host declares it and the accessor reports exactly that,
	/// with no guessing anywhere in between. `rg` reads it to choose line
	/// buffering over block buffering, so a wrong answer here is either an
	/// interactive search that looks frozen or a redirected run that flushes
	/// every line.
	mod stdout_is_terminal_reports_what_the_host_declared {
		use super::*;

		fn scoped_with<R>(is_terminal: bool, f: impl FnOnce() -> R) -> R {
			let mut io = empty_io();
			io.stdout_is_terminal = is_terminal;
			scope(io, f)
		}

		/// Both answers come back, which a constant cannot satisfy.
		#[test]
		fn a_declared_terminal_and_a_declared_pipe_both_come_back() {
			assert!(scoped_with(true, stdout_is_terminal), "a host that declared a terminal");
			assert!(!scoped_with(false, stdout_is_terminal), "a host that declared a pipe");
		}

		/// With no scope the answer is false rather than the host process's tty.
		///
		/// Deliberate: with no scope there is no command whose stdout could be
		/// asked about, and answering from the process would make a library
		/// caller inherit whatever terminal the enclosing program happens to
		/// have.
		#[test]
		fn no_scope_is_not_a_terminal() {
			assert!(!stdout_is_terminal(), "outside a scope there is nothing to ask about");
		}

		/// A nested scope answers for itself and the outer answer is restored,
		/// which is what a pipeline stage inside an interactive shell looks like.
		#[test]
		fn a_nested_scope_answers_for_itself_and_restores_the_outer_answer() {
			scoped_with(true, || {
				assert!(stdout_is_terminal());
				scoped_with(false, || assert!(!stdout_is_terminal(), "the inner command is piped"));
				assert!(stdout_is_terminal(), "and the outer command is still on the terminal");
			});
			assert!(!stdout_is_terminal(), "and the scope is gone afterwards");
		}

		/// The declaration is independent of the other stream flags, so a scope
		/// cannot satisfy it by accident.
		#[test]
		fn it_is_independent_of_the_stdin_declaration() {
			let mut io = empty_io();
			io.stdout_is_terminal = true;
			io.stdin_is_search_input = false;
			scope(io, || {
				assert!(stdout_is_terminal());
				assert!(!stdin_is_search_input());
			});
		}
	}

	/// A PROGRAM NAME IS LOOKED UP ON THE SHELL'S `PATH`, NOT THE HOST
	/// PROCESS'S.
	///
	/// `Command::new("gzip")` asks the operating system to search, and the
	/// operating system searches the environment the HOST process was started
	/// with. A builtin runs inside a long-lived shell whose exported `PATH` is
	/// in the scope, so the two answers differ the moment a caller exports a
	/// directory of their own tools. Every builtin that starts a child resolves
	/// through `resolve_program` first, and these cases pin what it answers.
	#[cfg(unix)]
	mod resolve_program_follows_the_scopes_path {
		use std::os::unix::fs::PermissionsExt;

		use super::*;

		/// A fresh directory holding one executable and one plain file.
		fn tools(label: &str) -> veyyon_test_scratch::TempTree {
			// Owned rather than a bare path: nothing removed these, so every run left one
			// directory per case in the system temp directory.
			let root = veyyon_test_scratch::scratch_dir(&format!("ctx-resolve-{label}"));
			let tool = root.join("mytool");
			std::fs::write(&tool, "#!/bin/sh\nexit 0\n").expect("tool should be written");
			std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755))
				.expect("tool should be executable");
			std::fs::write(root.join("notatool"), "data\n").expect("file should be written");
			root
		}

		/// A scope with `cwd` and `PATH` set to what the caller asks for.
		fn scoped<R>(cwd: &Path, path_var: &str, f: impl FnOnce() -> R) -> R {
			let mut env = HashMap::new();
			env.insert("PATH".to_string(), path_var.to_string());
			let io = ScopeIo {
				stdin: Box::new(io::empty()),
				stdin_fd: None,
				stdin_is_search_input: false,
				stdout: Box::new(io::sink()),
				stdout_is_terminal: false,
				stderr: Box::new(io::sink()),
				cwd: cwd.to_path_buf(),
				env,
				cancel: Arc::new(AtomicBool::new(false)),
			};
			scope(io, f)
		}

		/// The headline: a bare name is found in a `PATH` entry the SCOPE names,
		/// and the answer is the full path to that file.
		#[test]
		fn a_bare_name_is_found_in_a_scope_path_entry() {
			let root = tools("bare");

			let found = scoped(&root, &root.to_string_lossy(), || resolve_program("mytool"));

			assert_eq!(found, Some(root.join("mytool")));

			let _ = std::fs::remove_dir_all(root);
		}

		/// The HOST process's `PATH` is not consulted. `/bin/sh` exists on every
		/// machine this runs on and is on the host's `PATH`; a scope whose
		/// `PATH` names one directory that does not hold it must answer `None`,
		/// or the lookup is reading the wrong environment.
		#[test]
		fn the_host_path_is_not_consulted() {
			let root = tools("host");

			let found = scoped(&root, &root.to_string_lossy(), || resolve_program("sh"));

			assert_eq!(found, None, "sh is on the host PATH and not on this one");

			let _ = std::fs::remove_dir_all(root);
		}

		/// Entries are tried IN ORDER, so the first directory holding the name
		/// wins, the way a shell resolves it.
		#[test]
		fn the_first_entry_holding_the_name_wins() {
			let first = tools("order-first");
			let second = tools("order-second");
			let path_var = format!("{}:{}", first.display(), second.display());

			let found = scoped(&first, &path_var, || resolve_program("mytool"));
			assert_eq!(found, Some(first.join("mytool")));

			let reversed = format!("{}:{}", second.display(), first.display());
			let found = scoped(&first, &reversed, || resolve_program("mytool"));
			assert_eq!(found, Some(second.join("mytool")), "order decides, not the cwd");

			let _ = std::fs::remove_dir_all(first);
			let _ = std::fs::remove_dir_all(second);
		}

		/// A file that is not executable is not a program, even when its name
		/// matches. Returning it would hand the caller a spawn failure instead
		/// of a `None` it can report properly.
		#[test]
		fn a_file_that_is_not_executable_is_not_a_program() {
			let root = tools("notexec");

			let found = scoped(&root, &root.to_string_lossy(), || resolve_program("notatool"));

			assert_eq!(found, None);

			let _ = std::fs::remove_dir_all(root);
		}

		/// A name holding a separator names a FILE, resolved against the scope's
		/// working directory, and `PATH` is not consulted at all. This is the
		/// `--pre ./wrapper.sh` case, where the shell's cwd is the only thing
		/// that can make the path mean anything.
		#[test]
		fn a_name_with_a_separator_resolves_against_the_scope_cwd() {
			let root = tools("relative");

			let found = scoped(&root, "/nonexistent", || resolve_program("./mytool"));
			assert_eq!(found, Some(root.join("./mytool")), "cwd, not PATH");

			let found = scoped(&root, "/nonexistent", || resolve_program("./notatool"));
			assert_eq!(found, None, "and still has to be executable");

			let _ = std::fs::remove_dir_all(root);
		}

		/// An ABSOLUTE name is taken as written, whatever the scope's directory
		/// is.
		#[test]
		fn an_absolute_name_is_taken_as_written() {
			let root = tools("absolute");
			let tool = root.join("mytool");

			let found = scoped(Path::new("/"), "", || resolve_program(&tool));

			assert_eq!(found, Some(tool));

			let _ = std::fs::remove_dir_all(root);
		}

		/// An EMPTY `PATH` entry means the working directory, which is what POSIX
		/// says it means. Joining an empty entry with the name would instead
		/// produce the bare name and resolve it against the HOST process
		/// directory.
		#[test]
		fn an_empty_path_entry_means_the_working_directory() {
			let root = tools("empty-entry");

			let found = scoped(&root, ":/nonexistent", || resolve_program("mytool"));

			assert_eq!(found, Some(root.join("mytool")));

			let _ = std::fs::remove_dir_all(root);
		}

		/// A RELATIVE `PATH` entry is resolved against the scope's working
		/// directory too, so `PATH=tools` finds `tools/mytool` under the
		/// shell's directory.
		#[test]
		fn a_relative_path_entry_resolves_against_the_scope_cwd() {
			let root = tools("relative-entry");
			let parent = root.parent().expect("temp dir has a parent").to_path_buf();
			let leaf = root
				.file_name()
				.expect("temp dir has a name")
				.to_string_lossy()
				.into_owned();

			let found = scoped(&parent, &leaf, || resolve_program("mytool"));

			assert_eq!(found, Some(parent.join(&leaf).join("mytool")));

			let _ = std::fs::remove_dir_all(root);
		}

		/// With no scope installed there is no `PATH` to read, so the answer is
		/// `None` rather than the host's. A builtin always runs inside a scope;
		/// this pins that the fallback is not "ask the host".
		#[test]
		fn no_scope_means_no_answer() {
			assert_eq!(resolve_program("sh"), None, "no scope, no PATH, no program");
		}
	}

	#[test]
	fn is_active_tracks_scope_and_survives_panic() {
		assert!(!is_active(), "no scope installed");
		scope(empty_io(), || assert!(is_active(), "scope active inside closure"));
		assert!(!is_active(), "scope torn down");

		// The crash hook reads is_active() while a panic unwinds, so the depth
		// counter must be restored by the scope guard even on panic.
		let unwound = std::panic::catch_unwind(|| scope(empty_io(), || panic!("boom")));
		assert!(unwound.is_err(), "panic propagated out of the scope");
		assert!(!is_active(), "scope depth restored after an unwinding panic");
	}
}
