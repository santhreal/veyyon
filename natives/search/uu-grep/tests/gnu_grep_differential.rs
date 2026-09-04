#![cfg(unix)]
//! Differential test: our `grep` builtin against GNU grep 3.11, flag set by
//! flag set.
//!
//! WHY THIS SUITE EXISTS. The `grep` tests in `src/lib.rs` each assert one
//! measured rule, which is how every one of them was found and fixed. What none
//! of them do is run the WHOLE tool over the same files GNU grep saw and
//! compare the bytes, so a flag nobody had written a suite for could disagree
//! in every run and nothing would say so. The sibling suite for the `rg`
//! builtin, `ripgrep_differential.rs`, found four real defects the first time
//! it ran; this is the same method pointed at the other tool.
//!
//! HOW THE CORPUS WAS BUILT. The tree below was written to a temporary
//! directory and `/usr/bin/grep <flags>` was run for each flag set with that
//! directory as the working directory and `LC_ALL=C` in an otherwise empty
//! environment, which is the locale the test scope has. Every case names its
//! operands EXPLICITLY, in a fixed order, because GNU grep has no `--sort` and
//! the order a `-r` walk returns names in is the filesystem's. The two
//! recursive cases are narrowed to a single file for the same reason.
//!
//! WHY THIS SUITE IS UNIX-ONLY. The expectations are GNU grep 3.11's bytes from
//! a Linux run, and some of them are about behaviour that has no Windows
//! counterpart: a symlinked directory that `-r` walks past and `-R` follows, a
//! file mode that makes a read fail, and paths printed with `/` between the
//! components. A byte comparison against that capture on Windows would be
//! asserting the wrong tool's answer, so the suite is compiled only where the
//! reference applies. The rules themselves are pinned platform-independently by
//! the suites in `src/lib.rs`.
//!
//! A CASE THAT FAILS HERE IS A FINDING. Do not edit an expectation to make it
//! pass; a case that is knowingly different carries `divergence` with the
//! reason, and the suite fails on a stale exception so a fix cannot leave one
//! behind.

use std::{
	collections::HashMap,
	ffi::OsString,
	io::Write,
	path::Path,
	sync::{Arc, Mutex, atomic::AtomicBool},
};

use veyyon_test_scratch::{TempTree, scratch_dir};
use veyyon_uutils_ctx::{ScopeIo, scope};

/// One flag set and what GNU grep printed for it.
struct Case {
	/// The flags as written, for the failure message.
	flags:      &'static str,
	/// The full argument list, `grep` itself excluded.
	args:       &'static [&'static str],
	/// What the run reads from standard input, empty when it searches files.
	stdin:      &'static [u8],
	code:       i32,
	stdout:     &'static [u8],
	stderr:     &'static [u8],
	/// Set when OUR answer is knowingly different, with the reason.
	divergence: Option<&'static str>,
}

/// The fixture tree, written fresh for every case so no case can leave state
/// behind.
///
/// The shapes are chosen to reach the parts of the tool that flags argue about:
/// a subdirectory, an uppercase-only match, CRLF line endings, multi-byte text,
/// an empty file, a file whose last line has no terminator, and a file holding
/// a NUL.
const TEXT_FILES: &[(&str, &str)] = &[
	("a.txt", "alpha hit\nbeta\nhit hit\ngamma\n"),
	("b.log", "log hit\nnothing\n"),
	("sub/c.txt", "deep hit\n"),
	("sub/d.md", "markdown HIT\n"),
	("crlf.txt", "crlf hit\r\nsecond\r\n"),
	("uni.txt", "café hit\nnaïve\n"),
	("empty.txt", ""),
	("notrail.txt", "tail hit"),
	("punct.txt", "hit.\n(hit)\nhit-hit\nshit\nhits\n"),
	("dup.txt", "hit hit hit\nhit\nhit\nhit\nhit\n"),
	("sub/deep/e.txt", "nested hit\n"),
	("pats.list", "hit\nbeta\n"),
];

/// The binary file, kept separate because its bytes are not text.
const BINARY_FILE: (&str, &[u8]) = ("bin.dat", b"bin \x00 hit\n");

/// Write the fixture tree into a fresh directory and hand back the guard that
/// owns it.
///
/// The tree used to be a fixed name per label, wiped on the way in and never on
/// the way out, so every run of this file left one directory per case behind
/// for good. It is a `TempTree` now, which removes itself when the test that
/// made it ends and is unique per process, so two runs in parallel cannot fight
/// over the same path either.
fn fixture_tree(label: usize) -> TempTree {
	let root = scratch_dir(&format!("grep-differential-{label}"));
	std::fs::create_dir_all(root.join("sub/deep")).expect("temp tree should be created");
	for (name, text) in TEXT_FILES {
		std::fs::write(root.join(name), text).expect("fixture file should be written");
	}
	std::fs::write(root.join(BINARY_FILE.0), BINARY_FILE.1).expect("binary fixture");
	// A symlink to a file and one to a directory, which `-r` and `-R` answer
	// differently for: the walk does not follow a linked directory it reached, and
	// does follow one it was given.
	std::os::unix::fs::symlink("a.txt", root.join("link.txt")).expect("the file symlink");
	std::os::unix::fs::symlink("sub", root.join("linkdir")).expect("the directory symlink");
	root
}

