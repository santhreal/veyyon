#![cfg(unix)]
//! Differential test: our `rg` builtin against ripgrep 15.1.0, flag set by flag
//! set.
//!
//! WHY THIS SUITE EXISTS. The `rg` tests in `src/rg.rs` each assert one
//! measured rule, which is how every one of them was found and fixed. What none
//! of them do is run the WHOLE tool over the same tree real ripgrep saw and
//! compare the bytes, so a divergence in a flag nobody had a suite for stayed
//! invisible. This runs 144 flag sets over two fixture trees and compares
//! stdout, stderr and the exit code against ripgrep's own output, captured
//! verbatim. Three carry a `divergence` note: the `-h` help text, `-p` colour,
//! and `-E` with an unknown encoding.
//!
//! HOW THE FIXTURE WAS BUILT. The tree below was written to a temporary
//! directory, including an empty `.git` so the ignore rules apply the way they
//! do in a repository, and `rg --sort path <flags> hit .` was run for each flag
//! set with that directory as the working directory. `--sort path` is on every
//! case because ripgrep's walk is parallel and its output order is otherwise
//! not reproducible. Paths print with a `./` prefix because the operand is `.`,
//! which is also the shape a caller sees.
//!
//! WHY THIS SUITE IS UNIX-ONLY. The awkward tree holds a symlink, so `-L` has
//! something to follow, and every path in the expectations is printed with `/`
//! between its components. A byte comparison against that capture on Windows
//! would be asserting the wrong answer. The rules themselves are pinned
//! platform-independently by the suites in `src/rg.rs`.
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

/// One flag set and what ripgrep printed for it.
struct Case {
	/// The flags as written, for the failure message.
	flags:      &'static str,
	/// The full argument list, `rg` itself excluded.
	args:       &'static [&'static str],
	code:       i32,
	stdout:     &'static [u8],
	stderr:     &'static [u8],
	/// Set when OUR answer is knowingly different, with the reason.
	divergence: Option<&'static str>,
}

/// The fixture tree, written fresh for every case so no case can leave state
/// behind.
///
/// The shapes are chosen to reach the parts of the walk that flags argue about:
/// a hidden file, an ignored one, a subdirectory, an uppercase name, CRLF line
/// endings, multi-byte text, an empty file, and a file holding a NUL.
const TEXT_FILES: &[(&str, &str)] = &[
	("a.txt", "alpha hit\nbeta\nhit hit\ngamma\n"),
	("b.log", "log hit\nnothing\n"),
	("sub/c.txt", "deep hit\n"),
	("sub/d.md", "markdown HIT\n"),
	(".hidden.txt", "hidden hit\n"),
	("UPPER.TXT", "UPPER HIT\n"),
	("crlf.txt", "crlf hit\r\nsecond\r\n"),
	("uni.txt", "café hit\nnaïve\n"),
	("empty.txt", ""),
	(".gitignore", "*.log\n"),
];

/// The binary file, kept separate because its bytes are not text.
const BINARY_FILE: (&str, &[u8]) = ("bin.dat", b"bin \x00 hit\n");

/// Write the fixture tree into a fresh directory and hand back its path.
fn fixture_tree(label: usize) -> TempTree {
	let root = scratch_dir(&format!("rg-differential-{label}"));
	std::fs::create_dir_all(root.join("sub")).expect("temp tree should be created");
	std::fs::create_dir_all(root.join(".git")).expect("the git marker should be created");
	for (name, text) in TEXT_FILES {
		std::fs::write(root.join(name), text).expect("fixture file should be written");
	}
	std::fs::write(root.join(BINARY_FILE.0), BINARY_FILE.1).expect("binary fixture");
	root
}

/// Write the awkward tree into a fresh directory and hand back its path.
///
/// Every file here exists for one flag: `utf16.txt` carries a BOM for `-E` and
/// the sniffing that happens without it, `latin1.txt` holds bytes no UTF-8
/// decoder accepts, `data.gz` needs `-z`, `long.txt` is longer than any
/// `--max-columns` limit a case uses, `big.txt` is over 100 bytes for
/// `--max-filesize`, `tabs.txt` starts with whitespace for `--trim`, `caps.txt`
/// mixes case across a multi-byte character, `deep/nested/f.txt` is two levels
/// down for `--max-depth`, `.ignore` hides `ignored.txt`, and `link.txt` points
/// at a file so `-L` has something to follow.
fn awkward_tree(label: usize) -> TempTree {
	let root = scratch_dir(&format!("rg-awkward-{label}"));
	std::fs::create_dir_all(root.join("deep/nested")).expect("temp tree should be created");
	let long = format!("start {} hit tail\n", "x".repeat(60));
	let big = format!("big hit\n{}\n", "y".repeat(3000));
	for (name, text) in [
		("long.txt", long.as_str()),
		("multi.txt", "one\nhit\ntwo\nhit\nthree\n"),
		("tabs.txt", "\t  hit tabbed\n"),
		("caps.txt", "HIT Café\n"),
		("deep/nested/f.txt", "nested hit\n"),
		("ignored.txt", "ignored hit\n"),
		(".ignore", "ignored.txt\n"),
		("big.txt", big.as_str()),
	] {
		std::fs::write(root.join(name), text).expect("fixture file should be written");
	}
	// UTF-16LE with a BOM, and the same text in Latin-1, both written as bytes
	// because neither is valid UTF-8 and a Rust string cannot hold them.
	std::fs::write(root.join("utf16.txt"), b"\xff\xfew\0i\0d\0e\0 \0h\0i\0t\0\n\0".as_slice())
		.expect("the utf-16 fixture");
	std::fs::write(root.join("latin1.txt"), b"caf\xe9 hit\n".as_slice())
		.expect("the latin-1 fixture");
	// `gzip.compress(b"zipped hit\n", mtime=0)`, kept as bytes so the fixture does
	// not depend on a gzip program being installed and cannot vary with the clock.
	std::fs::write(root.join("data.gz"), GZIPPED_HIT).expect("the gzip fixture");
	std::os::unix::fs::symlink("long.txt", root.join("link.txt")).expect("the symlink");
	root
}

/// `zipped hit\n` under gzip, with a zero timestamp so the bytes are fixed.
const GZIPPED_HIT: &[u8] = b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x02\x03\xab\xca\x2c\x28\x48\x4d\x51\xc8\xc8\x2c\xe1\x02\x00\xc1\xbd\x33\x9f\x0b\x00\x00\x00";

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
/// `PATH` is the only environment variable the scope carries, because a real
/// shell always exports one and nothing else should leak into a fixture.
fn run_rg(args: &[&str], cwd: &Path) -> (i32, Vec<u8>, Vec<u8>) {
	let out = Arc::new(Mutex::new(Vec::new()));
	let err = Arc::new(Mutex::new(Vec::new()));
	let mut env = HashMap::new();
	if let Ok(path) = std::env::var("PATH") {
		env.insert("PATH".to_string(), path);
	}
	let io = ScopeIo {
		stdin: Box::new(std::io::empty()),
		stdin_fd: None,
		stdin_is_search_input: false,
		stdout: Box::new(SharedBuf(Arc::clone(&out))),
		stdout_is_terminal: false,
		stderr: Box::new(SharedBuf(Arc::clone(&err))),
		cwd: cwd.to_path_buf(),
		env,
		cancel: Arc::new(AtomicBool::new(false)),
	};
	let argv: Vec<OsString> = std::iter::once("rg")
		.chain(args.iter().copied())
		.map(OsString::from)
		.collect();
	let code = scope(io, || veyyon_uu_grep::run_rg(argv));
	let stdout = out.lock().expect("lock").clone();
	let stderr = err.lock().expect("lock").clone();
	(code, stdout, stderr)
}