/// A writer that collects into a shared buffer.
struct SharedBuf(Arc<Mutex<Vec<u8>>>);

impl Write for SharedBuf {
	fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
		self
			.0
			.lock()
			.expect("the buffer lock is never poisoned")
			.extend_from_slice(buf);
		Ok(buf.len())
	}

	fn flush(&mut self) -> std::io::Result<()> {
		Ok(())
	}
}

/// Run our builtin over `cwd` with `args`, returning `(code, stdout, stderr)`.
///
/// `PATH` is the only environment variable the scope carries, which is also the
/// environment the reference runs were made in: no locale variable means the C
/// locale, and the multi-byte rules the builtin applies under a UTF-8 locale
/// stay off.
fn run_grep(args: &[&str], stdin: &[u8], cwd: &Path) -> (i32, Vec<u8>, Vec<u8>) {
	let out = Arc::new(Mutex::new(Vec::new()));
	let err = Arc::new(Mutex::new(Vec::new()));
	let mut env = HashMap::new();
	if let Ok(path) = std::env::var("PATH") {
		env.insert("PATH".to_string(), path);
	}
	let io = ScopeIo {
		stdin: Box::new(std::io::Cursor::new(stdin.to_vec())),
		stdin_fd: None,
		stdin_is_search_input: true,
		stdout: Box::new(SharedBuf(Arc::clone(&out))),
		stdout_is_terminal: false,
		stderr: Box::new(SharedBuf(Arc::clone(&err))),
		cwd: cwd.to_path_buf(),
		env,
		cancel: Arc::new(AtomicBool::new(false)),
	};
	let argv: Vec<OsString> = std::iter::once("grep")
		.chain(args.iter().copied())
		.map(OsString::from)
		.collect();
	let code = scope(io, || veyyon_uu_grep::run(argv));
	let stdout = out.lock().expect("lock").clone();
	let stderr = err.lock().expect("lock").clone();
	(code, stdout, stderr)
}

/// Every case, compared in one test so a run reports the whole divergence list.
#[test]
fn our_output_matches_gnu_grep_flag_set_by_flag_set() {
	let mut failures = Vec::new();
	for (index, case) in CASES.iter().enumerate() {
		let tree = fixture_tree(index);
		let (code, stdout, stderr) = run_grep(case.args, case.stdin, &tree);
		let _ = std::fs::remove_dir_all(&tree);
		let matched = code == case.code && stdout == case.stdout && stderr == case.stderr;
		match (matched, case.divergence) {
			(true, None) => {},
			(true, Some(reason)) => failures.push(format!(
				"{}: agrees with GNU grep now, so the exception is stale and has to go: {reason}",
				case.flags
			)),
			(false, Some(_)) => {},
			(false, None) => failures.push(format!(
				"{}:\n  ours: code={code} out={:?} err={:?}\n  gnu:  code={} out={:?} err={:?}",
				case.flags,
				String::from_utf8_lossy(&stdout),
				String::from_utf8_lossy(&stderr),
				case.code,
				String::from_utf8_lossy(case.stdout),
				String::from_utf8_lossy(case.stderr)
			)),
		}
	}
	assert!(
		failures.is_empty(),
		"{} of {} flag sets disagree with GNU grep 3.11:\n{}",
		failures.len(),
		CASES.len(),
		failures.join("\n")
	);
}