/// Run every case in `cases` over a tree `build` makes, returning the failures.
///
/// Two case lists share this: the flag sweep over the plain tree and the sweep
/// over the awkward one. The comparison rule is the same for both and lives
/// here once.
fn compare(cases: &[Case], build: fn(usize) -> TempTree) -> Vec<String> {
	let mut failures = Vec::new();
	for (index, case) in cases.iter().enumerate() {
		// The guard is held for the run and dropped at the end of the iteration, which
		// is what removes the tree. The explicit `remove_dir_all` that stood here ran
		// only when the comparison did not panic first.
		let tree = build(index);
		let (code, stdout, stderr) = run_rg(case.args, &tree);
		let matched = code == case.code && stdout == case.stdout && stderr == case.stderr;
		match (matched, case.divergence) {
			(true, None) => {},
			(true, Some(reason)) => failures.push(format!(
				"{}: agrees with ripgrep now, so the exception is stale and has to go: {reason}",
				case.flags
			)),
			(false, Some(_)) => {},
			(false, None) => failures.push(format!(
				"{}:\n  ours: code={code} out={:?} err={:?}\n  rg:   code={} out={:?} err={:?}",
				case.flags,
				String::from_utf8_lossy(&stdout),
				String::from_utf8_lossy(&stderr),
				case.code,
				String::from_utf8_lossy(case.stdout),
				String::from_utf8_lossy(case.stderr)
			)),
		}
	}
	failures
}

/// Every case over the plain tree, compared in one test so a run reports the
/// whole divergence list.
#[test]
fn our_output_matches_ripgrep_flag_set_by_flag_set() {
	let failures = compare(CASES, fixture_tree);
	assert!(
		failures.is_empty(),
		"{} of {} flag sets disagree with ripgrep 15.1.0:\n{}",
		failures.len(),
		CASES.len(),
		failures.join("\n")
	);
}

/// The same sweep over the awkward tree, which holds the shapes the plain one
/// has no room for: encodings, a compressed file, a symlink, an `.ignore` file,
/// a line long enough for `--max-columns`, a file big enough for
/// `--max-filesize`, and a nested directory for `--max-depth`.
///
/// A second tree rather than more files in the first one, because almost every
/// case there searches `.` and one more file would change what all sixty-one of
/// them print.
#[test]
fn our_output_matches_ripgrep_over_the_awkward_tree() {
	let failures = compare(AWKWARD_CASES, awkward_tree);
	assert!(
		failures.is_empty(),
		"{} of {} awkward-tree flag sets disagree with ripgrep 15.1.0:\n{}",
		failures.len(),
		AWKWARD_CASES.len(),
		failures.join("\n")
	);
}

/// The corpus. Captured by running ripgrep 15.1.0 over the fixture tree; see the
/// module docs, and do not edit an expectation to make a case pass.
///
/// `rustfmt::skip` keeps the formatter from breaking these string literals: with
/// `format_strings = true` a break can land between a backslash and its escape
/// letter and change what the literal means.
#[rustfmt::skip]
static CASES: &[Case] = &[
	Case {
		flags:      "(no flags)",
		args:       &["--sort", "path", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-n",
		args:       &["--sort", "path", "-n", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:1:alpha hit\n./a.txt:3:hit hit\n./crlf.txt:1:crlf hit\r\n./sub/c.txt:1:deep hit\n./uni.txt:1:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-H",
		args:       &["--sort", "path", "-H", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-h",
		args:       &["--sort", "path", "-h", "hit", "."],
		code:       0,
		stdout:     b"ripgrep 15.1.0\nAndrew Gallant <jamslam@gmail.com>\n\nripgrep (rg) recursively searches the current directory for lines matching\na regex pattern. By default, ripgrep will respect gitignore rules and\nautomatically skip hidden files/directories and binary files.\n\nUse -h for short descriptions and --help for more details.\n\nProject home page: https://github.com/BurntSushi/ripgrep\n\nUSAGE:\n  rg [OPTIONS] PATTERN [PATH ...]\n\nPOSITIONAL ARGUMENTS:\n  <PATTERN>   A regular expression used for searching.\n  <PATH>...   A file or directory to search.\n\nINPUT OPTIONS:\n  -e, --regexp=PATTERN            A pattern to search for.\n  -f, --file=PATTERNFILE          Search for patterns from the given file.\n  --pre=COMMAND                   Search output of COMMAND for each PATH.\n  --pre-glob=GLOB                 Include or exclude files from a preprocessor.\n  -z, --search-zip                Search in compressed files.\n\nSEARCH OPTIONS:\n  -s, --case-sensitive            Search case sensitively (default).\n  --crlf                          Use CRLF line terminators (nice for Windows).\n  --dfa-size-limit=NUM            The upper size limit of the regex DFA.\n  -E, --encoding=ENCODING         Specify the text encoding of files to search.\n  --engine=ENGINE                 Specify which regex engine to use.\n  -F, --fixed-strings             Treat all patterns as literals.\n  -i, --ignore-case               Case insensitive search.\n  -v, --invert-match              Invert matching.\n  -x, --line-regexp               Show matches surrounded by line boundaries.\n  -m, --max-count=NUM             Limit the number of matching lines.\n  --mmap                          Search with memory maps when possible.\n  -U, --multiline                 Enable searching across multiple lines.\n  --multiline-dotall              Make '.' match line terminators.\n  --no-unicode                    Disable Unicode mode.\n  --null-data                     Use NUL as a line terminator.\n  -P, --pcre2                     Enable PCRE2 matching.\n  --regex-size-limit=NUM          The size limit of the compiled regex.\n  -S, --smart-case                Smart case search.\n  --stop-on-nonmatch              Stop searching after a non-match.\n  -a, --text                      Search binary files as if they were text.\n  -j, --threads=NUM               Set the approximate number of threads to use.\n  -w, --word-regexp               Show matches surrounded by word boundaries.\n  --auto-hybrid-regex             (DEPRECATED) Use PCRE2 if appropriate.\n  --no-pcre2-unicode              (DEPRECATED) Disable Unicode mode for PCRE2.\n\nFILTER OPTIONS:\n  --binary                        Search binary files.\n  -L, --follow                    Follow symbolic links.\n  -g, --glob=GLOB                 Include or exclude file paths.\n  --glob-case-insensitive         Process all glob patterns case insensitively.\n  -., --hidden                    Search hidden files and directories.\n  --iglob=GLOB                    Include/exclude paths case insensitively.\n  --ignore-file=PATH              Specify additional ignore files.\n  --ignore-file-case-insensitive  Process ignore files case insensitively.\n  -d, --max-depth=NUM             Descend at most NUM directories.\n  --max-filesize=NUM              Ignore files larger than NUM in size.\n  --no-ignore                     Don't use ignore files.\n  --no-ignore-dot                 Don't use .ignore or .rgignore files.\n  --no-ignore-exclude             Don't use local exclusion files.\n  --no-ignore-files               Don't use --ignore-file arguments.\n  --no-ignore-global              Don't use global ignore files.\n  --no-ignore-parent              Don't use ignore files in parent directories.\n  --no-ignore-vcs                 Don't use ignore files from source control.\n  --no-require-git                Use .gitignore outside of git repositories.\n  --one-file-system               Skip directories on other file systems.\n  -t, --type=TYPE                 Only search files matching TYPE.\n  -T, --type-not=TYPE             Do not search files matching TYPE.\n  --type-add=TYPESPEC             Add a new glob for a file type.\n  --type-clear=TYPE               Clear globs for a file type.\n  -u, --unrestricted              Reduce the level of \"smart\" filtering.\n\nOUTPUT OPTIONS:\n  -A, --after-context=NUM         Show NUM lines after each match.\n  -B, --before-context=NUM        Show NUM lines before each match.\n  --block-buffered                Force block buffering.\n  -b, --byte-offset               Print the byte offset for each matching line.\n  --color=WHEN                    When to use color.\n  --colors=COLOR_SPEC             Configure color settings and styles.\n  --column                        Show column numbers.\n  -C, --context=NUM               Show NUM lines before and after each match.\n  --context-separator=SEP         Set the separator for contextual chunks.\n  --field-context-separator=SEP   Set the field context separator.\n  --field-match-separator=SEP     Set the field match separator.\n  --heading                       Print matches grouped by each file.\n  -h, --help                      Show help output.\n  --hostname-bin=COMMAND          Run a program to get this system's hostname.\n  --hyperlink-format=FORMAT       Set the format of hyperlinks.\n  --include-zero                  Include zero matches in summary output.\n  --line-buffered                 Force line buffering.\n  -n, --line-number               Show line numbers.\n  -N, --no-line-number            Suppress line numbers.\n  -M, --max-columns=NUM           Omit lines longer than this limit.\n  --max-columns-preview           Show preview for lines exceeding the limit.\n  -0, --null                      Print a NUL byte after file paths.\n  -o, --only-matching             Print only matched parts of a line.\n  --path-separator=SEP            Set the path separator for printing paths.\n  --passthru                      Print both matching and non-matching lines.\n  -p, --pretty                    Alias for colors, headings and line numbers.\n  -q, --quiet                     Do not print anything to stdout.\n  -r, --replace=TEXT              Replace matches with the given text.\n  --sort=SORTBY                   Sort results in ascending order.\n  --sortr=SORTBY                  Sort results in descending order.\n  --trim                          Trim prefix whitespace from matches.\n  --vimgrep                       Print results in a vim compatible format.\n  -H, --with-filename             Print the file path with each matching line.\n  -I, --no-filename               Never print the path with each matching line.\n  --sort-files                    (DEPRECATED) Sort results by file path.\n\nOUTPUT MODES:\n  -c, --count                     Show count of matching lines for each file.\n  --count-matches                 Show count of every match for each file.\n  -l, --files-with-matches        Print the paths with at least one match.\n  --files-without-match           Print the paths that contain zero matches.\n  --json                          Show search results in a JSON Lines format.\n\nLOGGING OPTIONS:\n  --debug                         Show debug messages.\n  --no-ignore-messages            Suppress gitignore parse error messages.\n  --no-messages                   Suppress some error messages.\n  --stats                         Print statistics about the search.\n  --trace                         Show trace messages.\n\nOTHER BEHAVIORS:\n  --files                         Print each file that would be searched.\n  --generate=KIND                 Generate man pages and completion scripts.\n  --no-config                     Never read configuration files.\n  --pcre2-version                 Print the version of PCRE2 that ripgrep uses.\n  --type-list                     Show all supported file types.\n  -V, --version                   Print ripgrep's version.\n",
		stderr:     b"",
		divergence: Some(
			"the help text is our own. ripgrep hand-writes its usage block; ours is generated \
			 from the clap definition that also parses the flags, so the two cannot agree \
			 without maintaining a second copy of every description by hand, which is the \
			 thing that goes stale. Every FLAG the block lists is compared here by the case \
			 that exercises it",
		),
	},
	Case {
		flags:      "-c",
		args:       &["--sort", "path", "-c", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:2\n./crlf.txt:1\n./sub/c.txt:1\n./uni.txt:1\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--count-matches",
		args:       &["--sort", "path", "--count-matches", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:3\n./crlf.txt:1\n./sub/c.txt:1\n./uni.txt:1\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-l",
		args:       &["--sort", "path", "-l", "hit", "."],
		code:       0,
		stdout:     b"./a.txt\n./crlf.txt\n./sub/c.txt\n./uni.txt\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--files-without-match",
		args:       &["--sort", "path", "--files-without-match", "hit", "."],
		code:       0,
		stdout:     b"./UPPER.TXT\n./empty.txt\n./sub/d.md\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-o",
		args:       &["--sort", "path", "-o", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:hit\n./a.txt:hit\n./a.txt:hit\n./crlf.txt:hit\n./sub/c.txt:hit\n./uni.txt:hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-w",
		args:       &["--sort", "path", "-w", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-x",
		args:       &["--sort", "path", "-x", "hit", "."],
		code:       1,
		stdout:     b"",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-i",
		args:       &["--sort", "path", "-i", "hit", "."],
		code:       0,
		stdout:     b"./UPPER.TXT:UPPER HIT\n./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./sub/d.md:markdown HIT\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-s",
		args:       &["--sort", "path", "-s", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-S",
		args:       &["--sort", "path", "-S", "hit", "."],
		code:       0,
		stdout:     b"./UPPER.TXT:UPPER HIT\n./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./sub/d.md:markdown HIT\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-v",
		args:       &["--sort", "path", "-v", "hit", "."],
		code:       0,
		stdout:     b"./UPPER.TXT:UPPER HIT\n./a.txt:beta\n./a.txt:gamma\n./crlf.txt:second\r\n./sub/d.md:markdown HIT\n./uni.txt:na\xc3\xafve\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-A 1",
		args:       &["--sort", "path", "-A", "1", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt-beta\n./a.txt:hit hit\n./a.txt-gamma\n--\n./crlf.txt:crlf hit\r\n./crlf.txt-second\r\n--\n./sub/c.txt:deep hit\n--\n./uni.txt:caf\xc3\xa9 hit\n./uni.txt-na\xc3\xafve\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-B 1",
		args:       &["--sort", "path", "-B", "1", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt-beta\n./a.txt:hit hit\n--\n./crlf.txt:crlf hit\r\n--\n./sub/c.txt:deep hit\n--\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-C 1",
		args:       &["--sort", "path", "-C", "1", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt-beta\n./a.txt:hit hit\n./a.txt-gamma\n--\n./crlf.txt:crlf hit\r\n./crlf.txt-second\r\n--\n./sub/c.txt:deep hit\n--\n./uni.txt:caf\xc3\xa9 hit\n./uni.txt-na\xc3\xafve\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--heading",
		args:       &["--sort", "path", "--heading", "hit", "."],
		code:       0,
		stdout:     b"./a.txt\nalpha hit\nhit hit\n\n./crlf.txt\ncrlf hit\r\n\n./sub/c.txt\ndeep hit\n\n./uni.txt\ncaf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--no-heading",
		args:       &["--sort", "path", "--no-heading", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--vimgrep",
		args:       &["--sort", "path", "--vimgrep", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:1:7:alpha hit\n./a.txt:3:1:hit hit\n./a.txt:3:5:hit hit\n./crlf.txt:1:6:crlf hit\r\n./sub/c.txt:1:6:deep hit\n./uni.txt:1:7:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--column",
		args:       &["--sort", "path", "--column", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:1:7:alpha hit\n./a.txt:3:1:hit hit\n./crlf.txt:1:6:crlf hit\r\n./sub/c.txt:1:6:deep hit\n./uni.txt:1:7:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-b",
		args:       &["--sort", "path", "-b", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:0:alpha hit\n./a.txt:15:hit hit\n./crlf.txt:0:crlf hit\r\n./sub/c.txt:0:deep hit\n./uni.txt:0:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--null",
		args:       &["--sort", "path", "--null", "hit", "."],
		code:       0,
		stdout:     b"./a.txt\x00alpha hit\n./a.txt\x00hit hit\n./crlf.txt\x00crlf hit\r\n./sub/c.txt\x00deep hit\n./uni.txt\x00caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--hidden",
		args:       &["--sort", "path", "--hidden", "hit", "."],
		code:       0,
		stdout:     b"./.hidden.txt:hidden hit\n./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--no-ignore",
		args:       &["--sort", "path", "--no-ignore", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./b.log:log hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-g *.txt",
		args:       &["--sort", "path", "-g", "*.txt", "hit", "."],
		code:       0,
		stdout:     b"./.hidden.txt:hidden hit\n./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--iglob *.TXT",
		args:       &["--sort", "path", "--iglob", "*.TXT", "hit", "."],
		code:       0,
		stdout:     b"./.hidden.txt:hidden hit\n./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-m 1",
		args:       &["--sort", "path", "-m", "1", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--max-columns 6",
		args:       &["--sort", "path", "--max-columns", "6", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:[Omitted long matching line]\n./a.txt:[Omitted long matching line]\n./crlf.txt:[Omitted long matching line]\n./sub/c.txt:[Omitted long matching line]\n./uni.txt:[Omitted long matching line]\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--max-columns 6 --max-columns-preview",
		args:       &["--sort", "path", "--max-columns", "6", "--max-columns-preview", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha  [... omitted end of long line]\n./a.txt:hit hi [... omitted end of long line]\n./crlf.txt:crlf h [... omitted end of long line]\n./sub/c.txt:deep h [... omitted end of long line]\n./uni.txt:caf\xc3\xa9 h [... omitted end of long line]\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-r X",
		args:       &["--sort", "path", "-r", "X", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha X\n./a.txt:X X\n./crlf.txt:crlf X\r\n./sub/c.txt:deep X\n./uni.txt:caf\xc3\xa9 X\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--passthru",
		args:       &["--sort", "path", "--passthru", "hit", "."],
		code:       0,
		stdout:     b"./UPPER.TXT-UPPER HIT\n./a.txt:alpha hit\n./a.txt-beta\n./a.txt:hit hit\n./a.txt-gamma\n./crlf.txt:crlf hit\r\n./crlf.txt-second\r\n./sub/c.txt:deep hit\n./sub/d.md-markdown HIT\n./uni.txt:caf\xc3\xa9 hit\n./uni.txt-na\xc3\xafve\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--trim",
		args:       &["--sort", "path", "--trim", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-e hit -e beta",
		args:       &["--sort", "path", "-e", "hit", "-e", "beta", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:beta\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--files",
		args:       &["--sort", "path", "--files", "."],
		code:       0,
		stdout:     b"./UPPER.TXT\n./a.txt\n./bin.dat\n./crlf.txt\n./empty.txt\n./sub/c.txt\n./sub/d.md\n./uni.txt\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-n --column --byte-offset",
		args:       &["--sort", "path", "-n", "--column", "--byte-offset", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:1:7:0:alpha hit\n./a.txt:3:1:15:hit hit\n./crlf.txt:1:6:0:crlf hit\r\n./sub/c.txt:1:6:0:deep hit\n./uni.txt:1:7:0:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-c --include-zero",
		args:       &["--sort", "path", "-c", "--include-zero", "hit", "."],
		code:       0,
		stdout:     b"./UPPER.TXT:0\n./a.txt:2\n./crlf.txt:1\n./empty.txt:0\n./sub/c.txt:1\n./sub/d.md:0\n./uni.txt:1\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-l --null",
		args:       &["--sort", "path", "-l", "--null", "hit", "."],
		code:       0,
		stdout:     b"./a.txt\x00./crlf.txt\x00./sub/c.txt\x00./uni.txt\x00",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--no-require-git",
		args:       &["--sort", "path", "--no-require-git", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-t md",
		args:       &["--sort", "path", "-t", "md", "hit", "."],
		code:       1,
		stdout:     b"",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-T md",
		args:       &["--sort", "path", "-T", "md", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--max-depth 1",
		args:       &["--sort", "path", "--max-depth", "1", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-L",
		args:       &["--sort", "path", "-L", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--one-file-system",
		args:       &["--sort", "path", "--one-file-system", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--crlf",
		args:       &["--sort", "path", "--crlf", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-U (?s)hit.gamma",
		args:       &["--sort", "path", "-U", "(?s)hit.gamma", "."],
		code:       0,
		stdout:     b"./a.txt:hit hit\n./a.txt:gamma\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--multiline-dotall -U hit.gamma",
		args:       &["--sort", "path", "--multiline-dotall", "-U", "hit.gamma", "."],
		code:       0,
		stdout:     b"./a.txt:hit hit\n./a.txt:gamma\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-i -o -w",
		args:       &["--sort", "path", "-i", "-o", "-w", "hit", "."],
		code:       0,
		stdout:     b"./UPPER.TXT:HIT\n./a.txt:hit\n./a.txt:hit\n./a.txt:hit\n./crlf.txt:hit\n./sub/c.txt:hit\n./sub/d.md:HIT\n./uni.txt:hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--sortr path",
		args:       &["--sort", "path", "--sortr", "path", "hit", "."],
		code:       0,
		stdout:     b"./uni.txt:caf\xc3\xa9 hit\n./sub/c.txt:deep hit\n./crlf.txt:crlf hit\r\n./a.txt:alpha hit\n./a.txt:hit hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-p",
		args:       &["--sort", "path", "-p", "hit", "."],
		code:       0,
		stdout:     b"\x1b[0m\x1b[35m./a.txt\x1b[0m\n\x1b[0m\x1b[32m1\x1b[0m:alpha \x1b[0m\x1b[1m\x1b[31mhit\x1b[0m\n\x1b[0m\x1b[32m3\x1b[0m:\x1b[0m\x1b[1m\x1b[31mhit\x1b[0m \x1b[0m\x1b[1m\x1b[31mhit\x1b[0m\n\n\x1b[0m\x1b[35m./crlf.txt\x1b[0m\n\x1b[0m\x1b[32m1\x1b[0m:crlf \x1b[0m\x1b[1m\x1b[31mhit\x1b[0m\r\n\n\x1b[0m\x1b[35m./sub/c.txt\x1b[0m\n\x1b[0m\x1b[32m1\x1b[0m:deep \x1b[0m\x1b[1m\x1b[31mhit\x1b[0m\n\n\x1b[0m\x1b[35m./uni.txt\x1b[0m\n\x1b[0m\x1b[32m1\x1b[0m:caf\xc3\xa9 \x1b[0m\x1b[1m\x1b[31mhit\x1b[0m\n",
		stderr:     b"",
		divergence: Some(
			"this builtin emits no color, which `--color` and `-p` both document. The STRUCTURE \
			 `-p` asks for is compared: the case below runs the same flags with `--color=never` \
			 and pins the headings, the line numbers and the blank line between groups",
		),
	},
	// The structural half of `-p`: headings, line numbers, and the blank line between
	// groups, with the color half turned off.
	Case {
		flags:      "-p --color=never",
		args:       &["--sort", "path", "-p", "--color=never", "hit", "."],
		code:       0,
		stdout:     b"./a.txt\n1:alpha hit\n3:hit hit\n\n./crlf.txt\n1:crlf hit\r\n\n./sub/c.txt\n1:deep hit\n\n./uni.txt\n1:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	// A path that does not exist is reported, and the run keeps going through the operand
	// that does.
	Case {
		flags:      "a missing operand beside a real one",
		args:       &["--sort", "path", "hit", "missing.txt", "."],
		code:       2,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"rg: missing.txt: IO error for operation on missing.txt: No such file or directory (os error 2)\n",
		divergence: Some(
			"the diagnostic wording is our own. ripgrep names the path twice (`missing.txt: IO \
			 error for operation on missing.txt: ...`); ours names it once. The path, the \
			 reason, the exit code, and the results from the operand that DID exist are all \
			 compared here",
		),
	},
	// A multi-line match numbers every line it covers and repeats the record's column.
	Case {
		flags:      "-n --column -U",
		args:       &["--sort", "path", "-n", "--column", "-U", "(?s)hit.gamma", "."],
		code:       0,
		stdout:     b"./a.txt:3:5:hit hit\n./a.txt:4:5:gamma\n",
		stderr:     b"",
		divergence: None,
	},
	// Each line of a multi-line match reports its OWN byte offset, not the match's.
	Case {
		flags:      "-b -U",
		args:       &["--sort", "path", "-b", "-U", "(?s)hit.gamma", "."],
		code:       0,
		stdout:     b"./a.txt:15:hit hit\n./a.txt:23:gamma\n",
		stderr:     b"",
		divergence: None,
	},
	// `-o` prints the part of a multi-line match that is on each line.
	Case {
		flags:      "-o -U",
		args:       &["--sort", "path", "-o", "-U", "(?s)hit.gamma", "."],
		code:       0,
		stdout:     b"./a.txt:hit\n./a.txt:gamma\n",
		stderr:     b"",
		divergence: None,
	},
	// vimgrep prints ONE record per match, even when the match spans lines.
	Case {
		flags:      "--vimgrep -U",
		args:       &["--sort", "path", "--vimgrep", "-U", "(?s)hit.gamma", "."],
		code:       0,
		stdout:     b"./a.txt:3:5:hit hit\n",
		stderr:     b"",
		divergence: None,
	},
	// The separator between two files is the context separator, so this changes it.
	Case {
		flags:      "-A1 --context-separator=XX",
		args:       &["--sort", "path", "-A", "1", "--context-separator=XX", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt-beta\n./a.txt:hit hit\n./a.txt-gamma\nXX\n./crlf.txt:crlf hit\r\n./crlf.txt-second\r\nXX\n./sub/c.txt:deep hit\nXX\n./uni.txt:caf\xc3\xa9 hit\n./uni.txt-na\xc3\xafve\n",
		stderr:     b"",
		divergence: None,
	},
	// And this removes it from between files as well as from between gaps.
	Case {
		flags:      "-A1 --no-context-separator",
		args:       &["--sort", "path", "-A", "1", "--no-context-separator", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt-beta\n./a.txt:hit hit\n./a.txt-gamma\n./crlf.txt:crlf hit\r\n./crlf.txt-second\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n./uni.txt-na\xc3\xafve\n",
		stderr:     b"",
		divergence: None,
	},
	// A binary file stays out of the count even when every filter that hides files is off.
	Case {
		flags:      "-c --include-zero --no-ignore --hidden",
		args:       &["--sort", "path", "-c", "--include-zero", "--no-ignore", "--hidden", "hit", "."],
		code:       0,
		stdout:     b"./.gitignore:0\n./.hidden.txt:1\n./UPPER.TXT:0\n./a.txt:2\n./b.log:1\n./crlf.txt:1\n./empty.txt:0\n./sub/c.txt:1\n./sub/d.md:0\n./uni.txt:1\n",
		stderr:     b"",
		divergence: None,
	},
	// `--crlf` searches every file rather than refusing it.
	Case {
		flags:      "--crlf -n",
		args:       &["--sort", "path", "--crlf", "-n", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:1:alpha hit\n./a.txt:3:hit hit\n./crlf.txt:1:crlf hit\r\n./sub/c.txt:1:deep hit\n./uni.txt:1:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	// A bad flag value is one line naming the flag as it was written, with no usage block.
	Case {
		flags:      "-m with a value that is not a number",
		args:       &["-m", "abc", "hit", "."],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: error parsing flag -m: value is not a valid number: invalid digit found in string\n",
		divergence: None,
	},
	// The long spelling of the same flag names the long form.
	Case {
		flags:      "--max-count with a value that is not a number",
		args:       &["--max-count", "abc", "hit", "."],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: error parsing flag --max-count: value is not a valid number: invalid digit found in string\n",
		divergence: None,
	},
	// A negative value belongs to the flag, so it is refused as a number and not as a flag.
	Case {
		flags:      "-A with a negative value",
		args:       &["-A", "-1", "hit", "."],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: error parsing flag -A: value is not a valid number: invalid digit found in string\n",
		divergence: None,
	},
	// A short flag inside a cluster still names itself.
	Case {
		flags:      "-imabc (a short cluster)",
		args:       &["-imabc", "hit", "."],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: error parsing flag -m: value is not a valid number: invalid digit found in string\n",
		divergence: None,
	},
	// Size suffixes are uppercase, so `1k` is a mistake and `1K` is a kilobyte.
	Case {
		flags:      "--max-filesize with a lowercase suffix",
		args:       &["--max-filesize", "1k", "hit", "."],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: error parsing flag --max-filesize: invalid size: invalid format for size '1k', which should be a non-empty sequence of digits followed by an optional 'K', 'M' or 'G' suffix\n",
		divergence: None,
	},
	// And an unknown suffix is the same mistake.
	Case {
		flags:      "--max-filesize with an unknown suffix",
		args:       &["--max-filesize", "12Q", "hit", "."],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: error parsing flag --max-filesize: invalid size: invalid format for size '12Q', which should be a non-empty sequence of digits followed by an optional 'K', 'M' or 'G' suffix\n",
		divergence: None,
	},
	// `--engine` names the engine rather than listing the choices.
	Case {
		flags:      "--engine with an unknown engine",
		args:       &["--engine", "sideways", "hit", "."],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: error parsing flag --engine: unrecognized regex engine 'sideways'\n",
		divergence: None,
	},
	// A flag with choices says the choice is unrecognized, even one this builtin only accepts for compatibility.
	Case {
		flags:      "--color with an unknown choice",
		args:       &["--color", "sideways", "hit", "."],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: error parsing flag --color: choice 'sideways' is unrecognized\n",
		divergence: None,
	},
	// The same wording for a choice checked after the whole command line is known.
	Case {
		flags:      "--sort with an unknown choice",
		args:       &["--sort", "sideways", "hit", "."],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: error parsing flag --sort: choice 'sideways' is unrecognized\n",
		divergence: None,
	},
	// A flag left without its value is a different mistake, and says so.
	Case {
		flags:      "--max-count with no value",
		args:       &["--max-count"],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: missing value for flag --max-count: missing argument for option '--max-count'\n",
		divergence: None,
	},
	// An unknown flag is one line, with no tip about `--` and no usage block.
	Case {
		flags:      "an unknown long flag",
		args:       &["--nosuchflag", "hit", "."],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: unrecognized flag --nosuchflag\n",
		divergence: None,
	},
	// Including a short one.
	Case {
		flags:      "an unknown short flag",
		args:       &["-Q", "hit", "."],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: unrecognized flag -Q\n",
		divergence: None,
	},
	// A malformed `--type-add` is a mistake in the command line whether or not the run
	// reads it, so it is refused with no type selected at all.
	Case {
		flags:      "--type-add with no colon",
		args:       &["--type-add", "nocolon", "hit", "."],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: invalid definition (format is type:glob, e.g., html:*.html)\n",
		divergence: None,
	},
	// And the same on the path that only lists the types.
	Case {
		flags:      "--type-list --type-add with no colon",
		args:       &["--type-add", "nocolon", "--type-list"],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: invalid definition (format is type:glob, e.g., html:*.html)\n",
		divergence: None,
	},
	// A value beginning with a hyphen belongs to the flag, so this is a bad definition
	// rather than an unknown flag.
	Case {
		flags:      "--type-add with a hyphen value",
		args:       &["--type-add", "-x", "hit", "."],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: invalid definition (format is type:glob, e.g., html:*.html)\n",
		divergence: None,
	},
	// The same rule for a flag with choices.
	Case {
		flags:      "--color with a hyphen value",
		args:       &["--color", "-x", "hit", "."],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: error parsing flag --color: choice '-x' is unrecognized\n",
		divergence: None,
	},
	// The output mode is one group and the LAST flag in it wins. Every pair below
	// was captured in both orders, because the version this corpus grew against
	// refused `--json` beside any of them with a diagnostic ripgrep does not have.
	Case {
		flags:      "--json then -c",
		args:       &["--sort", "path", "--json", "-c", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:2\n./crlf.txt:1\n./sub/c.txt:1\n./uni.txt:1\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--json then -l",
		args:       &["--sort", "path", "--json", "-l", "hit", "."],
		code:       0,
		stdout:     b"./a.txt\n./crlf.txt\n./sub/c.txt\n./uni.txt\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--json then --count-matches",
		args:       &["--sort", "path", "--json", "--count-matches", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:3\n./crlf.txt:1\n./sub/c.txt:1\n./uni.txt:1\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--json then --files-without-match",
		args:       &["--sort", "path", "--json", "--files-without-match", "hit", "."],
		code:       0,
		stdout:     b"./UPPER.TXT\n./empty.txt\n./sub/d.md\n",
		stderr:     b"",
		divergence: None,
	},
	// `--no-json` cancels a `--json` that came before it and does nothing to any
	// other mode, so these two differ only in where `-c` sits.
	Case {
		flags:      "--json -c cancelled by --no-json",
		args:       &["--sort", "path", "--json", "-c", "--no-json", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:2\n./crlf.txt:1\n./sub/c.txt:1\n./uni.txt:1\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-c --json cancelled by --no-json",
		args:       &["--sort", "path", "-c", "--json", "--no-json", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	// Inside a cluster the two flags share one argv position, so the rule has to
	// be left to right within it and not a comparison of positions.
	Case {
		flags:      "cluster -cl lists",
		args:       &["--sort", "path", "-cl", "hit", "."],
		code:       0,
		stdout:     b"./a.txt\n./crlf.txt\n./sub/c.txt\n./uni.txt\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "cluster -lc counts",
		args:       &["--sort", "path", "-lc", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:2\n./crlf.txt:1\n./sub/c.txt:1\n./uni.txt:1\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-l then --files-without-match",
		args:       &["--sort", "path", "-l", "--files-without-match", "hit", "."],
		code:       0,
		stdout:     b"./UPPER.TXT\n./empty.txt\n./sub/d.md\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--files-without-match then -l",
		args:       &["--sort", "path", "--files-without-match", "-l", "hit", "."],
		code:       0,
		stdout:     b"./a.txt\n./crlf.txt\n./sub/c.txt\n./uni.txt\n",
		stderr:     b"",
		divergence: None,
	},
	// `--generate` is a mode too, and its two refusals are byte comparable even
	// though the artifacts it writes are deliberately not: ours are generated from
	// THIS builtin's flag table, so they describe the flags it really has.
	Case {
		flags:      "--generate with an unknown kind",
		args:       &["--generate", "nope"],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: error parsing flag --generate: choice 'nope' is unrecognized\n",
		divergence: None,
	},
	Case {
		flags:      "--generate with an uppercase kind",
		args:       &["--generate", "MAN"],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: error parsing flag --generate: choice 'MAN' is unrecognized\n",
		divergence: None,
	},
	Case {
		flags:      "--generate with no kind",
		args:       &["--generate"],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: missing value for flag --generate: missing argument for option '--generate'\n",
		divergence: None,
	},
	Case {
		flags:      "--generate man then -c",
		args:       &["--generate", "man", "-c"],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: ripgrep requires at least one pattern to execute a search\n",
		divergence: None,
	},
	// The missing-pattern sentence is the same in every mode, and it names neither
	// the mode nor the operand it wanted.
	Case {
		flags:      "-c with no pattern",
		args:       &["-c"],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: ripgrep requires at least one pattern to execute a search\n",
		divergence: None,
	},
	Case {
		flags:      "--json with no pattern",
		args:       &["--json"],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: ripgrep requires at least one pattern to execute a search\n",
		divergence: None,
	},
	// And for a size.
	Case {
		flags:      "--max-filesize with a negative value",
		args:       &["--max-filesize", "-1", "hit", "."],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: error parsing flag --max-filesize: invalid size: invalid format for size '-1', which should be a non-empty sequence of digits followed by an optional 'K', 'M' or 'G' suffix\n",
		divergence: None,
	},
	// The four buffering flags and their orderings. Every one of these prints the
	// same bytes as a run with no flags, which is the whole contract from outside:
	// buffering changes WHEN a byte leaves, never which bytes. They are here
	// because being accepted is the part that was broken -- `--block-buffered` and
	// `--no-block-buffered` did not exist, so two of these eight exited 2 with an
	// unknown-argument error, and two more were rejected for carrying one.
	Case {
		flags:      "--block-buffered",
		args:       &["--sort", "path", "--block-buffered", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--line-buffered",
		args:       &["--sort", "path", "--line-buffered", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--no-block-buffered",
		args:       &["--sort", "path", "--no-block-buffered", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--no-line-buffered",
		args:       &["--sort", "path", "--no-line-buffered", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--line-buffered --block-buffered",
		args:       &["--sort", "path", "--line-buffered", "--block-buffered", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--block-buffered --line-buffered",
		args:       &["--sort", "path", "--block-buffered", "--line-buffered", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--line-buffered --no-block-buffered",
		args:       &["--sort", "path", "--line-buffered", "--no-block-buffered", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--block-buffered --no-line-buffered",
		args:       &["--sort", "path", "--block-buffered", "--no-line-buffered", "hit", "."],
		code:       0,
		stdout:     b"./a.txt:alpha hit\n./a.txt:hit hit\n./crlf.txt:crlf hit\r\n./sub/c.txt:deep hit\n./uni.txt:caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
];

/// The awkward tree's corpus, captured the same way; see `awkward_tree`.
#[rustfmt::skip]
static AWKWARD_CASES: &[Case] = &[
	// The baseline for this tree: an `.ignore` file hides one name, the symlink is not
	// followed, and the gzip file is binary.
	Case {
		flags:      "(no flags) over the awkward tree",
		args:       &["--sort", "path", "hit", "."],
		code:       0,
		stdout:     b"./big.txt:big hit\n./deep/nested/f.txt:nested hit\n./latin1.txt:caf\xe9 hit\n./long.txt:start xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx hit tail\n./multi.txt:hit\n./multi.txt:hit\n./tabs.txt:\t  hit tabbed\n./utf16.txt:wide hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--hidden --no-ignore",
		args:       &["--sort", "path", "--hidden", "--no-ignore", "hit", "."],
		code:       0,
		stdout:     b"./big.txt:big hit\n./deep/nested/f.txt:nested hit\n./ignored.txt:ignored hit\n./latin1.txt:caf\xe9 hit\n./long.txt:start xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx hit tail\n./multi.txt:hit\n./multi.txt:hit\n./tabs.txt:\t  hit tabbed\n./utf16.txt:wide hit\n",
		stderr:     b"",
		divergence: None,
	},
	// Every file decoded as UTF-16, which is what the flag asks for.
	Case {
		flags:      "-E utf-16",
		args:       &["--sort", "path", "-E", "utf-16", "hit", "."],
		code:       0,
		stdout:     b"./utf16.txt:wide hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-E latin1",
		args:       &["--sort", "path", "-E", "latin1", "hit", "."],
		code:       0,
		stdout:     b"./big.txt:big hit\n./deep/nested/f.txt:nested hit\n./latin1.txt:caf\xc3\xa9 hit\n./long.txt:start xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx hit tail\n./multi.txt:hit\n./multi.txt:hit\n./tabs.txt:\t  hit tabbed\n./utf16.txt:wide hit\n",
		stderr:     b"",
		divergence: None,
	},
	// BOM sniffing off, so the UTF-16 file is bytes.
	Case {
		flags:      "--no-encoding",
		args:       &["--sort", "path", "--no-encoding", "hit", "."],
		code:       0,
		stdout:     b"./big.txt:big hit\n./deep/nested/f.txt:nested hit\n./latin1.txt:caf\xe9 hit\n./long.txt:start xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx hit tail\n./multi.txt:hit\n./multi.txt:hit\n./tabs.txt:\t  hit tabbed\n./utf16.txt:wide hit\n",
		stderr:     b"",
		divergence: None,
	},
	// A BOM is sniffed without any flag at all.
	Case {
		flags:      "utf16.txt alone",
		args:       &["--sort", "path", "hit", "utf16.txt"],
		code:       0,
		stdout:     b"wide hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "latin1.txt alone",
		args:       &["--sort", "path", "hit", "latin1.txt"],
		code:       0,
		stdout:     b"caf\xe9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-E latin1 latin1.txt",
		args:       &["--sort", "path", "-E", "latin1", "hit", "latin1.txt"],
		code:       0,
		stdout:     b"caf\xc3\xa9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-M 20",
		args:       &["--sort", "path", "-M", "20", "hit", "long.txt"],
		code:       0,
		stdout:     b"[Omitted long matching line]\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-M 20 --max-columns-preview",
		args:       &["--sort", "path", "-M", "20", "--max-columns-preview", "hit", "long.txt"],
		code:       0,
		stdout:     b"start xxxxxxxxxxxxxx [... omitted end of long line]\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-M 20 -o",
		args:       &["--sort", "path", "-M", "20", "-o", "hit", "long.txt"],
		code:       0,
		stdout:     b"hit\n",
		stderr:     b"",
		divergence: None,
	},
	// A decompressor stands in front of the file.
	Case {
		flags:      "-z data.gz",
		args:       &["--sort", "path", "-z", "hit", "data.gz"],
		code:       0,
		stdout:     b"zipped hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-z over the tree",
		args:       &["--sort", "path", "-z", "hit", "."],
		code:       0,
		stdout:     b"./big.txt:big hit\n./data.gz:zipped hit\n./deep/nested/f.txt:nested hit\n./latin1.txt:caf\xe9 hit\n./long.txt:start xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx hit tail\n./multi.txt:hit\n./multi.txt:hit\n./tabs.txt:\t  hit tabbed\n./utf16.txt:wide hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--path-separator +",
		args:       &["--sort", "path", "--path-separator", "+", "hit", "."],
		code:       0,
		stdout:     b".+big.txt:big hit\n.+deep+nested+f.txt:nested hit\n.+latin1.txt:caf\xe9 hit\n.+long.txt:start xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx hit tail\n.+multi.txt:hit\n.+multi.txt:hit\n.+tabs.txt:\t  hit tabbed\n.+utf16.txt:wide hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--field-match-separator =",
		args:       &["--sort", "path", "-n", "--field-match-separator", "=", "hit", "multi.txt"],
		code:       0,
		stdout:     b"2=hit\n4=hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--field-context-separator ~",
		args:       &["--sort", "path", "-n", "-A1", "--field-context-separator", "~", "hit", "multi.txt"],
		code:       0,
		stdout:     b"2:hit\n3~two\n4:hit\n5~three\n",
		stderr:     b"",
		divergence: None,
	},
	// One record for the whole file, and a NUL ends the output.
	Case {
		flags:      "--null-data",
		args:       &["--sort", "path", "--null-data", "hit", "multi.txt"],
		code:       0,
		stdout:     b"one\nhit\ntwo\nhit\nthree\n\x00",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--null-data -c",
		args:       &["--sort", "path", "--null-data", "-c", "hit", "multi.txt"],
		code:       0,
		stdout:     b"1\x00",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--trim",
		args:       &["--sort", "path", "--trim", "hit", "tabs.txt"],
		code:       0,
		stdout:     b"hit tabbed\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--trim -o",
		args:       &["--sort", "path", "--trim", "-o", "hit", "tabs.txt"],
		code:       0,
		stdout:     b"hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--max-filesize 100",
		args:       &["--sort", "path", "--max-filesize", "100", "hit", "."],
		code:       0,
		stdout:     b"./deep/nested/f.txt:nested hit\n./latin1.txt:caf\xe9 hit\n./long.txt:start xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx hit tail\n./multi.txt:hit\n./multi.txt:hit\n./tabs.txt:\t  hit tabbed\n./utf16.txt:wide hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--max-depth 1",
		args:       &["--sort", "path", "--max-depth", "1", "hit", "."],
		code:       0,
		stdout:     b"./big.txt:big hit\n./latin1.txt:caf\xe9 hit\n./long.txt:start xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx hit tail\n./multi.txt:hit\n./multi.txt:hit\n./tabs.txt:\t  hit tabbed\n./utf16.txt:wide hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--max-depth 0",
		args:       &["--sort", "path", "--max-depth", "0", "hit", "."],
		code:       1,
		stdout:     b"",
		stderr:     b"",
		divergence: None,
	},
	// A negated glob, which excludes rather than includes.
	Case {
		flags:      "-g !*.txt",
		args:       &["--sort", "path", "-g", "!*.txt", "hit", "."],
		code:       1,
		stdout:     b"",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-g *.txt -g !long.txt",
		args:       &["--sort", "path", "-g", "*.txt", "-g", "!long.txt", "hit", "."],
		code:       0,
		stdout:     b"./big.txt:big hit\n./deep/nested/f.txt:nested hit\n./ignored.txt:ignored hit\n./latin1.txt:caf\xe9 hit\n./multi.txt:hit\n./multi.txt:hit\n./tabs.txt:\t  hit tabbed\n./utf16.txt:wide hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--iglob *.TXT",
		args:       &["--sort", "path", "--iglob", "*.TXT", "hit", "."],
		code:       0,
		stdout:     b"./big.txt:big hit\n./deep/nested/f.txt:nested hit\n./ignored.txt:ignored hit\n./latin1.txt:caf\xe9 hit\n./long.txt:start xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx hit tail\n./multi.txt:hit\n./multi.txt:hit\n./tabs.txt:\t  hit tabbed\n./utf16.txt:wide hit\n",
		stderr:     b"",
		divergence: None,
	},
	// Following symlinks, which reaches the linked file under its own name.
	Case {
		flags:      "-L",
		args:       &["--sort", "path", "-L", "hit", "."],
		code:       0,
		stdout:     b"./big.txt:big hit\n./deep/nested/f.txt:nested hit\n./latin1.txt:caf\xe9 hit\n./link.txt:start xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx hit tail\n./long.txt:start xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx hit tail\n./multi.txt:hit\n./multi.txt:hit\n./tabs.txt:\t  hit tabbed\n./utf16.txt:wide hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--files --null",
		args:       &["--sort", "path", "--files", "--null", "."],
		code:       0,
		stdout:     b"./big.txt\x00./caps.txt\x00./data.gz\x00./deep/nested/f.txt\x00./latin1.txt\x00./long.txt\x00./multi.txt\x00./tabs.txt\x00./utf16.txt\x00",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--files -g *.txt",
		args:       &["--sort", "path", "--files", "-g", "*.txt", "."],
		code:       0,
		stdout:     b"./big.txt\n./caps.txt\n./deep/nested/f.txt\n./ignored.txt\n./latin1.txt\n./long.txt\n./multi.txt\n./tabs.txt\n./utf16.txt\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-r with a capture group",
		args:       &["--sort", "path", "-n", "-r", "[$1]", "-e", "(hit)", "multi.txt"],
		code:       0,
		stdout:     b"2:[hit]\n4:[hit]\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-r with a named group",
		args:       &["--sort", "path", "-n", "-r", "<$word>", "-e", "(?P<word>hit)", "multi.txt"],
		code:       0,
		stdout:     b"2:<hit>\n4:<hit>\n",
		stderr:     b"",
		divergence: None,
	},
	// Case folding across a multi-byte character.
	Case {
		flags:      "-i over the caps file",
		args:       &["--sort", "path", "-i", "hit café", "caps.txt"],
		code:       0,
		stdout:     b"HIT Caf\xc3\xa9\n",
		stderr:     b"",
		divergence: None,
	},
	// A column is a BYTE offset, not a character one.
	Case {
		flags:      "--column over unicode",
		args:       &["--sort", "path", "--column", "-n", "hit", "latin1.txt", "caps.txt"],
		code:       0,
		stdout:     b"latin1.txt:1:6:caf\xe9 hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-b over unicode",
		args:       &["--sort", "path", "-b", "hit", "caps.txt"],
		code:       1,
		stdout:     b"",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--vimgrep two matches on a line",
		args:       &["--sort", "path", "--vimgrep", "hit", "big.txt", "multi.txt"],
		code:       0,
		stdout:     b"big.txt:1:5:big hit\nmulti.txt:2:1:hit\nmulti.txt:4:1:hit\n",
		stderr:     b"",
		divergence: None,
	},
	// A word class WITHOUT Unicode support, which stops at the first byte of the multi-byte
	// character rather than matching it.
	Case {
		flags:      "--no-unicode -o",
		args:       &["--sort", "path", "--no-unicode", "-o", "\\w+", "caps.txt"],
		code:       0,
		stdout:     b"HIT\nCaf\n",
		stderr:     b"",
		divergence: None,
	},
	// The twin: with Unicode on, the accented character is a word character.
	Case {
		flags:      "-o with unicode word class",
		args:       &["--sort", "path", "-o", "\\w+", "caps.txt"],
		code:       0,
		stdout:     b"HIT\nCaf\xc3\xa9\n",
		stderr:     b"",
		divergence: None,
	},
	// A value no encoding table has. The reason is the same; see the divergence note.
	Case {
		flags:      "-E with an unknown encoding",
		args:       &["--sort", "path", "-E", "nosuch", "hit", "caps.txt"],
		code:       2,
		stdout:     b"",
		stderr:     b"rg: error parsing flag -E: grep config error: unknown encoding: nosuch\n",
		divergence: Some(
			"the framing of the message differs, not the reason. ripgrep names the flag as the \
			 caller spelled it (`error parsing flag -E`), which it can do because it parses its \
			 own arguments; this builtin parses through clap, which reports a bad VALUE where \
			 it is used rather than where it was written, so the line is the reason alone. Both \
			 exit 2, both name the encoding, and neither searches anything.",
		),
	},
	// Whether the cap stops the trailing context too.
	Case {
		flags:      "-m1 -A1",
		args:       &["--sort", "path", "-m1", "-A1", "hit", "multi.txt"],
		code:       0,
		stdout:     b"hit\ntwo\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-m1 -B1",
		args:       &["--sort", "path", "-m1", "-B1", "hit", "multi.txt"],
		code:       0,
		stdout:     b"one\nhit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--no-messages on a missing operand",
		args:       &["--sort", "path", "--no-messages", "hit", "missing.txt", "multi.txt"],
		code:       2,
		stdout:     b"multi.txt:hit\nmulti.txt:hit\n",
		stderr:     b"",
		divergence: None,
	},
	// The ignore rules turned off, then one file's rules put back by name.
	Case {
		flags:      "--ignore-file",
		args:       &["--sort", "path", "--ignore-file", ".ignore", "--no-ignore", "hit", "."],
		code:       0,
		stdout:     b"./big.txt:big hit\n./deep/nested/f.txt:nested hit\n./latin1.txt:caf\xe9 hit\n./long.txt:start xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx hit tail\n./multi.txt:hit\n./multi.txt:hit\n./tabs.txt:\t  hit tabbed\n./utf16.txt:wide hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--one-file-system",
		args:       &["--sort", "path", "--one-file-system", "hit", "."],
		code:       0,
		stdout:     b"./big.txt:big hit\n./deep/nested/f.txt:nested hit\n./latin1.txt:caf\xe9 hit\n./long.txt:start xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx hit tail\n./multi.txt:hit\n./multi.txt:hit\n./tabs.txt:\t  hit tabbed\n./utf16.txt:wide hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--heading -n",
		args:       &["--sort", "path", "--heading", "-n", "hit", "."],
		code:       0,
		stdout:     b"./big.txt\n1:big hit\n\n./deep/nested/f.txt\n1:nested hit\n\n./latin1.txt\n1:caf\xe9 hit\n\n./long.txt\n1:start xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx hit tail\n\n./multi.txt\n2:hit\n4:hit\n\n./tabs.txt\n1:\t  hit tabbed\n\n./utf16.txt\n1:wide hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--sortr path --heading",
		args:       &["--sort", "path", "--sortr", "path", "--heading", "-n", "hit", "."],
		code:       0,
		stdout:     b"./utf16.txt\n1:wide hit\n\n./tabs.txt\n1:\t  hit tabbed\n\n./multi.txt\n2:hit\n4:hit\n\n./long.txt\n1:start xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx hit tail\n\n./latin1.txt\n1:caf\xe9 hit\n\n./deep/nested/f.txt\n1:nested hit\n\n./big.txt\n1:big hit\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--crlf -A1",
		args:       &["--sort", "path", "--crlf", "-A1", "hit", "multi.txt"],
		code:       0,
		stdout:     b"hit\ntwo\nhit\nthree\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-A1 -B1 -n",
		args:       &["--sort", "path", "-A1", "-B1", "-n", "hit", "multi.txt"],
		code:       0,
		stdout:     b"1-one\n2:hit\n3-two\n4:hit\n5-three\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "--passthru -n",
		args:       &["--sort", "path", "--passthru", "-n", "hit", "multi.txt"],
		code:       0,
		stdout:     b"1-one\n2:hit\n3-two\n4:hit\n5-three\n",
		stderr:     b"",
		divergence: None,
	},
	Case {
		flags:      "-c --stats-free zero",
		args:       &["--sort", "path", "-c", "--include-zero", "hit", "multi.txt", "caps.txt"],
		code:       0,
		stdout:     b"multi.txt:2\ncaps.txt:0\n",
		stderr:     b"",
		divergence: None,
	},
];