/// The corpus. Captured by running GNU grep 3.11 over the fixture tree; see the module
/// docs, and do not edit an expectation to make a case pass.
///
/// `rustfmt::skip` keeps the formatter from breaking these string literals: with
/// `format_strings = true` a break can land between a backslash and its escape letter
/// and change what the literal means.
#[rustfmt::skip]
static CASES: &[Case] = &[
	// Every operand in a fixed order, so the comparison does not depend on a directory
	// walk's order.
	Case {
		flags:      "(no flags)",
		args:       &["hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt:hit hit\nb.log:log hit\nsub/c.txt:deep hit\ncrlf.txt:crlf hit\r\nuni.txt:caf\xc3\xa9 hit\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-n",
		args:       &["-n", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:1:alpha hit\na.txt:3:hit hit\nb.log:1:log hit\nsub/c.txt:1:deep hit\ncrlf.txt:1:crlf hit\r\nuni.txt:1:caf\xc3\xa9 hit\nnotrail.txt:1:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-H",
		args:       &["-H", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt:hit hit\nb.log:log hit\nsub/c.txt:deep hit\ncrlf.txt:crlf hit\r\nuni.txt:caf\xc3\xa9 hit\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-h",
		args:       &["-h", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"alpha hit\nhit hit\nlog hit\ndeep hit\ncrlf hit\r\ncaf\xc3\xa9 hit\ntail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-c",
		args:       &["-c", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:2\nb.log:1\nsub/c.txt:1\nsub/d.md:0\ncrlf.txt:1\nuni.txt:1\nempty.txt:0\nnotrail.txt:1\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-l",
		args:       &["-l", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt\nb.log\nsub/c.txt\ncrlf.txt\nuni.txt\nnotrail.txt\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-L",
		args:       &["-L", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"sub/d.md\nempty.txt\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-o",
		args:       &["-o", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:hit\na.txt:hit\na.txt:hit\nb.log:hit\nsub/c.txt:hit\ncrlf.txt:hit\nuni.txt:hit\nnotrail.txt:hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-w",
		args:       &["-w", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt:hit hit\nb.log:log hit\nsub/c.txt:deep hit\ncrlf.txt:crlf hit\r\nuni.txt:caf\xc3\xa9 hit\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-x",
		args:       &["-x", "hit hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:hit hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-i",
		args:       &["-i", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt:hit hit\nb.log:log hit\nsub/c.txt:deep hit\nsub/d.md:markdown HIT\ncrlf.txt:crlf hit\r\nuni.txt:caf\xc3\xa9 hit\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-v",
		args:       &["-v", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:beta\na.txt:gamma\nb.log:nothing\nsub/d.md:markdown HIT\ncrlf.txt:second\r\nuni.txt:na\xc3\xafve\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-b",
		args:       &["-b", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:0:alpha hit\na.txt:15:hit hit\nb.log:0:log hit\nsub/c.txt:0:deep hit\ncrlf.txt:0:crlf hit\r\nuni.txt:0:caf\xc3\xa9 hit\nnotrail.txt:0:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-o -b",
		args:       &["-o", "-b", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:6:hit\na.txt:15:hit\na.txt:19:hit\nb.log:4:hit\nsub/c.txt:5:hit\ncrlf.txt:5:hit\nuni.txt:6:hit\nnotrail.txt:5:hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-m1",
		args:       &["-m1", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\nb.log:log hit\nsub/c.txt:deep hit\ncrlf.txt:crlf hit\r\nuni.txt:caf\xc3\xa9 hit\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	// A cap of zero matches nothing and still reports the status of a search that found
	// nothing.
	Case {
		flags:      "-m0",
		args:       &["-m0", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       1,
		stdout:     b"",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-A1",
		args:       &["-A1", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt-beta\na.txt:hit hit\na.txt-gamma\n--\nb.log:log hit\nb.log-nothing\n--\nsub/c.txt:deep hit\n--\ncrlf.txt:crlf hit\r\ncrlf.txt-second\r\n--\nuni.txt:caf\xc3\xa9 hit\nuni.txt-na\xc3\xafve\n--\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-B1",
		args:       &["-B1", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt-beta\na.txt:hit hit\n--\nb.log:log hit\n--\nsub/c.txt:deep hit\n--\ncrlf.txt:crlf hit\r\n--\nuni.txt:caf\xc3\xa9 hit\n--\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-C1",
		args:       &["-C1", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt-beta\na.txt:hit hit\na.txt-gamma\n--\nb.log:log hit\nb.log-nothing\n--\nsub/c.txt:deep hit\n--\ncrlf.txt:crlf hit\r\ncrlf.txt-second\r\n--\nuni.txt:caf\xc3\xa9 hit\nuni.txt-na\xc3\xafve\n--\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-C0",
		args:       &["-C0", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\n--\na.txt:hit hit\n--\nb.log:log hit\n--\nsub/c.txt:deep hit\n--\ncrlf.txt:crlf hit\r\n--\nuni.txt:caf\xc3\xa9 hit\n--\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-A1 --group-separator=XX",
		args:       &["-A1", "--group-separator=XX", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt-beta\na.txt:hit hit\na.txt-gamma\nXX\nb.log:log hit\nb.log-nothing\nXX\nsub/c.txt:deep hit\nXX\ncrlf.txt:crlf hit\r\ncrlf.txt-second\r\nXX\nuni.txt:caf\xc3\xa9 hit\nuni.txt-na\xc3\xafve\nXX\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-A1 --no-group-separator",
		args:       &["-A1", "--no-group-separator", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt-beta\na.txt:hit hit\na.txt-gamma\nb.log:log hit\nb.log-nothing\nsub/c.txt:deep hit\ncrlf.txt:crlf hit\r\ncrlf.txt-second\r\nuni.txt:caf\xc3\xa9 hit\nuni.txt-na\xc3\xafve\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-T",
		args:       &["-T", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:\talpha hit\na.txt:\thit hit\nb.log:\tlog hit\nsub/c.txt:\tdeep hit\ncrlf.txt:\tcrlf hit\r\nuni.txt:\tcaf\xc3\xa9 hit\nnotrail.txt:\ttail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-n -T",
		args:       &["-n", "-T", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt: 1:\talpha hit\na.txt: 3:\thit hit\nb.log: 1:\tlog hit\nsub/c.txt: 1:\tdeep hit\ncrlf.txt: 1:\tcrlf hit\r\nuni.txt: 1:\tcaf\xc3\xa9 hit\nnotrail.txt:1:\ttail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-n -b -T",
		args:       &["-n", "-b", "-T", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt: 1: 0:\talpha hit\na.txt: 3:15:\thit hit\nb.log: 1: 0:\tlog hit\nsub/c.txt: 1: 0:\tdeep hit\ncrlf.txt: 1: 0:\tcrlf hit\r\nuni.txt: 1: 0:\tcaf\xc3\xa9 hit\nnotrail.txt:1:0:\ttail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-Z",
		args:       &["-Z", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt\x00alpha hit\na.txt\x00hit hit\nb.log\x00log hit\nsub/c.txt\x00deep hit\ncrlf.txt\x00crlf hit\r\nuni.txt\x00caf\xc3\xa9 hit\nnotrail.txt\x00tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-l -Z",
		args:       &["-l", "-Z", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt\x00b.log\x00sub/c.txt\x00crlf.txt\x00uni.txt\x00notrail.txt\x00",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-L -Z",
		args:       &["-L", "-Z", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"sub/d.md\x00empty.txt\x00",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-c -v",
		args:       &["-c", "-v", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:2\nb.log:1\nsub/c.txt:0\nsub/d.md:1\ncrlf.txt:1\nuni.txt:1\nempty.txt:0\nnotrail.txt:0\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-h -c",
		args:       &["-h", "-c", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"2\n1\n1\n0\n1\n1\n0\n1\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-F",
		args:       &["-F", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt:hit hit\nb.log:log hit\nsub/c.txt:deep hit\ncrlf.txt:crlf hit\r\nuni.txt:caf\xc3\xa9 hit\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-E h(i)t",
		args:       &["-E", "h(i)t", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt:hit hit\nb.log:log hit\nsub/c.txt:deep hit\ncrlf.txt:crlf hit\r\nuni.txt:caf\xc3\xa9 hit\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	// A BASIC regular expression, where the escaped parentheses are the group and the bare
	// ones are literal.
	Case {
		flags:      "-G with escaped parentheses",
		args:       &["-G", "h\\(i\\)t", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt:hit hit\nb.log:log hit\nsub/c.txt:deep hit\ncrlf.txt:crlf hit\r\nuni.txt:caf\xc3\xa9 hit\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-P with a word class",
		args:       &["-P", "h\\wt", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt:hit hit\nb.log:log hit\nsub/c.txt:deep hit\ncrlf.txt:crlf hit\r\nuni.txt:caf\xc3\xa9 hit\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-e hit -e beta",
		args:       &["-e", "hit", "-e", "beta", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt:beta\na.txt:hit hit\nb.log:log hit\nsub/c.txt:deep hit\ncrlf.txt:crlf hit\r\nuni.txt:caf\xc3\xa9 hit\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	// A pattern that can match nothing at all, which is where an off-by-one in the
	// empty-match rule shows.
	Case {
		flags:      "-o 'x*'",
		args:       &["-o", "x*", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-i -o -w",
		args:       &["-i", "-o", "-w", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:hit\na.txt:hit\na.txt:hit\nb.log:hit\nsub/c.txt:hit\nsub/d.md:HIT\ncrlf.txt:hit\nuni.txt:hit\nnotrail.txt:hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-a",
		args:       &["-a", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt:hit hit\nb.log:log hit\nsub/c.txt:deep hit\ncrlf.txt:crlf hit\r\nuni.txt:caf\xc3\xa9 hit\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-I",
		args:       &["-I", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt:hit hit\nb.log:log hit\nsub/c.txt:deep hit\ncrlf.txt:crlf hit\r\nuni.txt:caf\xc3\xa9 hit\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--binary-files=text",
		args:       &["--binary-files=text", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt:hit hit\nb.log:log hit\nsub/c.txt:deep hit\ncrlf.txt:crlf hit\r\nuni.txt:caf\xc3\xa9 hit\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--binary-files=without-match",
		args:       &["--binary-files=without-match", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt:hit hit\nb.log:log hit\nsub/c.txt:deep hit\ncrlf.txt:crlf hit\r\nuni.txt:caf\xc3\xa9 hit\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-U",
		args:       &["-U", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt:hit hit\nb.log:log hit\nsub/c.txt:deep hit\ncrlf.txt:crlf hit\r\nuni.txt:caf\xc3\xa9 hit\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--color=never",
		args:       &["--color=never", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt:hit hit\nb.log:log hit\nsub/c.txt:deep hit\ncrlf.txt:crlf hit\r\nuni.txt:caf\xc3\xa9 hit\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	// NUL-terminated records, so each file is one record here.
	Case {
		flags:      "-z",
		args:       &["-z", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\nbeta\nhit hit\ngamma\n\x00b.log:log hit\nnothing\n\x00sub/c.txt:deep hit\n\x00crlf.txt:crlf hit\r\nsecond\r\n\x00uni.txt:caf\xc3\xa9 hit\nna\xc3\xafve\n\x00notrail.txt:tail hit\x00",
		stderr:     b"",
		divergence: None,
	},
	// The binary notice, and which stream it goes to.
	Case {
		flags:      "bin.dat alone",
		args:       &["hit", "bin.dat"],
		stdin:      b"",
		code:       0,
		stdout:     b"",
		stderr:     b"grep: bin.dat: binary file matches\n",
		divergence: None,
	},
	Case {
		flags:      "-c bin.dat",
		args:       &["-c", "hit", "bin.dat"],
		stdin:      b"",
		code:       0,
		stdout:     b"1\n",
		stderr:     b"",
		divergence: None,
	},
	// A file whose last line has no terminator: the record still ends with one.
	Case {
		flags:      "notrail.txt alone",
		args:       &["hit", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-o notrail.txt",
		args:       &["-o", "hit", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-A1 notrail.txt",
		args:       &["-A1", "hit", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "a missing file",
		args:       &["hit", "a.txt", "missing.txt"],
		stdin:      b"",
		code:       2,
		stdout:     b"a.txt:alpha hit\na.txt:hit hit\n",
		stderr:     b"grep: missing.txt: No such file or directory\n",
		divergence: None,
	},
	Case {
		flags:      "-s with a missing file",
		args:       &["-s", "hit", "a.txt", "missing.txt"],
		stdin:      b"",
		code:       2,
		stdout:     b"a.txt:alpha hit\na.txt:hit hit\n",
		stderr:     b"",
		divergence: None,
	},
	// A quiet run that matched exits 0 even though a later operand could not be read.
	Case {
		flags:      "-q with a missing file",
		args:       &["-q", "hit", "a.txt", "missing.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "a directory operand",
		args:       &["hit", "sub"],
		stdin:      b"",
		code:       2,
		stdout:     b"",
		stderr:     b"grep: sub: Is a directory\n",
		divergence: None,
	},
	Case {
		flags:      "-d skip on a directory",
		args:       &["-d", "skip", "hit", "sub"],
		stdin:      b"",
		code:       1,
		stdout:     b"",
		stderr:     b"",
		divergence: None,
	},
	// Recursion narrowed to one file, so the order the walk returns names in cannot change
	// the answer.
	Case {
		flags:      "-r sub --include=c.txt",
		args:       &["-r", "--include=c.txt", "hit", "sub"],
		stdin:      b"",
		code:       0,
		stdout:     b"sub/c.txt:deep hit\n",
		stderr:     b"",
		divergence: None,
	},
	// An exclusion applies to a name given on the command line, not only to a walked one.
	Case {
		flags:      "--exclude=*.log",
		args:       &["--exclude=*.log", "hit", "a.txt", "b.log", "sub/c.txt", "sub/d.md", "crlf.txt", "uni.txt", "empty.txt", "notrail.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\na.txt:hit hit\nsub/c.txt:deep hit\ncrlf.txt:crlf hit\r\nuni.txt:caf\xc3\xa9 hit\nnotrail.txt:tail hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "stdin",
		args:       &["hit"],
		stdin:      b"alpha hit\nbeta\n",
		code:       0,
		stdout:     b"alpha hit\n",
		stderr:     b"",
		divergence: None,
	},
	// A named stdin is `(standard input)`.
	Case {
		flags:      "stdin -n -H",
		args:       &["-n", "-H", "hit"],
		stdin:      b"alpha hit\nbeta\n",
		code:       0,
		stdout:     b"(standard input):1:alpha hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "stdin --label=LBL -H",
		args:       &["--label=LBL", "-H", "hit"],
		stdin:      b"alpha hit\n",
		code:       0,
		stdout:     b"LBL:alpha hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "stdin -c",
		args:       &["-c", "hit"],
		stdin:      b"alpha hit\nbeta\nhit\n",
		code:       0,
		stdout:     b"2\n",
		stderr:     b"",
		divergence: None,
	},
	// An empty pattern matches every line.
	Case {
		flags:      "stdin -e ''",
		args:       &["-e", ""],
		stdin:      b"one\ntwo\n",
		code:       0,
		stdout:     b"one\ntwo\n",
		stderr:     b"",
		divergence: None,
	},
	// GNU keeps printing trailing context after the cap is reached, which is a documented
	// quirk and not a rounding error.
	Case {
		flags:      "-m1 -A1 on a file with five matches",
		args:       &["-m1", "-A1", "hit", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit hit hit\nhit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-m2 -B1",
		args:       &["-m2", "-B1", "hit", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit hit hit\nhit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-m1 -c",
		args:       &["-m1", "-c", "hit", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"1\n",
		stderr:     b"",
		divergence: None,
	},
	// The cap counts matching LINES, so the first line's three matches all print.
	Case {
		flags:      "-m1 -o",
		args:       &["-m1", "-o", "hit", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit\nhit\nhit\n",
		stderr:     b"",
		divergence: None,
	},
	// The aligned width is the file's own, which is what `-T` pads every number to.
	Case {
		flags:      "-o -T -n -b",
		args:       &["-o", "-T", "-n", "-b", "hit", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b" 1: 0:\thit\n 1: 4:\thit\n 1: 8:\thit\n 2:12:\thit\n 3:16:\thit\n 4:20:\thit\n 5:24:\thit\n",
		stderr:     b"",
		divergence: None,
	},
	// A word boundary at a dot, a parenthesis, a hyphen, and inside a longer word.
	Case {
		flags:      "-w on punctuation",
		args:       &["-w", "hit", "punct.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit.\n(hit)\nhit-hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-w -o on punctuation",
		args:       &["-w", "-o", "hit", "punct.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit\nhit\nhit\nhit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-x on punctuation",
		args:       &["-x", "hit", "punct.txt"],
		stdin:      b"",
		code:       1,
		stdout:     b"",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-x -v on punctuation",
		args:       &["-x", "-v", "hit", "punct.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit.\n(hit)\nhit-hit\nshit\nhits\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-c -i uppercase only",
		args:       &["-c", "-i", "hit", "sub/d.md"],
		stdin:      b"",
		code:       0,
		stdout:     b"1\n",
		stderr:     b"",
		divergence: None,
	},
	// The POSIX span rule, which is the whole reason `PosixLongest` exists. GNU grep
	// reports the LONGEST of the alternatives that match at a position, and a
	// leftmost-first engine reports the one written first, so `hit|hit hit` over
	// `hit hit hit` is `hit hit` then `hit` and not `hit` three times.
	Case {
		flags:      "-o overlapping alternation",
		args:       &["-o", "-E", "hit|hit hit", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit hit\nhit\nhit\nhit\nhit\nhit\n",
		stderr:     b"",
		divergence: None,
	},
	// The order the alternatives are written in cannot matter to a POSIX matcher, so
	// this is the same output as the case above with the branches swapped.
	Case {
		flags:      "the longer alternative written first, which must not change the answer",
		args:       &["-o", "-E", "hit hit|hit", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit hit\nhit\nhit\nhit\nhit\nhit\n",
		stderr:     b"",
		divergence: None,
	},
	// And the longest wins however far down the list it sits, which a fix that just
	// preferred an earlier longer branch would get wrong.
	Case {
		flags:      "-o where the longest alternative is written last",
		args:       &["-o", "-E", "hit|hit hit|hit hit hit", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit hit hit\nhit\nhit\nhit\nhit\n",
		stderr:     b"",
		divergence: None,
	},
	// The rule is about the whole match, not about a top-level alternation: two
	// optional groups have the same choice to make.
	Case {
		flags:      "-o with the alternation inside a group",
		args:       &["-o", "-E", "hit( hit)?( hit)?", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit hit hit\nhit\nhit\nhit\nhit\n",
		stderr:     b"",
		divergence: None,
	},
	// A bounded repeat is the same question again, and note the trailing space: GNU
	// takes the longest match, space included.
	Case {
		flags:      "-o with a bounded repeat",
		args:       &["-o", "-E", "(hit ?){1,2}", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit hit \nhit\nhit\nhit\nhit\nhit\n",
		stderr:     b"",
		divergence: None,
	},
	// `-w` bounds the match with non-word characters, and the longest span that still
	// ends on a boundary is the answer.
	Case {
		flags:      "-o -w with an alternation",
		args:       &["-o", "-w", "-E", "hit|hit hit", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit hit\nhit\nhit\nhit\nhit\nhit\n",
		stderr:     b"",
		divergence: None,
	},
	// Here the longest branch would end INSIDE a word on some lines, so the word rule
	// picks the shorter span and `hits` only wins where the line really ends in it.
	Case {
		flags:      "-o -w where the longest span would break the word rule",
		args:       &["-o", "-w", "-E", "hit|hits", "punct.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit\nhit\nhit\nhit\nhits\n",
		stderr:     b"",
		divergence: None,
	},
	// Case folding does not change which span is longest.
	Case {
		flags:      "-o -i with an alternation",
		args:       &["-o", "-i", "-E", "HIT|HIT HIT", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit hit\nhit\nhit\nhit\nhit\nhit\n",
		stderr:     b"",
		divergence: None,
	},
	// `-x` leaves nothing to choose: a whole-line match covers the line.
	Case {
		flags:      "-o -x with an alternation",
		args:       &["-o", "-x", "-E", "hit hit hit|hit", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit hit hit\nhit\nhit\nhit\nhit\n",
		stderr:     b"",
		divergence: None,
	},
	// A literal search has one span per position, so the rule is invisible here. The
	// case exists so a fix cannot change what `-F` prints.
	Case {
		flags:      "-o -F takes no alternation",
		args:       &["-o", "-F", "hit", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit\nhit\nhit\nhit\nhit\nhit\nhit\n",
		stderr:     b"",
		divergence: None,
	},
	// A back-reference routes to PCRE2, which is leftmost-first and has no POSIX span
	// engine behind it. The pattern is unambiguous here, so the two agree anyway.
	Case {
		flags:      "-o with a back-reference under -G",
		args:       &["-o", "-G", "\\(hit\\) \\1", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit hit\n",
		stderr:     b"",
		divergence: None,
	},
	// The byte offset is the span's START, so a longer span moves the NEXT offset and
	// not this one.
	Case {
		flags:      "-o -b with an alternation",
		args:       &["-o", "-b", "-E", "hit|hit hit", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"0:hit hit\n8:hit\n12:hit\n16:hit\n20:hit\n24:hit\n",
		stderr:     b"",
		divergence: None,
	},
	// Two spans on one line both carry that line's number.
	Case {
		flags:      "-o -n with an alternation",
		args:       &["-o", "-n", "-E", "hit|hit hit", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"1:hit hit\n1:hit\n2:hit\n3:hit\n4:hit\n5:hit\n",
		stderr:     b"",
		divergence: None,
	},
	// The span rule must not reach the counting mode: `-c` counts LINES, so it is the
	// same number whichever span each line reports.
	Case {
		flags:      "-c with an alternation counts lines and not spans",
		args:       &["-c", "-E", "hit|hit hit", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"5\n",
		stderr:     b"",
		divergence: None,
	},
	// An empty branch matches everywhere and is never the longest, so it changes
	// nothing. It is here because an empty match is the one case the span loop has to
	// step over rather than report.
	Case {
		flags:      "-o with an empty alternative",
		args:       &["-o", "-E", "hit|", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit\nhit\nhit\nhit\nhit\nhit\nhit\n",
		stderr:     b"",
		divergence: None,
	},
	// The start is the first engine's answer and the optional prefix does not move it.
	Case {
		flags:      "-o with a leading optional",
		args:       &["-o", "-E", "x?hit( hit)?", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit hit\nhit\nhit\nhit\nhit\nhit\n",
		stderr:     b"",
		divergence: None,
	},
	// A basic regular expression using a back-reference, which the Rust engine cannot
	// compile and PCRE2 can.
	Case {
		flags:      "-G with a back-reference",
		args:       &["-G", "\\(hit\\) \\1", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit hit hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-P with a lookahead",
		args:       &["-P", "hit(?= hit)", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit hit hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-E with a bounded repeat",
		args:       &["-E", "(hit ?){2}", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit hit hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-F with two patterns on one line",
		args:       &["-F", "-e", "hit hit", "-e", "beta", "a.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"beta\nhit hit\n",
		stderr:     b"",
		divergence: None,
	},
	// Patterns read from a file, one per line.
	Case {
		flags:      "-f pats.list",
		args:       &["-f", "pats.list", "a.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"alpha hit\nbeta\nhit hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-f pats.list -c",
		args:       &["-f", "pats.list", "-c", "a.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"3\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-f - reading patterns from stdin",
		args:       &["-f", "-", "a.txt"],
		stdin:      b"hit\n",
		code:       0,
		stdout:     b"alpha hit\nhit hit\n",
		stderr:     b"",
		divergence: None,
	},
	// An empty pattern under `-o`, where an off-by-one in the empty-match rule shows.
	Case {
		flags:      "-e '' -o",
		args:       &["-e", "", "-o", "a.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"",
		stderr:     b"",
		divergence: None,
	},
	// A pruned directory: only `sub/c.txt` can match, so the walk order cannot change the
	// answer.
	Case {
		flags:      "-r with --exclude-dir",
		args:       &["-r", "--exclude-dir=deep", "hit", "sub"],
		stdin:      b"",
		code:       0,
		stdout:     b"sub/c.txt:deep hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-r --include=e.txt",
		args:       &["-r", "--include=e.txt", "hit", "sub"],
		stdin:      b"",
		code:       0,
		stdout:     b"sub/deep/e.txt:nested hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-r -l --include=e.txt",
		args:       &["-r", "-l", "--include=e.txt", "hit", "sub"],
		stdin:      b"",
		code:       0,
		stdout:     b"sub/deep/e.txt\n",
		stderr:     b"",
		divergence: None,
	},
	// A symlink to a file is followed when it is named, whatever `-r` would do with it.
	Case {
		flags:      "a symlink named on the command line",
		args:       &["hit", "link.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"alpha hit\nhit hit\n",
		stderr:     b"",
		divergence: None,
	},
	// `-r` does not follow a symlinked directory it walked to, but it does follow one it
	// was GIVEN.
	Case {
		flags:      "-r on a symlinked directory",
		args:       &["-r", "--include=c.txt", "hit", "linkdir"],
		stdin:      b"",
		code:       0,
		stdout:     b"linkdir/c.txt:deep hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-R on a symlinked directory",
		args:       &["-R", "--include=c.txt", "hit", "linkdir"],
		stdin:      b"",
		code:       0,
		stdout:     b"linkdir/c.txt:deep hit\n",
		stderr:     b"",
		divergence: None,
	},
	// NUL records: each file is one record, so there is nothing for the context flag to
	// add.
	Case {
		flags:      "-z -A1",
		args:       &["-z", "-A1", "hit", "a.txt", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:alpha hit\nbeta\nhit hit\ngamma\n\x00--\ndup.txt:hit hit hit\nhit\nhit\nhit\nhit\n\x00",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-z -o",
		args:       &["-z", "-o", "hit", "a.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit\x00hit\x00hit\x00",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-z -c",
		args:       &["-z", "-c", "hit", "a.txt", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:1\ndup.txt:1\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--binary-files=without-match -c",
		args:       &["--binary-files=without-match", "-c", "hit", "a.txt", "bin.dat"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:2\nbin.dat:0\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--binary-files=without-match -L",
		args:       &["--binary-files=without-match", "-L", "hit", "a.txt", "bin.dat"],
		stdin:      b"",
		code:       0,
		stdout:     b"bin.dat\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-I -l",
		args:       &["-I", "-l", "hit", "a.txt", "bin.dat"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-a -o bin.dat",
		args:       &["-a", "-o", "hit", "bin.dat"],
		stdin:      b"",
		code:       0,
		stdout:     b"hit\n",
		stderr:     b"",
		divergence: None,
	},
	// A directory read as a file is reported, and the operand after it is still searched.
	Case {
		flags:      "-c a directory and a file",
		args:       &["-c", "hit", "sub", "a.txt"],
		stdin:      b"",
		code:       2,
		stdout:     b"sub:0\na.txt:2\n",
		stderr:     b"grep: sub: Is a directory\n",
		divergence: None,
	},
	// A quiet run that matched nothing and failed exits 2, not 1.
	Case {
		flags:      "-q on an unreadable operand only",
		args:       &["-q", "hit", "missing.txt"],
		stdin:      b"",
		code:       2,
		stdout:     b"",
		stderr:     b"grep: missing.txt: No such file or directory\n",
		divergence: None,
	},
	Case {
		flags:      "-L with a file that matches and one that does not",
		args:       &["-L", "hit", "a.txt", "empty.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"empty.txt\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-l -Z two files",
		args:       &["-l", "-Z", "hit", "a.txt", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt\x00dup.txt\x00",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-c -h two files",
		args:       &["-c", "-h", "hit", "a.txt", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"2\n5\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-n -A1 -B1 two files",
		args:       &["-n", "-A1", "-B1", "hit", "a.txt", "dup.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"a.txt:1:alpha hit\na.txt-2-beta\na.txt:3:hit hit\na.txt-4-gamma\n--\ndup.txt:1:hit hit hit\ndup.txt:2:hit\ndup.txt:3:hit\ndup.txt:4:hit\ndup.txt:5:hit\n",
		stderr:     b"",
		divergence: None,
	},
	// Not a terminal, so `auto` colors nothing.
	Case {
		flags:      "--color=auto",
		args:       &["--color=auto", "hit", "a.txt"],
		stdin:      b"",
		code:       0,
		stdout:     b"alpha hit\nhit hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "stdin -A1",
		args:       &["-A1", "hit"],
		stdin:      b"x\nhit\ny\nz\nhit\nw\n",
		code:       0,
		stdout:     b"hit\ny\n--\nhit\nw\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "stdin -o -b",
		args:       &["-o", "-b", "hit"],
		stdin:      b"one hit\nhit two\n",
		code:       0,
		stdout:     b"4:hit\n8:hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "stdin -m1 -A1",
		args:       &["-m1", "-A1", "hit"],
		stdin:      b"hit\ntail\nhit\n",
		code:       0,
		stdout:     b"hit\ntail\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "stdin -Z -l",
		args:       &["-Z", "-l", "hit"],
		stdin:      b"hit\n",
		code:       0,
		stdout:     b"(standard input)\x00",
		stderr:     b"",
		divergence: None,
	},
	// Standard input has no size, so `-T` aligns to the widest number a file could hold.
	Case {
		flags:      "stdin -T -n",
		args:       &["-T", "-n", "hit"],
		stdin:      b"hit\n",
		code:       0,
		stdout:     b"                  1:\thit\n",
		stderr:     b"",
		divergence: None,
	},
	// A directory GNU opened and read nothing from IS an input that matched nothing, so
	// `-L` lists it.
	Case {
		flags:      "-L a directory and a file",
		args:       &["-L", "hit", "sub", "a.txt"],
		stdin:      b"",
		code:       2,
		stdout:     b"sub\n",
		stderr:     b"grep: sub: Is a directory\n",
		divergence: None,
	},
	// `-l` says nothing about it, for the same reason: it matched nothing.
	Case {
		flags:      "-l a directory and a file",
		args:       &["-l", "hit", "sub", "a.txt"],
		stdin:      b"",
		code:       2,
		stdout:     b"a.txt\n",
		stderr:     b"grep: sub: Is a directory\n",
		divergence: None,
	},
	// The zero count goes through the same printer as every other count, `-Z` included.
	Case {
		flags:      "-c -Z a directory",
		args:       &["-c", "-Z", "hit", "sub", "a.txt"],
		stdin:      b"",
		code:       2,
		stdout:     b"sub\x000\na.txt\x002\n",
		stderr:     b"grep: sub: Is a directory\n",
		divergence: None,
	},
	// `-s` hides the sentence and keeps the count line, which is not a message.
	Case {
		flags:      "-c -s a directory",
		args:       &["-c", "-s", "hit", "sub", "a.txt"],
		stdin:      b"",
		code:       2,
		stdout:     b"sub:0\na.txt:2\n",
		stderr:     b"",
		divergence: None,
	},
	// A missing operand gets NO count line, because nothing ever opened it. This is the
	// pair that fixes the rule to what happened rather than to what failed.
	Case {
		flags:      "-c a missing operand",
		args:       &["-c", "hit", "a.txt", "missing.txt"],
		stdin:      b"",
		code:       2,
		stdout:     b"a.txt:2\n",
		stderr:     b"grep: missing.txt: No such file or directory\n",
		divergence: None,
	},
	// A record mode says nothing about the directory, and the file after it prints
	// normally.
	Case {
		flags:      "-A1 a directory and a file",
		args:       &["-A1", "hit", "sub", "a.txt"],
		stdin:      b"",
		code:       2,
		stdout:     b"a.txt:alpha hit\na.txt-beta\na.txt:hit hit\na.txt-gamma\n",
		stderr:     b"grep: sub: Is a directory\n",
		divergence: None,
	},
];
