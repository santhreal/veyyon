//! `diff` implemented as an in-process shell builtin on `veyyon-diff-kernel`,
//! which owns the alignment and the unified output: the alignment is a port of
//! GNU diff's own `compareseq` and `shift_boundaries`, measured against GNU
//! diff 3.10 over 464 pair-and-flag cases. All I/O and path resolution is
//! routed through
//! `veyyon-uutils-ctx` so the builtin writes to the command's redirected file
//! descriptors and resolves relative paths against the shell's working
//! directory, while operands are printed as typed.
//!
//! Scope: unified output only (`-u` is accepted and implied; `-U N` and GNU's
//! old-style `-NUM` both control the context size, with `-U N` winning when
//! both are given, as it does in GNU diff), `-q/--brief`, `-N/--new-file`
//! (absent files compare as empty), `-s/--report-identical-files`, `-a/--text`,
//! `--label`, binary detection, `-` for the context stdin, and directory
//! comparison (`Only in <dir>: <name>` lines plus per-pair diffs headed by the
//! invocation, `diff -r A/x B/x`).
//!
//! The flags that change how two lines are COMPARED are supported as well:
//! `-i/--ignore-case`, `-w`, `-b`, `-Z`, `-E`, and `-B/--ignore-blank-lines`.
//! Each of them decides equality without changing what is printed, so `-w` on
//! `trail ` against `trail` reports no difference and prints the left file's
//! trailing space when that line appears as context. Comparing on a KEY while
//! printing the ORIGINAL bytes is why the unified formatter is the kernel's own
//! rather than a library's: `similar`'s `UnifiedDiff` has no comparator hook
//! and would print the keys.
//!
//! `-r` controls descent, as it does in GNU diff. Without it a subdirectory
//! present on both sides is reported as `Common subdirectories: A/x and B/x`
//! and is NOT descended into, which also means it does not affect the exit
//! code: `diff A B` over trees whose only difference is inside a subdirectory
//! exits 0 and says so, and `diff -r A B` exits 1 and shows the change.
//!
//! The context size follows GNU exactly, including the parts of it nobody would
//! design: it is the MAXIMUM of every numeric specification, adjacent `-NUM`
//! arguments accumulate their digits so `-u -1 -1` means eleven, and a bare
//! `-u` joins that maximum with a 3 only when a `-U` is also present, which is
//! why `diff -u -U 0` prints three lines of context and not zero.
//! [`resolve_context`] owns the rule and records the fifty combinations it was
//! measured over. The one deliberate divergence left is scope: `-NUM` alone
//! selects GNU's normal output format, which this builtin does not have, so
//! `diff -1 a b` prints a unified hunk here and a normal one there.
//!
//! Entry point: [`run`]. It never calls `std::process::exit`; clap
//! help/usage/error output is rendered to the context streams and an exit code
//! is returned following the GNU convention (0 = identical, 1 = differences
//! found, 2 = trouble).

use std::{
	collections::BTreeSet,
	ffi::{OsStr, OsString},
	fs,
	io::{Read, Write},
	path::{Path, PathBuf},
};

use clap::{Arg, ArgAction, ArgMatches, Command};
use veyyon_diff_kernel::{Ignore, Unified};
use veyyon_uutils_ctx::format_usage;

const OPT_UNIFIED_FLAG: &str = "unified-flag";
const OPT_UNIFIED: &str = "unified";
const OPT_BRIEF: &str = "brief";
const OPT_RECURSIVE: &str = "recursive";
const OPT_NEW_FILE: &str = "new-file";
const OPT_COLOR: &str = "color";
const OPT_REPORT_IDENTICAL: &str = "report-identical-files";
const OPT_TEXT: &str = "text";
const OPT_LABEL: &str = "label";
const OPT_IGNORE_CASE: &str = "ignore-case";
const OPT_IGNORE_ALL_SPACE: &str = "ignore-all-space";
const OPT_IGNORE_SPACE_CHANGE: &str = "ignore-space-change";
const OPT_IGNORE_TRAILING_SPACE: &str = "ignore-trailing-space";
const OPT_IGNORE_TAB_EXPANSION: &str = "ignore-tab-expansion";
const OPT_IGNORE_BLANK_LINES: &str = "ignore-blank-lines";
const ARG_FILES: &str = "files";

/// In-process builtin entry point. Parses the arguments directly, renders clap
/// help/usage/version to the context streams, and maps errors to the GNU diff
/// exit-code convention, so it is safe to run inside the host shell process.
pub fn run(argv: Vec<OsString>) -> i32 {
	let (argv, digit_context) = split_digit_context(argv);
	let matches = match uu_app().try_get_matches_from(argv.clone()) {
		Ok(matches) => matches,
		Err(err) => {
			let rendered = err.to_string();
			if err.use_stderr() {
				let _ = write!(veyyon_uutils_ctx::stderr(), "{rendered}");
				return 2;
			}
			let _ = write!(veyyon_uutils_ctx::stdout(), "{rendered}");
			return 0;
		},
	};
	match diff_main(&argv, &matches, digit_context) {
		Ok(code) => code,
		Err(msg) => {
			let _ = writeln!(veyyon_uutils_ctx::stderr(), "diff: {msg}");
			2
		},
	}
}

/// Split GNU's old-style `-NUM` context option out of the argument list.
///
/// `diff -u -1 a b` asks for one line of context, and `-NUM` is the only way
/// some scripts spell it: it predates `-U NUM` and GNU still documents it. clap
/// cannot declare it, because the option IS its value and there is no name to
/// match, so it is taken out here and the rest of the argv is parsed as usual.
///
/// Everything after a literal `--` is left alone, so a file genuinely named
/// `-1` still compares.
///
/// ADJACENT `-NUM` ARGUMENTS ACCUMULATE THEIR DIGITS, which is GNU's behaviour
/// and not a guess: `diff -u -1 -1` prints ELEVEN lines of context, `-u -1 -2`
/// prints twelve, and `-u -0 -1` prints one, because GNU builds one number
/// digit by digit and only starts a new one when the option before it was not a
/// digit. So `-u -U 1 -1` is 1 and not 11: the `1` between them belongs to
/// `-U`. The value returned is the LAST number built, matching the single
/// accumulator GNU keeps, and [`resolve_context`] folds it together with the
/// `-U` values.
fn split_digit_context(argv: Vec<OsString>) -> (Vec<OsString>, Option<usize>) {
	let mut kept = Vec::with_capacity(argv.len());
	let mut context = None;
	let mut accumulating = false;
	let mut operands_only = false;
	for arg in argv {
		if operands_only {
			kept.push(arg);
			continue;
		}
		if arg == OsStr::new("--") {
			operands_only = true;
			kept.push(arg);
			continue;
		}
		match digit_option(&arg) {
			Some(lines) => {
				context = Some(match context {
					Some(built) if accumulating => append_digits(built, &arg),
					_ => lines,
				});
				accumulating = true;
			},
			None => {
				accumulating = false;
				kept.push(arg);
			},
		}
	}
	(kept, context)
}

/// Append the digits of a second `-NUM` argument to the number already built.
///
/// Saturating, because a caller who writes enough digits to overflow is asking
/// for every line of the file as context and gets exactly that. A single
/// oversized argument is a different case: [`digit_option`] hands it back to
/// clap to report rather than clamping it, since one wrong number is a typo and
/// two adjacent ones are GNU's documented accumulation.
fn append_digits(built: usize, arg: &OsStr) -> usize {
	let digits = arg.to_str().unwrap_or_default().trim_start_matches('-');
	digits.bytes().fold(built, |value, byte| {
		value
			.saturating_mul(10)
			.saturating_add(usize::from(byte - b'0'))
	})
}

/// The context size GNU diff 3.10 resolves for a command line, which is the
/// MAXIMUM of every numeric specification rather than the last or the widest
/// spelling.
///
/// This is a MEASUREMENT of GNU 3.10 over fifty flag combinations, not a
/// design, and no part of it should be read as something anybody would choose:
///
/// * `-U 2 -U 0` and `-U 0 -U 2` both print two lines, so a repeated `-U` is
///   folded by maximum and not by last-wins;
/// * `-5 -U 1` and `-U 1 -5` both print five, so `-NUM` and `-U` fold together
///   the same way, and neither spelling outranks the other;
/// * a BARE `-u` contributes 3 to that maximum only when a `-U` or `--unified=`
///   is also present. `-u -U 1` prints three and `-u -U 5` prints five, while
///   `-u -1` prints one and `-u -9` prints nine. The asymmetry is measured in
///   both directions and at four values.
///
/// The last clause is why `diff -u -U 0` prints three lines of context and not
/// zero, which is the trap that cost a corpus regeneration: a caller who writes
/// both is asking for a context size GNU will not give them.
fn resolve_context(matches: &ArgMatches, digit_context: Option<usize>) -> usize {
	let explicit: Option<usize> = matches
		.get_many::<usize>(OPT_UNIFIED)
		.and_then(|values| values.copied().max());
	let bare_u = matches.get_flag(OPT_UNIFIED_FLAG);
	[explicit, digit_context, (bare_u && explicit.is_some()).then_some(3)]
		.into_iter()
		.flatten()
		.max()
		.unwrap_or(3)
}

/// The line count in a `-NUM` argument, or `None` when this is not one.
///
/// A value that does not fit a `usize` is not a context request at all and is
/// handed back to clap to report, rather than being silently clamped: a caller
/// who wrote `-99999999999999999999` has made a mistake and needs to hear about
/// it.
fn digit_option(arg: &OsStr) -> Option<usize> {
	let text = arg.to_str()?;
	let digits = text.strip_prefix('-')?;
	if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
		return None;
	}
	digits.parse().ok()
}

pub fn uu_app() -> Command {
	Command::new("diff")
		.version(concat!("diff (veyyon-uu-diff) ", env!("CARGO_PKG_VERSION")))
		.about("Compare files line by line.")
		.override_usage(format_usage("diff [OPTION]... FILE1 FILE2"))
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_UNIFIED_FLAG)
				.short('u')
				.help("output 3 lines of unified context (the default output format)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_UNIFIED)
				.short('U')
				.long(OPT_UNIFIED)
				.value_name("NUM")
				.help("output NUM lines of unified context (also spelled -NUM)")
				.action(ArgAction::Append)
				.value_parser(clap::value_parser!(usize)),
		)
		.arg(
			Arg::new(OPT_BRIEF)
				.short('q')
				.long(OPT_BRIEF)
				.help("report only when files differ")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_RECURSIVE)
				.short('r')
				.long(OPT_RECURSIVE)
				.help("recursively compare any subdirectories found")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_NEW_FILE)
				.short('N')
				.long(OPT_NEW_FILE)
				.help("treat absent files as empty")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_REPORT_IDENTICAL)
				.short('s')
				.long(OPT_REPORT_IDENTICAL)
				.help("report when two files are the same")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_TEXT)
				.short('a')
				.long(OPT_TEXT)
				.help("treat all files as text")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_LABEL)
				.long(OPT_LABEL)
				.value_name("LABEL")
				.action(ArgAction::Append)
				.value_parser(clap::value_parser!(String))
				.help("use LABEL instead of a file name; give it twice for both sides"),
		)
		.arg(
			Arg::new(OPT_IGNORE_CASE)
				.short('i')
				.long(OPT_IGNORE_CASE)
				.help("ignore case differences in file contents")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_IGNORE_ALL_SPACE)
				.short('w')
				.long(OPT_IGNORE_ALL_SPACE)
				.help("ignore all white space")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_IGNORE_SPACE_CHANGE)
				.short('b')
				.long(OPT_IGNORE_SPACE_CHANGE)
				.help("ignore changes in the amount of white space")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_IGNORE_TRAILING_SPACE)
				.short('Z')
				.long(OPT_IGNORE_TRAILING_SPACE)
				.help("ignore white space at line end")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_IGNORE_TAB_EXPANSION)
				.short('E')
				.long(OPT_IGNORE_TAB_EXPANSION)
				.help("ignore changes due to tab expansion")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_IGNORE_BLANK_LINES)
				.short('B')
				.long(OPT_IGNORE_BLANK_LINES)
				.help("ignore changes where lines are all blank")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_COLOR)
				.long(OPT_COLOR)
				.value_name("WHEN")
				.num_args(0..=1)
				.require_equals(true)
				.default_missing_value("auto")
				.help("accepted for compatibility; output is never colorized"),
		)
		.arg(
			Arg::new(ARG_FILES)
				.required(true)
				.num_args(2)
				.value_parser(clap::value_parser!(OsString))
				.value_hint(clap::ValueHint::AnyPath),
		)
}

struct Options {
	context:          usize,
	brief:            bool,
	new_file:         bool,
	recursive:        bool,
	/// `-s`: say so when two files are the SAME, which `diff` otherwise reports
	/// only by exiting 0 and printing nothing.
	report_identical: bool,
	/// `-a`: compare byte-for-byte as text even when a file looks binary,
	/// instead of printing `Binary files A and B differ`.
	text:             bool,
	/// `--label`, at most two: the first replaces the left header and the second
	/// replaces the right. A third is an error in GNU diff and is here too.
	labels:           Vec<String>,
	/// `-i`, `-w`, `-b`, `-Z`, `-E`, `-B`: which differences do not count. These
	/// change the COMPARISON only, never the bytes printed. See
	/// [`veyyon_diff_kernel::Ignore`].
	ignore:           Ignore,
	/// The invocation, rendered the way GNU echoes it ahead of each pair in
	/// directory mode: `diff`, then the option arguments as they were typed.
	///
	/// This used to be the hardcoded string `diff -r`, which claimed a flag the
	/// run may not have been given. See [`invocation_header`].
	header:           String,
}

/// Render the invocation the way GNU diff heads each pair with in directory
/// mode: the command name, then every argument EXCEPT the two file operands,
/// quoted only where a shell would need it.
///
/// GNU reproduces what was typed rather than what it resolved, so `-ru` stays
/// `-ru` and does not become `-r -u`, and `--color=never` comes back quoted.
/// The operands are removed from the END, which is what makes
/// `diff -U 3 3 4`, where `3` is both an option value and a file name, echo as
/// `diff -U 3`: the last `3` is the operand and the earlier one is the value.
fn invocation_header(argv: &[OsString], operands: [&OsString; 2]) -> String {
	let mut rest: Vec<&OsString> = argv.iter().skip(1).collect();
	for operand in [operands[1], operands[0]] {
		if let Some(at) = rest.iter().rposition(|arg| *arg == operand) {
			rest.remove(at);
		}
	}
	let mut out = String::from("diff");
	for arg in rest {
		out.push(' ');
		out.push_str(&shell_quote(&arg.to_string_lossy()));
	}
	out
}

/// Wrap in single quotes unless every byte is one a shell leaves alone.
///
/// The safe set is deliberately narrow: `=` is outside it, which is why GNU
/// prints `'--color=never'` and not `--color=never`, and an empty argument
/// quotes so it stays visible.
fn shell_quote(arg: &str) -> String {
	let safe = !arg.is_empty()
		&& arg
			.chars()
			.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '/' | '-' | '+' | ','));
	if safe {
		return arg.to_string();
	}
	format!("'{}'", arg.replace('\'', r"'\''"))
}

/// A classified operand: what the name as typed refers to on disk after
/// resolution against the scope working directory.
enum Operand {
	/// The context stdin (`-`).
	Stdin,
	/// A regular (or other non-directory) file at the resolved path.
	File(PathBuf),
	/// A directory at the resolved path.
	Dir(PathBuf),
	/// A missing file tolerated by `-N` and compared as empty.
	Absent,
}

fn diff_main(
	argv: &[OsString],
	matches: &ArgMatches,
	digit_context: Option<usize>,
) -> Result<i32, String> {
	let files: Vec<&OsString> = matches.get_many::<OsString>(ARG_FILES).unwrap().collect();
	let opts = Options {
		context:          resolve_context(matches, digit_context),
		brief:            matches.get_flag(OPT_BRIEF),
		new_file:         matches.get_flag(OPT_NEW_FILE),
		recursive:        matches.get_flag(OPT_RECURSIVE),
		report_identical: matches.get_flag(OPT_REPORT_IDENTICAL),
		text:             matches.get_flag(OPT_TEXT),
		labels:           matches
			.get_many::<String>(OPT_LABEL)
			.map(|values| values.cloned().collect())
			.unwrap_or_default(),
		ignore:           Ignore {
			case:           matches.get_flag(OPT_IGNORE_CASE),
			all_space:      matches.get_flag(OPT_IGNORE_ALL_SPACE),
			space_change:   matches.get_flag(OPT_IGNORE_SPACE_CHANGE),
			trailing_space: matches.get_flag(OPT_IGNORE_TRAILING_SPACE),
			tab_expansion:  matches.get_flag(OPT_IGNORE_TAB_EXPANSION),
			blank_lines:    matches.get_flag(OPT_IGNORE_BLANK_LINES),
		},
		header:           invocation_header(argv, [files[0], files[1]]),
	};
	// GNU diff refuses a third label rather than ignoring it, with this exact
	// wording. Silently dropping one would make the run compare the files it was
	// asked about while labelling them something the user did not choose.
	if opts.labels.len() > 2 {
		return Err("too many file label options".to_string());
	}

	let (mut name_a, mut name_b) = (PathBuf::from(files[0]), PathBuf::from(files[1]));
	let mut op_a = classify(&name_a, opts.new_file)?;
	let mut op_b = classify(&name_b, opts.new_file)?;

	// GNU: comparing a directory with a non-directory compares
	// <dir>/<basename-of-other> with the other operand.
	let a_is_dir = matches!(op_a, Operand::Dir(_));
	let b_is_dir = matches!(op_b, Operand::Dir(_));
	if a_is_dir != b_is_dir {
		if matches!(op_a, Operand::Stdin) || matches!(op_b, Operand::Stdin) {
			return Err("cannot compare '-' to a directory".to_string());
		}
		if a_is_dir {
			name_a = descend(&name_a, &name_b)?;
			op_a = classify(&name_a, opts.new_file)?;
		} else {
			name_b = descend(&name_b, &name_a)?;
			op_b = classify(&name_b, opts.new_file)?;
		}
	}

	let differed = if let (Operand::Dir(res_a), Operand::Dir(res_b)) = (&op_a, &op_b) {
		diff_dirs(&name_a, res_a, &name_b, res_b, &opts)?
	} else {
		// A file operand stays a PATH so an identical or brief comparison never
		// loads it. Only stdin and an absent `-N` side arrive as bytes, because
		// stdin cannot be re-read and an absent file has none.
		let eager_a = eager_bytes(&op_a, &name_a)?;
		let eager_b = eager_bytes(&op_b, &name_b)?;
		let src_a = source_for(&op_a, eager_a.as_deref());
		let src_b = source_for(&op_b, eager_b.as_deref());
		diff_pair(&name_a, &src_a, &name_b, &src_b, &opts, None)?
	};
	Ok(i32::from(differed))
}

/// The two names the `---` and `+++` header lines carry.
///
/// `--label` replaces them positionally: the first occurrence replaces the LEFT
/// header and the second replaces the right, so one `--label` renames only the
/// left side and leaves the right as the file name. That asymmetry is GNU's,
/// and it is the reason the labels are a list rather than a pair of options.
fn header_labels(name_a: &Path, name_b: &Path, opts: &Options) -> (String, String) {
	let mut labels = opts.labels.iter();
	(
		labels
			.next()
			.cloned()
			.unwrap_or_else(|| name_a.display().to_string()),
		labels
			.next()
			.cloned()
			.unwrap_or_else(|| name_b.display().to_string()),
	)
}

/// Replaces a directory operand with `<dir>/<basename of other>` for the GNU
/// dir-vs-file comparison form.
fn descend(dir: &Path, other: &Path) -> Result<PathBuf, String> {
	let base = other
		.file_name()
		.ok_or_else(|| format!("cannot compare {} to a directory", other.display()))?;
	Ok(dir.join(base))
}

fn classify(name: &Path, new_file: bool) -> Result<Operand, String> {
	if name.as_os_str() == OsStr::new("-") {
		return Ok(Operand::Stdin);
	}
	// Resolve the operand against the shell working directory; `name` is kept
	// for display (GNU prints operands as typed).
	let resolved = veyyon_uutils_ctx::resolve(name);
	match fs::metadata(&resolved) {
		Ok(meta) if meta.is_dir() => Ok(Operand::Dir(resolved)),
		Ok(_) => Ok(Operand::File(resolved)),
		Err(err) if err.kind() == std::io::ErrorKind::NotFound && new_file => Ok(Operand::Absent),
		Err(err) => Err(format!("{}: {}", name.display(), io_msg(&err))),
	}
}

/// Where one side of a pair gets its bytes from.
///
/// The point is that a `File` can answer "are these two the same?" WITHOUT
/// being loaded. `diff` reads both operands end to end before comparing them,
/// which costs nothing on a source file and is wrong at scale: `diff -q` over
/// two large files allocates both of them to print one sentence, and `diff -r`
/// over two trees allocates every pair it is about to report as identical,
/// which in a real tree is most of them. Sizes settle it for free whenever they
/// differ, and equal sizes need only a fixed-size window.
enum Source<'a> {
	/// A regular file on disk, loaded on demand.
	File(&'a Path),
	/// Bytes already in hand: the context stdin, or the empty side of `-N`.
	Bytes(&'a [u8]),
}

/// How much of a file to hold in memory at once while comparing.
///
/// One page-multiple per side. The comparison is sequential and the buffers are
/// reused, so this bounds the whole operation regardless of file size, which is
/// the property the old `fs::read` pair did not have.
const COMPARE_CHUNK: usize = 64 * 1024;

impl Source<'_> {
	/// The name to report I/O trouble against, which is the operand as typed.
	fn load(&self, name: &Path) -> Result<Vec<u8>, String> {
		match self {
			Self::File(path) => {
				fs::read(path).map_err(|err| format!("{}: {}", name.display(), io_msg(&err)))
			},
			Self::Bytes(bytes) => Ok((*bytes).to_vec()),
		}
	}

	/// The byte length, from metadata for a file so the file is not read.
	fn len(&self, name: &Path) -> Result<u64, String> {
		match self {
			Self::File(path) => fs::metadata(path)
				.map(|meta| meta.len())
				.map_err(|err| format!("{}: {}", name.display(), io_msg(&err))),
			Self::Bytes(bytes) => Ok(bytes.len() as u64),
		}
	}

	/// Open a reader over this source's bytes.
	fn reader(&self, name: &Path) -> Result<Box<dyn Read + '_>, String> {
		match self {
			Self::File(path) => fs::File::open(path)
				.map(|file| Box::new(file) as Box<dyn Read>)
				.map_err(|err| format!("{}: {}", name.display(), io_msg(&err))),
			Self::Bytes(bytes) => Ok(Box::new(*bytes)),
		}
	}
}

/// Whether the two sides hold identical bytes, without loading either of them.
///
/// Length first, which decides it for free in the common differing case and is
/// exact: two files with different sizes cannot be equal. Equal lengths then
/// stream through a pair of reused windows.
///
/// A short read is followed rather than treated as the end, because a `Read` is
/// allowed to return fewer bytes than asked for; treating one as EOF would call
/// a pair equal after comparing only a prefix, which is the failure mode this
/// function exists to avoid.
fn sources_are_equal(
	name_a: &Path,
	src_a: &Source<'_>,
	name_b: &Path,
	src_b: &Source<'_>,
) -> Result<bool, String> {
	if src_a.len(name_a)? != src_b.len(name_b)? {
		return Ok(false);
	}
	let mut read_a = src_a.reader(name_a)?;
	let mut read_b = src_b.reader(name_b)?;
	let mut buf_a = vec![0u8; COMPARE_CHUNK];
	let mut buf_b = vec![0u8; COMPARE_CHUNK];
	loop {
		let got_a = fill(&mut *read_a, &mut buf_a).map_err(|err| io_msg(&err))?;
		let got_b = fill(&mut *read_b, &mut buf_b).map_err(|err| io_msg(&err))?;
		if got_a != got_b {
			// The lengths agreed, so one side ending early means the file changed
			// under us. Reporting "differ" is the honest answer and matches what a
			// re-read would find.
			return Ok(false);
		}
		if got_a == 0 {
			return Ok(true);
		}
		if buf_a[..got_a] != buf_b[..got_b] {
			return Ok(false);
		}
	}
}

/// Read until `buf` is full or the reader ends, returning how many bytes
/// landed.
///
/// `Read::read` may return less than asked for at any time, so a single call
/// cannot be compared against a single call on the other side: the two readers
/// would drift out of alignment and compare different offsets.
fn fill(reader: &mut dyn Read, buf: &mut [u8]) -> std::io::Result<usize> {
	let mut filled = 0;
	while filled < buf.len() {
		match reader.read(&mut buf[filled..]) {
			Ok(0) => break,
			Ok(n) => filled += n,
			Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {},
			Err(err) => return Err(err),
		}
	}
	Ok(filled)
}

/// The bytes an operand must be read into UP FRONT, if any.
///
/// Only the context stdin, which cannot be re-read and so has to be captured
/// before anything else looks at it. A file stays a path, and `Absent` is the
/// empty side of `-N`, which owns no bytes at all.
fn eager_bytes(op: &Operand, name: &Path) -> Result<Option<Vec<u8>>, String> {
	match op {
		Operand::Stdin => read_operand(op, name).map(Some),
		Operand::File(_) | Operand::Absent => Ok(None),
		Operand::Dir(_) => unreachable!("directories are handled by diff_dirs"),
	}
}

/// Pair an operand with the bytes [`eager_bytes`] captured for it, if any.
fn source_for<'a>(op: &'a Operand, eager: Option<&'a [u8]>) -> Source<'a> {
	match op {
		Operand::File(resolved) => Source::File(resolved),
		// `Absent` under `-N` compares as empty, and stdin was captured above.
		Operand::Stdin | Operand::Absent => Source::Bytes(eager.unwrap_or(&[])),
		Operand::Dir(_) => unreachable!("directories are handled by diff_dirs"),
	}
}

fn read_operand(op: &Operand, name: &Path) -> Result<Vec<u8>, String> {
	match op {
		Operand::Stdin => {
			let mut buf = Vec::new();
			veyyon_uutils_ctx::stdin()
				.read_to_end(&mut buf)
				.map_err(|err| format!("-: {}", io_msg(&err)))?;
			Ok(buf)
		},
		Operand::File(resolved) => {
			fs::read(resolved).map_err(|err| format!("{}: {}", name.display(), io_msg(&err)))
		},
		Operand::Dir(_) => unreachable!("directories are handled by diff_dirs"),
		Operand::Absent => Ok(Vec::new()),
	}
}

/// Diffs one pair of already-read inputs, writing to the context stdout.
/// `prefix` is the `diff -r A/x B/x` line emitted before per-pair output in
/// directory mode. Returns whether the inputs differed.
fn diff_pair(
	name_a: &Path,
	src_a: &Source<'_>,
	name_b: &Path,
	src_b: &Source<'_>,
	opts: &Options,
	prefix: Option<&str>,
) -> Result<bool, String> {
	let mut out = veyyon_uutils_ctx::stdout();
	// Equal BYTES are equal under every ignore flag, since a key transform is a
	// function of the line. So this shortcut is still correct with `-w` in force,
	// and it is the only path that answers without loading either file.
	if sources_are_equal(name_a, src_a, name_b, src_b)? {
		return report_identical(&mut out, name_a, name_b, opts).map(|()| false);
	}
	let (label_a, label_b) = header_labels(name_a, name_b, opts);
	if opts.brief && !opts.ignore.any() {
		// Returns here WITHOUT loading either side. `-q`'s whole output is this
		// sentence, so reading the files to produce it was pure cost. With an
		// ignore flag the sentence is not yet known to be true, so that run has to
		// load and fall through to the check below.
		writeln!(out, "Files {} and {} differ", name_a.display(), name_b.display())
			.map_err(|e| io_msg(&e))?;
		return Ok(true);
	}
	// From here the content is needed, either to print a diff or to find out
	// whether the ignore flags make these two equal after all.
	let bytes_a = src_a.load(name_a)?;
	let bytes_b = src_b.load(name_b)?;
	// `-a` forces the text path for a file that looks binary. The check is skipped
	// rather than the classification changed, because `looks_binary` is also what
	// decides the wording below and both answers are wanted: without `-a` a NUL
	// means "do not dump this at a terminal", with `-a` it means "I know, dump it".
	//
	// Binary detection BEATS the ignore flags, which is GNU's behaviour and not an
	// oversight: two binary files that are equal under `-w` still report
	// `Binary files A and B differ` and exit 1, because the transform is defined
	// on lines of text and these are not that. Verified against GNU diff 3.10.
	if !opts.text
		&& (veyyon_diff_kernel::looks_binary(&bytes_a) || veyyon_diff_kernel::looks_binary(&bytes_b))
	{
		let wording = if opts.brief { "Files" } else { "Binary files" };
		writeln!(out, "{wording} {} and {} differ", name_a.display(), name_b.display())
			.map_err(|e| io_msg(&e))?;
		return Ok(true);
	}
	let old = String::from_utf8_lossy(&bytes_a);
	let new = String::from_utf8_lossy(&bytes_b);
	let diff = Unified::compute(old.as_ref(), new.as_ref(), opts.context, opts.ignore);
	// The hunks decide the verdict, not the bytes. Under `-B` a pair whose only
	// difference is a blank line has differing bytes and no surviving hunk, and
	// GNU calls that identical.
	if !diff.differs() {
		return report_identical(&mut out, name_a, name_b, opts).map(|()| false);
	}
	if opts.brief {
		writeln!(out, "Files {} and {} differ", name_a.display(), name_b.display())
			.map_err(|e| io_msg(&e))?;
		return Ok(true);
	}
	if let Some(line) = prefix {
		writeln!(out, "{line}").map_err(|e| io_msg(&e))?;
	}
	diff
		.write(&mut out, &label_a, &label_b)
		.map_err(|e| io_msg(&e))?;
	Ok(true)
}

/// Say nothing, or say `Files A and B are identical` under `-s`.
///
/// One owner because there are now two ways to reach the verdict: equal bytes,
/// which costs nothing, and a diff whose every hunk was filtered out by `-B`.
/// The message uses the operand names and not the labels, matching GNU:
/// `--label` renames the headers of a DIFF, and there is no diff here.
///
/// `-s` is also the only way to LEARN that two files are the same. Without it
/// `diff` says nothing and exits 0, which is indistinguishable from a run that
/// never happened, so a script has to test the exit code to find out.
fn report_identical<W: Write>(
	out: &mut W,
	name_a: &Path,
	name_b: &Path,
	opts: &Options,
) -> Result<(), String> {
	if opts.report_identical {
		writeln!(out, "Files {} and {} are identical", name_a.display(), name_b.display())
			.map_err(|e| io_msg(&e))?;
	}
	Ok(())
}

/// Compares two directories over the sorted union of their entries. Returns
/// whether any difference was found.
///
/// A subdirectory is descended into only under `-r`. Without it the pair is
/// reported as `Common subdirectories:` and left alone, which is GNU's
/// behaviour and also means it cannot affect the exit code.
fn diff_dirs(
	name_a: &Path,
	res_a: &Path,
	name_b: &Path,
	res_b: &Path,
	opts: &Options,
) -> Result<bool, String> {
	let mut names: BTreeSet<OsString> = BTreeSet::new();
	for (dir_name, dir_res) in [(name_a, res_a), (name_b, res_b)] {
		for entry in read_dir_entries(dir_name, dir_res, opts)? {
			names.insert(entry);
		}
	}

	let mut differed = false;
	for name in names {
		if veyyon_uutils_ctx::is_cancelled() {
			return Err("interrupted".to_string());
		}
		let (child_name_a, child_res_a) = (name_a.join(&name), res_a.join(&name));
		let (child_name_b, child_res_b) = (name_b.join(&name), res_b.join(&name));
		let meta_a = fs::metadata(&child_res_a).ok();
		let meta_b = fs::metadata(&child_res_b).ok();
		match (meta_a.as_ref(), meta_b.as_ref()) {
			(Some(ma), Some(mb)) if ma.is_dir() && mb.is_dir() => {
				differed |=
					compare_subdirs(&child_name_a, &child_res_a, &child_name_b, &child_res_b, opts)?;
			},
			(Some(ma), Some(mb)) if ma.is_dir() != mb.is_dir() => {
				let (dir, file) = if ma.is_dir() {
					(&child_name_a, &child_name_b)
				} else {
					(&child_name_b, &child_name_a)
				};
				writeln!(
					veyyon_uutils_ctx::stdout(),
					"File {} is a directory while file {} is a regular file",
					dir.display(),
					file.display()
				)
				.map_err(|e| io_msg(&e))?;
				differed = true;
			},
			(Some(_), Some(_)) => {
				// The hot path of `diff -r`: most pairs in a real tree are identical,
				// and none of them is loaded now.
				let prefix = pair_header(&child_name_a, &child_name_b, opts);
				differed |= diff_pair(
					&child_name_a,
					&Source::File(&child_res_a),
					&child_name_b,
					&Source::File(&child_res_b),
					opts,
					Some(&prefix),
				)?;
			},
			(Some(meta), None) | (None, Some(meta)) => {
				let in_a = meta_b.is_none();
				if opts.new_file && meta.is_dir() {
					// -N makes an absent file an EMPTY one, and GNU extends that to a
					// directory: the pair counts as present on both sides, so it is a
					// common subdirectory and `-r` decides whether to descend. Descending
					// reaches the one-sided files below, each compared against empty.
					differed |=
						compare_subdirs(&child_name_a, &child_res_a, &child_name_b, &child_res_b, opts)?;
				} else if opts.new_file && meta.is_file() {
					// -N: compare the present file against an empty absent one. The name
					// is not needed here any more: `Source::File` carries the resolved
					// path and reports its own I/O trouble against the operand it was
					// handed, so there is nothing left to thread through.
					let present_res = if in_a { &child_res_a } else { &child_res_b };
					let present = Source::File(present_res);
					let absent = Source::Bytes(&[]);
					let prefix = pair_header(&child_name_a, &child_name_b, opts);
					let (src_a, src_b) = if in_a {
						(&present, &absent)
					} else {
						(&absent, &present)
					};
					differed |=
						diff_pair(&child_name_a, src_a, &child_name_b, src_b, opts, Some(&prefix))?;
				} else {
					let present_dir = if in_a { name_a } else { name_b };
					writeln!(
						veyyon_uutils_ctx::stdout(),
						"Only in {}: {}",
						present_dir.display(),
						Path::new(&name).display()
					)
					.map_err(|e| io_msg(&e))?;
					differed = true;
				}
			},
			(None, None) => {},
		}
	}
	Ok(differed)
}

/// List one side's entry names, treating an absent directory as empty under
/// `-N`.
///
/// NOT a silent fallback: without `-N` a missing directory is still an error
/// that reaches the operator with the name that failed, and this branch only
/// exists because `-N` is defined as "an absent file compares as empty", which
/// GNU applies to directories too. It is reached when `-N -r` descends into a
/// subdirectory that exists on one side only.
fn read_dir_entries(
	dir_name: &Path,
	dir_res: &Path,
	opts: &Options,
) -> Result<Vec<OsString>, String> {
	let entries = match fs::read_dir(dir_res) {
		Ok(entries) => entries,
		Err(err) if err.kind() == std::io::ErrorKind::NotFound && opts.new_file => {
			return Ok(Vec::new());
		},
		Err(err) => return Err(format!("{}: {}", dir_name.display(), io_msg(&err))),
	};
	let mut names = Vec::new();
	for entry in entries {
		let entry = entry.map_err(|err| format!("{}: {}", dir_name.display(), io_msg(&err)))?;
		names.push(entry.file_name());
	}
	Ok(names)
}

/// Descend into a subdirectory pair under `-r`, or report it as common.
///
/// The `Common subdirectories:` line deliberately does NOT set the difference
/// flag. GNU exits 0 for `diff A B` when the only change is inside a
/// subdirectory it was not asked to enter, and reporting a difference there
/// would make the exit code disagree with the output, which says nothing was
/// compared.
fn compare_subdirs(
	name_a: &Path,
	res_a: &Path,
	name_b: &Path,
	res_b: &Path,
	opts: &Options,
) -> Result<bool, String> {
	if opts.recursive {
		return diff_dirs(name_a, res_a, name_b, res_b, opts);
	}
	writeln!(
		veyyon_uutils_ctx::stdout(),
		"Common subdirectories: {} and {}",
		name_a.display(),
		name_b.display()
	)
	.map_err(|e| io_msg(&e))?;
	Ok(false)
}

/// The line that introduces one pair inside a directory comparison.
fn pair_header(name_a: &Path, name_b: &Path, opts: &Options) -> String {
	format!("{} {} {}", opts.header, name_a.display(), name_b.display())
}

/// Renders an I/O error without the Rust-specific ` (os error N)` suffix so
/// messages read like GNU diff's (`diff: x: No such file or directory`).
fn io_msg(err: &std::io::Error) -> String {
	let msg = err.to_string();
	match msg.find(" (os error") {
		Some(idx) => msg[..idx].to_string(),
		None => msg,
	}
}

#[cfg(test)]
mod tests {
	use std::{collections::HashMap, io::Write, path::PathBuf, sync::Arc};

	use parking_lot::Mutex;
	use veyyon_uutils_ctx::ScopeIo;

	use super::*;

	fn run_with(cwd: PathBuf, stdin: &[u8], args: Vec<&str>) -> (i32, String, String) {
		let stdout_buf = Arc::new(Mutex::new(Vec::new()));
		let stderr_buf = Arc::new(Mutex::new(Vec::new()));

		#[derive(Clone)]
		struct SharedWriter {
			buf: Arc<Mutex<Vec<u8>>>,
		}
		impl Write for SharedWriter {
			fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
				self.buf.lock().write(buf)
			}

			fn flush(&mut self) -> std::io::Result<()> {
				self.buf.lock().flush()
			}
		}

		let io = ScopeIo {
			stdin: Box::new(std::io::Cursor::new(stdin.to_vec())),
			stdin_fd: None,
			stdin_is_search_input: false,
			stdout: Box::new(SharedWriter { buf: stdout_buf.clone() }),
			stdout_is_terminal: false,
			stderr: Box::new(SharedWriter { buf: stderr_buf.clone() }),
			cwd,
			env: HashMap::new(),
			cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
		};

		let argv: Vec<OsString> = std::iter::once("diff")
			.chain(args)
			.map(OsString::from)
			.collect();

		let code = veyyon_uutils_ctx::scope(io, || run(argv));

		let out_str = String::from_utf8(stdout_buf.lock().clone()).unwrap();
		let err_str = String::from_utf8(stderr_buf.lock().clone()).unwrap();

		(code, out_str, err_str)
	}

	fn run_in(cwd: PathBuf, args: Vec<&str>) -> (i32, String, String) {
		run_with(cwd, b"", args)
	}

	/// Canonicalized temp dir (macOS tempdirs live behind /var -> /private/var).
	fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let canon = fs::canonicalize(dir.path()).unwrap();
		(dir, canon)
	}

	/// GNU'S OLD-STYLE `-NUM` CONTEXT OPTION, which this builtin did not accept
	/// at all: `diff -u -1 a b` exited 2 with a clap error where GNU prints one
	/// line of context. It predates `-U NUM`, GNU still documents it, and a
	/// script that has used it for twenty years has no reason to stop.
	///
	/// PROBED AGAINST GNU DIFF 3.10 for every rule below, over a seven-line pair
	/// whose only difference is on line 4, so the `@@` header alone says how
	/// much context was printed: `-u` gives `@@ -1,7 +1,7 @@`, `-u -1` gives
	/// `@@ -3,3 +3,3 @@`, and `-u -0` gives `@@ -4 +4 @@`.
	/// How the context size is resolved when a command line specifies it more
	/// than once.
	///
	/// WHY THIS SUITE EXISTS. The rule used to be "`-U NUM` outranks `-NUM` in
	/// either order", and that rule agreed with GNU on the two examples it was
	/// written against and disagreed on almost everything else: `diff -2 -U 1`
	/// prints two lines and it printed one, `diff -u -U 0` prints three and it
	/// printed zero. GNU takes the MAXIMUM of every numeric specification, and a
	/// bare `-u` joins that maximum with a 3 only when a `-U` or `--unified=` is
	/// also present. Both halves are measured over fifty combinations, so every
	/// case here asserts the `@@` header GNU diff 3.10 prints on this fixture
	/// rather than the resolved integer: a builtin that resolved the number
	/// correctly and printed the wrong window would pass an integer assertion.
	mod the_context_size_is_gnus_maximum_of_every_specification {
		use super::*;

		/// The same seven-line pair the digit tests use, differing only on line
		/// 4.
		fn pair() -> (tempfile::TempDir, PathBuf) {
			let (dir, root) = canonical_tempdir();
			fs::write(root.join("a.txt"), "a\nb\nc\nd\ne\nf\ng\n").unwrap();
			fs::write(root.join("b.txt"), "a\nb\nc\nX\ne\nf\ng\n").unwrap();
			(dir, root)
		}

		/// Assert the header for a command line, with GNU's value in the message.
		fn header(args: &[&str], want: &str) {
			let (_dir, root) = pair();
			let mut full: Vec<&str> = args.to_vec();
			full.extend(["a.txt", "b.txt"]);

			let (code, stdout, stderr) = run_in(root, full.clone());

			assert_eq!(code, 1, "{args:?}: {stderr}");
			assert!(stdout.contains(want), "{args:?}: GNU prints {want}, we printed {stdout:?}");
		}

		/// One specification, each spelling: the baseline the folding cases move
		/// away from.
		#[test]
		fn a_single_specification_is_used_as_written() {
			header(&["-u"], "@@ -1,7 +1,7 @@");
			header(&["-U", "1"], "@@ -3,3 +3,3 @@");
			header(&["-U", "0"], "@@ -4 +4 @@");
			header(&["--unified=2"], "@@ -2,5 +2,5 @@");
			header(&["-u", "-2"], "@@ -2,5 +2,5 @@");
		}

		/// A REPEATED `-U` folds by maximum, in both orders.
		///
		/// `-U 2 -U 0` is the case that rules out last-wins, and `-U 0 -U 2` the
		/// case that rules out first-wins. Both print two lines.
		#[test]
		fn a_repeated_named_option_takes_the_largest_value() {
			header(&["-U", "2", "-U", "0"], "@@ -2,5 +2,5 @@");
			header(&["-U", "0", "-U", "2"], "@@ -2,5 +2,5 @@");
		}

		/// `-NUM` and `-U` fold by maximum too, and NEITHER outranks the other.
		///
		/// The four cases that killed the old rule. `-2 -U 1` and `-U 1 -2` print
		/// two, so the digit form wins when it is larger; `-1 -U 2` and `-U 2 -1`
		/// print two as well, so the named form wins when IT is larger. A rule
		/// where one spelling outranks the other gets half of these wrong,
		/// whichever half it picks.
		#[test]
		fn neither_spelling_outranks_the_other() {
			header(&["-2", "-U", "1"], "@@ -2,5 +2,5 @@");
			header(&["-U", "1", "-2"], "@@ -2,5 +2,5 @@");
			header(&["-1", "-U", "2"], "@@ -2,5 +2,5 @@");
			header(&["-U", "2", "-1"], "@@ -2,5 +2,5 @@");
		}

		/// A BARE `-u` beside a `-U` contributes 3 to the maximum, in either
		/// order and for every spelling of the named option.
		///
		/// This is the trap: `diff -u -U 0` prints THREE lines of context, not
		/// zero, so a caller who writes both does not get the count they asked
		/// for. It is measured, not reasoned, and it cost a differential corpus a
		/// full regeneration when the capture script wrote `diff -u -U 0` and GNU
		/// quietly ignored the zero.
		#[test]
		fn a_bare_u_beside_a_named_option_contributes_three() {
			header(&["-u", "-U", "0"], "@@ -1,7 +1,7 @@");
			header(&["-u", "-U", "1"], "@@ -1,7 +1,7 @@");
			header(&["-U", "0", "-u"], "@@ -1,7 +1,7 @@");
			header(&["-u", "--unified=0"], "@@ -1,7 +1,7 @@");
			header(&["-u", "-1", "-U", "2"], "@@ -1,7 +1,7 @@");
			header(&["-u", "-2", "-U", "1"], "@@ -1,7 +1,7 @@");
		}

		/// And a larger named count still wins over that 3, so the bare `-u`
		/// contributes to a MAXIMUM rather than forcing three.
		///
		/// The case that separates the two readings of the clause above. `-u -U
		/// 5` prints five lines, which on this seven-line file is the whole
		/// file, so it is checked against a wider pair where five and three
		/// differ.
		#[test]
		fn a_larger_named_count_still_wins_over_that_three() {
			let (_dir, root) = canonical_tempdir();
			let old: String = (1..=20).map(|index| format!("f{index}\n")).collect();
			fs::write(root.join("wide_a.txt"), &old).unwrap();
			fs::write(root.join("wide_b.txt"), old.replace("f10\n", "TEN\n")).unwrap();

			let (code, stdout, stderr) =
				run_in(root, vec!["-u", "-U", "5", "wide_a.txt", "wide_b.txt"]);

			assert_eq!(code, 1, "{stderr}");
			assert!(stdout.contains("@@ -5,11 +5,11 @@"), "five lines, not three: {stdout:?}");
		}

		/// A bare `-u` beside ONLY a digit option contributes NOTHING.
		///
		/// The asymmetry, and the reason the clause above cannot be stated as
		/// "`-u` means 3". `-u -1` prints one line and `-u -0` prints zero, where
		/// a 3 in the maximum would print three for both.
		#[test]
		fn a_bare_u_beside_only_a_digit_contributes_nothing() {
			header(&["-u", "-1"], "@@ -3,3 +3,3 @@");
			header(&["-u", "-0"], "@@ -4 +4 @@");
		}
	}

	mod the_old_style_digit_option_sets_the_context {
		use super::*;

		/// A seven-line pair differing only on line 4, so the header reports the
		/// context width without any counting.
		fn pair() -> (tempfile::TempDir, PathBuf) {
			let (dir, root) = canonical_tempdir();
			fs::write(root.join("a.txt"), "a\nb\nc\nd\ne\nf\ng\n").unwrap();
			fs::write(root.join("b.txt"), "a\nb\nc\nX\ne\nf\ng\n").unwrap();
			(dir, root)
		}

		/// The header for each width, measured: 1 line of context, 0 lines, and
		/// the default 3 when nothing asks.
		#[test]
		fn each_digit_sets_that_many_lines_of_context() {
			for (args, header) in [
				(vec!["-u", "-1", "a.txt", "b.txt"], "@@ -3,3 +3,3 @@"),
				(vec!["-u", "-0", "a.txt", "b.txt"], "@@ -4 +4 @@"),
				(vec!["-u", "-2", "a.txt", "b.txt"], "@@ -2,5 +2,5 @@"),
				(vec!["-u", "a.txt", "b.txt"], "@@ -1,7 +1,7 @@"),
			] {
				let (_dir, root) = pair();

				let (code, stdout, stderr) = run_in(root, args.clone());

				assert_eq!(code, 1, "{args:?}: {stderr}");
				assert!(stdout.contains(header), "{args:?}: wanted {header} in {stdout:?}");
			}
		}

		/// A count larger than the file is not an error: the hunk simply covers
		/// the whole file, which is what GNU prints for `-u -12` over seven
		/// lines.
		#[test]
		fn a_count_larger_than_the_file_covers_the_whole_file() {
			let (_dir, root) = pair();

			let (code, stdout, stderr) = run_in(root, vec!["-u", "-12", "a.txt", "b.txt"]);

			assert_eq!(code, 1, "{stderr}");
			assert!(stdout.contains("@@ -1,7 +1,7 @@"), "{stdout:?}");
		}

		/// ADJACENT `-NUM` ARGUMENTS ACCUMULATE THEIR DIGITS, which is GNU's rule
		/// and the reason this is not "the last one wins".
		///
		/// `-1 -1` is eleven lines and `-1 -0` is ten, so both cover this
		/// seven-line file whole, while `-0 -1` is one: GNU builds ONE number
		/// digit by digit. A `-U` between two digit options interrupts the
		/// accumulation, so `-U 1 -1` is one and not eleven. Every header here is
		/// GNU diff 3.10's on this fixture. A last-wins implementation reports
		/// three lines for the first case and one for the second, and a
		/// first-wins one reports one for both.
		#[test]
		fn adjacent_digit_options_accumulate_their_digits() {
			for (args, header) in [
				(vec!["-u", "-1", "-1", "a.txt", "b.txt"], "@@ -1,7 +1,7 @@"),
				(vec!["-u", "-1", "-0", "a.txt", "b.txt"], "@@ -1,7 +1,7 @@"),
				(vec!["-u", "-0", "-1", "a.txt", "b.txt"], "@@ -3,3 +3,3 @@"),
				(vec!["-u", "-U", "1", "-1", "a.txt", "b.txt"], "@@ -1,7 +1,7 @@"),
			] {
				let (_dir, root) = pair();

				let (code, stdout, stderr) = run_in(root, args.clone());

				assert_eq!(code, 1, "{args:?}: {stderr}");
				assert!(stdout.contains(header), "{args:?}: wanted {header} in {stdout:?}");
			}
		}

		/// A FILE NAMED `-1` after `--` is still a file. The digit option is
		/// taken out of the argument list, so the one place it must not look is
		/// past the end-of-options marker, or a caller could never diff such a
		/// file at all.
		#[test]
		fn a_file_named_like_a_digit_option_survives_after_the_marker() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("-1"), "one\n").unwrap();
			fs::write(root.join("b.txt"), "two\n").unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-u", "--", "-1", "b.txt"]);

			assert_eq!(code, 1, "{stderr}");
			assert!(stdout.starts_with("--- -1\n+++ b.txt\n"), "the operand is the file: {stdout:?}");
			assert!(stdout.contains("\n-one\n") && stdout.contains("\n+two\n"), "{stdout:?}");
		}

		/// A LONE `-` is stdin and not a digit option, and a `-x` that is not
		/// digits is left for clap to report, so the split cannot swallow an
		/// unknown flag.
		#[test]
		fn only_digits_are_taken_as_a_context_option() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a.txt"), "one\n").unwrap();

			let (code, stdout, stderr) = run_with(root.clone(), b"one\n", vec!["-u", "a.txt", "-"]);
			assert_eq!((code, stdout.as_str()), (0, ""), "a lone - is stdin: {stderr}");

			let (code, _, stderr) = run_in(root, vec!["-u", "-Q", "a.txt", "a.txt"]);
			assert_eq!(code, 2, "an unknown flag is still an error");
			assert!(stderr.contains("-Q") || stderr.contains("unexpected"), "{stderr:?}");
		}
	}

	#[test]
	fn identical_files_print_nothing_and_exit_zero() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
		fs::write(root.join("b.txt"), "one\ntwo\n").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["a.txt", "b.txt"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
	}

	/// Relative operands must resolve against the scope cwd (a tempdir), not
	/// the process cwd — the veyyon-specific contract.
	#[test]
	fn differing_files_emit_unified_diff_with_typed_headers() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("a.txt"), "one\ntwo\nthree\n").unwrap();
		fs::write(root.join("b.txt"), "one\nTWO\nthree\n").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["a.txt", "b.txt"]);
		assert_eq!(code, 1);
		assert_eq!(stderr, "");
		assert!(stdout.starts_with("--- a.txt\n+++ b.txt\n@@ "), "got: {stdout}");
		assert!(stdout.contains("\n-two\n"), "got: {stdout}");
		assert!(stdout.contains("\n+TWO\n"), "got: {stdout}");
		// Context lines around the change (default -U 3).
		assert!(stdout.contains("\n one\n"), "got: {stdout}");
		assert!(stdout.contains("\n three\n"), "got: {stdout}");
	}

	#[test]
	fn unified_zero_drops_context_lines() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("a.txt"), "one\ntwo\nthree\n").unwrap();
		fs::write(root.join("b.txt"), "one\nTWO\nthree\n").unwrap();

		let (code, stdout, _) = run_in(root, vec!["-U", "0", "a.txt", "b.txt"]);
		assert_eq!(code, 1);
		assert!(!stdout.contains("\n one\n"), "got: {stdout}");
		assert!(!stdout.contains("\n three\n"), "got: {stdout}");
		assert!(stdout.contains("\n-two\n"), "got: {stdout}");
		assert!(stdout.contains("\n+TWO\n"), "got: {stdout}");
	}

	#[test]
	fn brief_reports_one_line_per_differing_pair() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("a.txt"), "x\n").unwrap();
		fs::write(root.join("b.txt"), "y\n").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["-q", "a.txt", "b.txt"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "Files a.txt and b.txt differ\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn compat_flags_are_accepted_and_ignored() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("a.txt"), "x\n").unwrap();
		fs::write(root.join("b.txt"), "y\n").unwrap();

		let (code, stdout, stderr) =
			run_in(root, vec!["-u", "-r", "--color=always", "a.txt", "b.txt"]);
		assert_eq!(code, 1);
		assert_eq!(stderr, "");
		// Plain unified output, no ANSI escapes.
		assert!(stdout.starts_with("--- a.txt\n+++ b.txt\n"), "got: {stdout}");
		assert!(!stdout.contains('\u{1b}'), "got: {stdout}");
	}

	#[test]
	fn binary_inputs_report_binary_difference() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("a.bin"), b"aa\x00bb").unwrap();
		fs::write(root.join("b.bin"), b"aa\x00cc").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["a.bin", "b.bin"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "Binary files a.bin and b.bin differ\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn missing_operand_file_is_trouble() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("a.txt"), "x\n").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["a.txt", "nope.txt"]);
		assert_eq!(code, 2);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "diff: nope.txt: No such file or directory\n");
	}

	#[test]
	fn missing_second_operand_is_usage_error() {
		let (code, stdout, stderr) = run_in(PathBuf::from("."), vec!["only-one"]);
		assert_eq!(code, 2);
		assert_eq!(stdout, "");
		assert!(stderr.contains("required"), "got: {stderr}");
	}

	#[test]
	fn new_file_treats_missing_operand_as_empty() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("a.txt"), "one\n").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["-N", "nope.txt", "a.txt"]);
		assert_eq!(code, 1);
		assert_eq!(stderr, "");
		assert!(stdout.starts_with("--- nope.txt\n+++ a.txt\n"), "got: {stdout}");
		assert!(stdout.contains("\n+one\n"), "got: {stdout}");
	}

	#[test]
	fn dash_reads_context_stdin() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();

		let (code, stdout, stderr) = run_with(root.clone(), b"one\ntwo\n", vec!["a.txt", "-"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));

		let (code, stdout, _) = run_with(root, b"one\nTWO\n", vec!["a.txt", "-"]);
		assert_eq!(code, 1);
		assert!(stdout.starts_with("--- a.txt\n+++ -\n"), "got: {stdout}");
	}

	/// `-r` descends and reports both the one-sided entries and the nested pair.
	/// The flag is spelled explicitly because it is what asks for descent; the
	/// `descent_follows_the_r_flag` suite pins what happens without it.
	#[test]
	fn recursive_directories_diff_with_only_in_lines() {
		let (_dir, root) = canonical_tempdir();
		let (a, b) = (root.join("a"), root.join("b"));
		fs::create_dir_all(a.join("sub")).unwrap();
		fs::create_dir_all(b.join("sub")).unwrap();
		fs::write(a.join("common.txt"), "same\n").unwrap();
		fs::write(b.join("common.txt"), "same\n").unwrap();
		fs::write(a.join("only.txt"), "left\n").unwrap();
		fs::write(b.join("other.txt"), "right\n").unwrap();
		fs::write(a.join("sub/inner.txt"), "old\n").unwrap();
		fs::write(b.join("sub/inner.txt"), "new\n").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["-r", "a", "b"]);
		assert_eq!(code, 1);
		assert_eq!(stderr, "");
		assert!(stdout.contains("Only in a: only.txt\n"), "got: {stdout}");
		assert!(stdout.contains("Only in b: other.txt\n"), "got: {stdout}");
		assert!(
			stdout.contains(
				"diff -r a/sub/inner.txt b/sub/inner.txt\n--- a/sub/inner.txt\n+++ b/sub/inner.txt\n"
			),
			"got: {stdout}"
		);
		assert!(stdout.contains("\n-old\n"), "got: {stdout}");
		assert!(stdout.contains("\n+new\n"), "got: {stdout}");
		// Identical common.txt must not appear at all.
		assert!(!stdout.contains("common.txt"), "got: {stdout}");
	}

	#[test]
	fn identical_directories_exit_zero() {
		let (_dir, root) = canonical_tempdir();
		let (a, b) = (root.join("a"), root.join("b"));
		fs::create_dir_all(&a).unwrap();
		fs::create_dir_all(&b).unwrap();
		fs::write(a.join("f.txt"), "same\n").unwrap();
		fs::write(b.join("f.txt"), "same\n").unwrap();

		let (code, stdout, stderr) = run_in(root, vec!["-r", "a", "b"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
	}

	/// Descent into a subdirectory follows `-r`, and the pair header echoes the
	/// invocation.
	///
	/// WHY THIS SUITE EXISTS. This builtin recursed into every subdirectory
	/// unconditionally and headed each pair with a hardcoded `diff -r`. Both are
	/// wrong, and the first one is wrong in the direction that matters: GNU diff
	/// 3.10 does not enter a subdirectory without `-r`. It prints
	/// `Common subdirectories: A/x and B/x` and, because nothing was compared,
	/// EXITS 0. So `diff A B` over two trees whose only difference was nested
	/// returned 1 here and 0 there, and printed a diff GNU does not print. A
	/// script branching on that exit code took the other path. The header lied
	/// in the quieter way: it claimed a flag the run may not have been given,
	/// so the line a reader would copy to reproduce one pair was not the
	/// command that produced it.
	///
	/// Every expectation below was captured from GNU diff 3.10 on this machine.
	mod descent_follows_the_r_flag {
		use super::*;

		/// Two trees whose only difference is inside a subdirectory.
		fn nested_difference() -> (tempfile::TempDir, PathBuf) {
			let (dir, root) = canonical_tempdir();
			for side in ["p", "q"] {
				fs::create_dir_all(root.join(side).join("s")).unwrap();
				fs::write(root.join(side).join("t.txt"), "same\n").unwrap();
			}
			fs::write(root.join("p/s/i.txt"), "x\n").unwrap();
			fs::write(root.join("q/s/i.txt"), "y\n").unwrap();
			(dir, root)
		}

		/// THE BUG. Without `-r` the subdirectory is named and not entered, and
		/// the exit code says nothing differed, because as far as this invocation
		/// is concerned nothing was compared.
		#[test]
		fn a_subdirectory_is_reported_common_and_not_entered() {
			let (_dir, root) = nested_difference();

			let (code, stdout, stderr) = run_in(root, vec!["p", "q"]);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "Common subdirectories: p/s and q/s\n");
			assert_eq!(stderr, "");
		}

		/// THE OTHER HALF, so the case above is the flag being honoured rather
		/// than the walk having broken: with `-r` the same trees produce the
		/// nested diff and exit 1.
		#[test]
		fn the_r_flag_descends_into_the_same_subdirectory() {
			let (_dir, root) = nested_difference();

			let (code, stdout, stderr) = run_in(root, vec!["-r", "p", "q"]);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(
				stdout,
				"diff -r p/s/i.txt q/s/i.txt\n--- p/s/i.txt\n+++ q/s/i.txt\n@@ -1 +1 @@\n-x\n+y\n"
			);
		}

		/// `-q` does not change the descent rule: the common-subdirectory line is
		/// still what a non-recursive run prints, and it still exits 0.
		#[test]
		fn brief_mode_keeps_the_common_subdirectory_line() {
			let (_dir, root) = nested_difference();

			let (code, stdout, stderr) = run_in(root, vec!["-q", "p", "q"]);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "Common subdirectories: p/s and q/s\n");
		}

		/// A directory present on ONE side is `Only in`, not a common
		/// subdirectory. This is the case `-N` changes, below.
		#[test]
		fn a_one_sided_directory_is_only_in() {
			let (_dir, root) = canonical_tempdir();
			fs::create_dir_all(root.join("p/extra")).unwrap();
			fs::create_dir_all(root.join("q")).unwrap();
			fs::write(root.join("p/extra/g.txt"), "g\n").unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-r", "p", "q"]);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "Only in p: extra\n");
		}

		/// `-N` makes an absent file empty, and GNU extends that to a directory:
		/// the one-sided directory becomes COMMON, so without `-r` it is reported
		/// and not entered. The exit code is 0, which is the surprising part and
		/// exactly why it is pinned.
		#[test]
		fn new_file_makes_a_one_sided_directory_common() {
			let (_dir, root) = canonical_tempdir();
			fs::create_dir_all(root.join("p/extra")).unwrap();
			fs::create_dir_all(root.join("q")).unwrap();
			fs::write(root.join("p/extra/g.txt"), "g\n").unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-N", "p", "q"]);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "Common subdirectories: p/extra and q/extra\n");
		}

		/// And with both flags the walk enters a directory that exists on one
		/// side only, comparing each file it finds against an absent one. The
		/// header carries BOTH flags in the order they were typed.
		#[test]
		fn new_file_and_recursive_descend_into_a_one_sided_directory() {
			let (_dir, root) = canonical_tempdir();
			fs::create_dir_all(root.join("p/extra")).unwrap();
			fs::create_dir_all(root.join("q")).unwrap();
			fs::write(root.join("p/extra/g.txt"), "g\n").unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-N", "-r", "p", "q"]);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(
				stdout,
				"diff -N -r p/extra/g.txt q/extra/g.txt\n--- p/extra/g.txt\n+++ q/extra/g.txt\n@@ -1 \
				 +0,0 @@\n-g\n"
			);
		}

		/// The header reproduces the options AS TYPED, which is what GNU does:
		/// `-ru` stays one argument and does not become `-r -u`, and a value
		/// option keeps its value next to it.
		#[test]
		fn the_pair_header_reproduces_the_options_as_typed() {
			for (args, expected) in [
				(vec!["-ru", "p", "q"], "diff -ru p/s/i.txt q/s/i.txt\n"),
				(vec!["-r", "-U", "1", "p", "q"], "diff -r -U 1 p/s/i.txt q/s/i.txt\n"),
				(vec!["-u", "-r", "p", "q"], "diff -u -r p/s/i.txt q/s/i.txt\n"),
			] {
				let (_dir, root) = nested_difference();
				let (code, stdout, stderr) = run_in(root, args.clone());

				assert_eq!(code, 1, "{args:?} {stderr}");
				assert!(stdout.starts_with(expected), "{args:?} got: {stdout}");
			}
		}

		/// An option a shell would need quoting for comes back quoted, which is
		/// GNU's rendering of `--color=never`.
		#[test]
		fn the_pair_header_quotes_what_a_shell_would_need_quoted() {
			let (_dir, root) = nested_difference();

			let (code, stdout, stderr) = run_in(root, vec!["-r", "--color=never", "p", "q"]);

			assert_eq!(code, 1, "{stderr}");
			assert!(
				stdout.starts_with("diff -r '--color=never' p/s/i.txt q/s/i.txt\n"),
				"got: {stdout}"
			);
		}

		/// THE OPERAND-REMOVAL TRAP: a file named `3` next to `-U 3`. The header
		/// must drop the OPERAND `3` and keep the option's value, which is why
		/// the removal walks from the end of the argument list.
		#[test]
		fn an_operand_that_looks_like_an_option_value_leaves_the_value_alone() {
			let (_dir, root) = canonical_tempdir();
			for side in ["3", "4"] {
				fs::create_dir_all(root.join(side).join("s")).unwrap();
			}
			fs::write(root.join("3/s/i.txt"), "x\n").unwrap();
			fs::write(root.join("4/s/i.txt"), "y\n").unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-r", "-U", "3", "3", "4"]);

			assert_eq!(code, 1, "{stderr}");
			assert!(stdout.starts_with("diff -r -U 3 3/s/i.txt 4/s/i.txt\n"), "got: {stdout}");
		}

		/// A two-file comparison has no header at all: the line introduces one
		/// pair among several, so a single pair does not get one. This is the
		/// non-vacuity twin for every header case above.
		#[test]
		fn a_two_file_comparison_has_no_pair_header() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a.txt"), "x\n").unwrap();
			fs::write(root.join("b.txt"), "y\n").unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-r", "a.txt", "b.txt"]);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "--- a.txt\n+++ b.txt\n@@ -1 +1 @@\n-x\n+y\n");
		}

		/// Brief and binary output replace the whole pair record, header
		/// included, which is what GNU prints for the same trees.
		#[test]
		fn brief_and_binary_pairs_carry_no_header() {
			let (_dir, root) = canonical_tempdir();
			for side in ["p", "q"] {
				fs::create_dir_all(root.join(side)).unwrap();
			}
			fs::write(root.join("p/x.bin"), b"aa\x00bb").unwrap();
			fs::write(root.join("q/x.bin"), b"aa\x00cc").unwrap();
			fs::write(root.join("p/t.txt"), "x\n").unwrap();
			fs::write(root.join("q/t.txt"), "y\n").unwrap();

			let (code, stdout, stderr) = run_in(root.clone(), vec!["-r", "-q", "p", "q"]);
			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "Files p/t.txt and q/t.txt differ\nFiles p/x.bin and q/x.bin differ\n");

			let (code, stdout, stderr) = run_in(root, vec!["-r", "p", "q"]);
			assert_eq!(code, 1, "{stderr}");
			assert!(
				stdout.starts_with("diff -r p/t.txt q/t.txt\n--- p/t.txt\n"),
				"the text pair keeps its header: {stdout}"
			);
			assert!(
				stdout.ends_with("Binary files p/x.bin and q/x.bin differ\n"),
				"the binary pair does not: {stdout}"
			);
		}

		/// The quoting rule itself, at the unit level, so its boundary is pinned
		/// rather than inferred from the two options that happen to be tested
		/// above. `=` is outside the safe set, which is what makes GNU quote
		/// `--color=never`, and an empty argument stays visible.
		#[test]
		fn the_quoting_rule_covers_its_boundary() {
			for (arg, expected) in [
				("-r", "-r"),
				("-ru", "-ru"),
				("3", "3"),
				("--unified", "--unified"),
				("a.txt", "a.txt"),
				("p/s/i.txt", "p/s/i.txt"),
				("a,b", "a,b"),
				("--color=never", "'--color=never'"),
				("with space", "'with space'"),
				("", "''"),
				("it's", r"'it'\''s'"),
			] {
				assert_eq!(shell_quote(arg), expected, "for {arg:?}");
			}
		}
	}

	#[test]
	fn help_renders_to_scope_stdout() {
		let (code, stdout, stderr) = run_in(PathBuf::from("."), vec!["--help"]);
		assert_eq!(code, 0);
		assert!(stdout.contains("Usage:"));
		assert!(stdout.contains("Compare files line by line"));
		assert_eq!(stderr, "");
	}
	/// The three flags that control WHAT IS SAID rather than how lines compare.
	///
	/// WHY THIS SUITE EXISTS. This builtin accepted six flags: `-u`, `-U N`,
	/// `-q`, `-r`, `-N` and `--color`. Everything else was a hard parse error,
	/// exit 2, so `diff -s`, `diff -a` and `diff --label` failed outright
	/// rather than doing anything. Those three are pure output control and need
	/// no change to how lines are compared, which is why they land together:
	///
	/// - `-s` is the ONLY way to learn that two files are the same. Without it
	///   `diff` prints nothing and exits 0, which a caller cannot tell apart
	///   from a run that never happened.
	/// - `-a` forces the text path for a file holding a NUL, instead of `Binary
	///   files A and B differ`.
	/// - `--label` renames the `---` and `+++` headers, which is what makes a
	///   diff of two temporary files readable.
	///
	/// PROBED AGAINST GNU DIFF 3.10 for each, including the parts that are not
	/// guessable: `-s` names the OPERANDS and not the labels, a single `--label`
	/// renames only the LEFT side, and a THIRD `--label` is an error with the
	/// exact message `too many file label options` and exit 2 rather than being
	/// ignored.
	mod flags_that_only_change_what_is_said {
		use super::*;

		/// `-s` on identical files, and the exit code staying 0. The message is
		/// asserted in full because it is the entire output of the run.
		#[test]
		fn report_identical_says_so_and_still_exits_zero() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
			fs::write(root.join("b.txt"), "one\ntwo\n").unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-s", "a.txt", "b.txt"]);

			assert_eq!(code, 0, "identical files are not a difference");
			assert_eq!(stdout, "Files a.txt and b.txt are identical\n");
			assert_eq!(stderr, "");
		}

		/// THE CONTRAST that makes the flag worth having: without `-s` the same
		/// run says nothing at all, so the exit code is the only signal.
		#[test]
		fn without_the_flag_identical_files_still_say_nothing() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
			fs::write(root.join("b.txt"), "one\ntwo\n").unwrap();

			let (code, stdout, _) = run_in(root, vec!["a.txt", "b.txt"]);

			assert_eq!((code, stdout.as_str()), (0, ""));
		}

		/// `-s` changes NOTHING when the files differ: it adds a message for the
		/// identical case and does not touch the diff. A flag that also altered
		/// the differing case would be a silent format change for every caller
		/// that passes it defensively.
		#[test]
		fn report_identical_does_not_touch_a_real_diff() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a.txt"), "one\n").unwrap();
			fs::write(root.join("b.txt"), "two\n").unwrap();

			let (with, plain) = (
				run_in(root.clone(), vec!["-s", "a.txt", "b.txt"]),
				run_in(root, vec!["a.txt", "b.txt"]),
			);

			assert_eq!(with.0, 1);
			assert_eq!(with.1, plain.1, "-s must be invisible when the files differ");
			assert!(with.1.starts_with("--- a.txt\n+++ b.txt\n"), "got: {}", with.1);
		}

		/// `-s` works with `-q`, which is the combination a script uses: ask only
		/// whether the files match and get a sentence either way.
		#[test]
		fn report_identical_pairs_with_brief() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("same_a.txt"), "x\n").unwrap();
			fs::write(root.join("same_b.txt"), "x\n").unwrap();
			fs::write(root.join("diff_b.txt"), "y\n").unwrap();

			let (same_code, same_out, _) =
				run_in(root.clone(), vec!["-s", "-q", "same_a.txt", "same_b.txt"]);
			assert_eq!(
				(same_code, same_out.as_str()),
				(0, "Files same_a.txt and same_b.txt are identical\n")
			);

			let (differ_code, differ_out, _) =
				run_in(root, vec!["-s", "-q", "same_a.txt", "diff_b.txt"]);
			assert_eq!(
				(differ_code, differ_out.as_str()),
				(1, "Files same_a.txt and diff_b.txt differ\n")
			);
		}

		/// In DIRECTORY mode `-s` reports every common entry that matches, with
		/// the joined paths, interleaved with the diffs of the entries that do
		/// not. This is the mode `-s` is actually useful in and it exercises
		/// the same pair function through a different caller.
		#[test]
		fn report_identical_names_matching_entries_in_directory_mode() {
			let (_dir, root) = canonical_tempdir();
			fs::create_dir(root.join("da")).unwrap();
			fs::create_dir(root.join("db")).unwrap();
			fs::write(root.join("da/x.txt"), "same\n").unwrap();
			fs::write(root.join("db/x.txt"), "same\n").unwrap();
			fs::write(root.join("da/y.txt"), "p\n").unwrap();
			fs::write(root.join("db/y.txt"), "q\n").unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-s", "-u", "da", "db"]);

			assert_eq!(code, 1, "one entry differs");
			assert_eq!(stderr, "");
			assert!(
				stdout.starts_with("Files da/x.txt and db/x.txt are identical\n"),
				"the matching entry is named first: {stdout}"
			);
			assert!(stdout.contains("diff -s -u da/y.txt db/y.txt\n"), "got: {stdout}");
			assert!(stdout.contains("-p\n+q\n"), "and the differing entry is diffed: {stdout}");
		}

		/// `--label` replaces both headers when given twice, and the file names
		/// appear NOWHERE in the output, which is the point: it exists so a diff
		/// of two temporary paths can be shown with the names the reader knows.
		#[test]
		fn two_labels_replace_both_headers() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a.txt"), "one\n").unwrap();
			fs::write(root.join("b.txt"), "two\n").unwrap();

			let (code, stdout, _) =
				run_in(root, vec!["-u", "--label", "LEFT", "--label", "RIGHT", "a.txt", "b.txt"]);

			assert_eq!(code, 1);
			assert!(stdout.starts_with("--- LEFT\n+++ RIGHT\n"), "got: {stdout}");
			assert!(!stdout.contains("a.txt"), "the real names must be gone: {stdout}");
			assert!(!stdout.contains("b.txt"), "the real names must be gone: {stdout}");
		}

		/// ONE `--label` renames only the LEFT side and leaves the right as the
		/// file name. Positional and asymmetric, which is GNU's rule and the
		/// obvious thing to get wrong: applying a lone label to both sides, or
		/// to neither, both look reasonable.
		#[test]
		fn a_single_label_renames_only_the_left_side() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a.txt"), "one\n").unwrap();
			fs::write(root.join("b.txt"), "two\n").unwrap();

			let (_, stdout, _) = run_in(root, vec!["-u", "--label", "ONLY", "a.txt", "b.txt"]);

			assert!(stdout.starts_with("--- ONLY\n+++ b.txt\n"), "got: {stdout}");
		}

		/// A THIRD label is refused rather than ignored, with GNU's wording and
		/// its exit code. Dropping the extra silently would compare the right
		/// files while labelling them something the user did not choose, which
		/// is the worst of the three possible behaviours.
		#[test]
		fn a_third_label_is_an_error_and_not_ignored() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a.txt"), "one\n").unwrap();
			fs::write(root.join("b.txt"), "two\n").unwrap();

			let (code, stdout, stderr) = run_in(root, vec![
				"-u", "--label", "A", "--label", "B", "--label", "C", "a.txt", "b.txt",
			]);

			assert_eq!(code, 2, "a usage error, not a difference");
			assert_eq!(stdout, "", "nothing is compared");
			assert_eq!(stderr, "diff: too many file label options\n");
		}

		/// `--label` does not affect the `-q` or `-s` sentences, which name the
		/// OPERANDS. GNU renames the headers of a diff, and neither of those
		/// lines is a header.
		#[test]
		fn labels_do_not_rename_the_brief_or_identical_sentences() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a.txt"), "one\n").unwrap();
			fs::write(root.join("b.txt"), "two\n").unwrap();
			fs::write(root.join("c.txt"), "one\n").unwrap();

			let (_, brief, _) =
				run_in(root.clone(), vec!["-q", "--label", "L", "--label", "R", "a.txt", "b.txt"]);
			assert_eq!(brief, "Files a.txt and b.txt differ\n");

			let (_, identical, _) =
				run_in(root, vec!["-s", "--label", "L", "--label", "R", "a.txt", "c.txt"]);
			assert_eq!(identical, "Files a.txt and c.txt are identical\n");
		}

		/// `-a` diffs a file holding a NUL as text instead of reporting it
		/// binary. Both halves are asserted against the same fixture, because
		/// the flag's whole meaning is the difference between the two outputs.
		#[test]
		fn text_forces_a_real_diff_of_a_file_holding_a_nul() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a.bin"), b"aa\x00bb\n").unwrap();
			fs::write(root.join("b.bin"), b"aa\x00cc\n").unwrap();

			let (code, binary, _) = run_in(root.clone(), vec!["-u", "a.bin", "b.bin"]);
			assert_eq!(code, 1);
			assert_eq!(binary, "Binary files a.bin and b.bin differ\n");

			let (text_code, text, stderr) = run_in(root, vec!["-u", "-a", "a.bin", "b.bin"]);
			assert_eq!(text_code, 1);
			assert_eq!(stderr, "");
			assert!(text.starts_with("--- a.bin\n+++ b.bin\n"), "got: {text:?}");
			assert!(text.contains("-aa\u{0}bb\n"), "the NUL line is shown as text: {text:?}");
			assert!(text.contains("+aa\u{0}cc\n"), "got: {text:?}");
		}

		/// `-a` does not change a file that was already text, so passing it
		/// defensively is free. Byte-identical output is the assertion.
		#[test]
		fn text_leaves_an_ordinary_diff_untouched() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
			fs::write(root.join("b.txt"), "one\nthree\n").unwrap();

			let plain = run_in(root.clone(), vec!["-u", "a.txt", "b.txt"]);
			let forced = run_in(root, vec!["-u", "-a", "a.txt", "b.txt"]);

			assert_eq!(forced.0, plain.0);
			assert_eq!(forced.1, plain.1, "-a is invisible on text input");
		}

		/// `-a` still reports two IDENTICAL binary files as identical rather than
		/// diffing them, because the equality check happens first and does not
		/// care what the bytes look like. With `-s` that is an observable
		/// sentence.
		#[test]
		fn text_does_not_make_identical_binaries_differ() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a.bin"), b"aa\x00bb\n").unwrap();
			fs::write(root.join("b.bin"), b"aa\x00bb\n").unwrap();

			let (code, stdout, _) = run_in(root, vec!["-u", "-a", "-s", "a.bin", "b.bin"]);

			assert_eq!(code, 0);
			assert_eq!(stdout, "Files a.bin and b.bin are identical\n");
		}
	}
	/// Comparing two files does not require loading them.
	///
	/// WHY THIS SUITE EXISTS. Both operands were read end to end with `fs::read`
	/// before anything was compared, so the amount of memory a comparison used
	/// was the size of the two inputs. That costs nothing on a source file and
	/// is wrong at scale in two places that matter: `diff -q` over two large
	/// files allocated both of them to print ONE SENTENCE, and `diff -r` over
	/// two trees allocated every pair it was about to report as identical,
	/// which in a real tree is most of them.
	///
	/// Length settles it for free whenever the sizes differ, since two files of
	/// different sizes cannot be equal, and equal sizes need only a fixed window
	/// per side. Content is loaded at the point a unified diff is actually going
	/// to be printed, and nowhere earlier.
	///
	/// These cases pin the OBSERVABLE contract, because "did it allocate" is not
	/// something a test can see directly: identical and brief comparisons work
	/// on inputs far larger than any buffer, a short read partway through a
	/// file is followed rather than mistaken for the end, and every existing
	/// output is byte-identical.
	mod comparing_files_does_not_load_them {
		use super::*;

		/// Multi-megabyte identical files compare equal, which exercises many
		/// windows rather than one, and a `-s` run says so.
		#[test]
		fn identical_files_larger_than_the_window_compare_equal() {
			let (_dir, root) = canonical_tempdir();
			// 3 MiB, which is many times COMPARE_CHUNK, and deliberately NOT a
			// multiple of it so the final window is partial.
			let body = "abcdefgh\n".repeat(3 * 1024 * 1024 / 9 + 7);
			fs::write(root.join("a.txt"), &body).unwrap();
			fs::write(root.join("b.txt"), &body).unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-s", "a.txt", "b.txt"]);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "Files a.txt and b.txt are identical\n");
		}

		/// A difference in the LAST window is found, which is the case a
		/// comparison that stopped after one buffer would get wrong. It would
		/// report two large files as identical, the worst possible wrong answer.
		#[test]
		fn a_difference_in_the_final_window_is_still_found() {
			let (_dir, root) = canonical_tempdir();
			let prefix = "x".repeat(200_000);
			fs::write(root.join("a.txt"), format!("{prefix}left\n")).unwrap();
			fs::write(root.join("b.txt"), format!("{prefix}right\n")).unwrap();

			let (code, stdout, _) = run_in(root, vec!["-q", "a.txt", "b.txt"]);

			assert_eq!(code, 1, "the files differ");
			assert_eq!(stdout, "Files a.txt and b.txt differ\n");
		}

		/// A difference at the very FIRST byte is found too, so the length
		/// shortcut has not replaced the content comparison for equal-size files.
		#[test]
		fn equal_sizes_with_different_content_are_not_called_equal() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a.txt"), "one\n").unwrap();
			fs::write(root.join("b.txt"), "two\n").unwrap();

			let (code, stdout, _) = run_in(root, vec!["-q", "-s", "a.txt", "b.txt"]);

			assert_eq!(code, 1);
			assert_eq!(stdout, "Files a.txt and b.txt differ\n", "same length, different bytes");
		}

		/// Two EMPTY files are equal, the degenerate case where the first window
		/// returns nothing and the loop must conclude equality rather than spin.
		#[test]
		fn two_empty_files_are_identical() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a.txt"), "").unwrap();
			fs::write(root.join("b.txt"), "").unwrap();

			let (code, stdout, _) = run_in(root, vec!["-s", "a.txt", "b.txt"]);

			assert_eq!((code, stdout.as_str()), (0, "Files a.txt and b.txt are identical\n"));
		}

		/// An empty file against a one-byte file differs, decided by length
		/// alone.
		#[test]
		fn an_empty_file_differs_from_a_non_empty_one() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a.txt"), "").unwrap();
			fs::write(root.join("b.txt"), "x").unwrap();

			let (code, stdout, _) = run_in(root, vec!["-q", "a.txt", "b.txt"]);

			assert_eq!((code, stdout.as_str()), (1, "Files a.txt and b.txt differ\n"));
		}

		/// STDIN still works, and is the one operand that must be captured up
		/// front: it cannot be re-read, so a lazy source would consume it during
		/// the equality check and have nothing left to diff. Both outcomes are
		/// asserted on the same shape of input.
		#[test]
		fn stdin_is_captured_up_front_and_still_diffs() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("b.txt"), "one\ntwo\n").unwrap();

			let (same_code, same_out, _) =
				run_with(root.clone(), b"one\ntwo\n", vec!["-s", "-", "b.txt"]);
			assert_eq!((same_code, same_out.as_str()), (0, "Files - and b.txt are identical\n"));

			let (differ_code, differ_out, stderr) =
				run_with(root, b"one\nthree\n", vec!["-u", "-", "b.txt"]);
			assert_eq!(differ_code, 1, "{stderr}");
			assert!(differ_out.starts_with("--- -\n+++ b.txt\n"), "got: {differ_out}");
			assert!(
				differ_out.contains("-three\n"),
				"the captured stdin is still diffable: {differ_out}"
			);
			assert!(differ_out.contains("+two\n"), "got: {differ_out}");
		}

		/// `-N` compares a present file against an absent one, where the absent
		/// side owns no bytes at all. An EMPTY present file is then equal to it,
		/// which is the boundary between "absent means empty" and "absent means
		/// different".
		#[test]
		fn a_present_empty_file_equals_an_absent_one_under_new_file() {
			let (_dir, root) = canonical_tempdir();
			fs::create_dir(root.join("da")).unwrap();
			fs::create_dir(root.join("db")).unwrap();
			fs::write(root.join("da/empty.txt"), "").unwrap();
			fs::write(root.join("da/full.txt"), "content\n").unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-N", "-u", "da", "db"]);

			assert_eq!(stderr, "");
			assert_eq!(code, 1, "full.txt differs from an absent empty file");
			assert!(
				!stdout.contains("empty.txt"),
				"an empty file equals an absent one, so it is not reported: {stdout}"
			);
			assert!(stdout.contains("da/full.txt"), "and the non-empty one is: {stdout}");
			assert!(stdout.contains("-content\n"), "got: {stdout}");
		}

		/// The directory walk, which is the hot path: a tree of identical entries
		/// exits 0 and, under `-s`, names each one. Several entries make it a
		/// walk rather than a single pair.
		#[test]
		fn a_tree_of_identical_entries_compares_equal_entry_by_entry() {
			let (_dir, root) = canonical_tempdir();
			fs::create_dir(root.join("da")).unwrap();
			fs::create_dir(root.join("db")).unwrap();
			for name in ["one.txt", "two.txt", "three.txt"] {
				fs::write(root.join("da").join(name), format!("body of {name}\n")).unwrap();
				fs::write(root.join("db").join(name), format!("body of {name}\n")).unwrap();
			}

			let (code, stdout, stderr) = run_in(root, vec!["-s", "-r", "da", "db"]);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout,
				"Files da/one.txt and db/one.txt are identical\nFiles da/three.txt and db/three.txt \
				 are identical\nFiles da/two.txt and db/two.txt are identical\n",
				"sorted by name, one line each"
			);
		}

		/// A file that cannot be OPENED is still reported against the name as
		/// typed, not against the resolved path, and the run exits 2. The lazy
		/// source has to carry that reporting responsibility, which it did not
		/// before, because the read used to happen at the call site.
		#[test]
		fn an_unreadable_operand_is_reported_against_the_typed_name() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a.txt"), "one\n").unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-q", "a.txt", "missing.txt"]);

			assert_eq!(code, 2, "trouble, not a difference");
			assert_eq!(stdout, "");
			assert!(
				stderr.starts_with("diff: missing.txt: "),
				"the typed name leads the diagnostic: {stderr}"
			);
		}
	}
	/// How far into a file a NUL still means "binary".
	///
	/// WHY THIS SUITE EXISTS. The window was 8 KiB with a comment claiming it
	/// matched GNU diff. MEASURED against GNU diff 3.10, it does not: GNU sniffs
	/// whatever its first read returned, which is the filesystem block size, so
	/// on a 4 KiB-block filesystem a NUL at offset 4095 makes a file binary and
	/// one at 4096 does not. Our extra 4 KiB erred in the direction that costs
	/// the user something real: a file with a NUL between 4 KiB and 8 KiB in
	/// got `Binary files A and B differ` from us and a full unified diff from
	/// GNU, so the diff was REFUSED rather than merely formatted differently.
	///
	/// The window is now fixed at 4 KiB. Fixed rather than read from the
	/// filesystem on purpose, because GNU's boundary is an artifact of its
	/// buffering and a tool whose verdict depends on which disk the input sits
	/// on is worse than one that is slightly wrong in a stated way.
	mod the_binary_sniff_window_is_four_kilobytes {
		use super::*;

		/// Build a pair that is identical up to and including a NUL at `offset`,
		/// then differs, and is comfortably larger than any window.
		fn pair_with_nul_at(root: &Path, offset: usize) {
			let mut a = vec![b'x'; offset];
			a.push(0);
			let mut b = a.clone();
			a.extend(std::iter::repeat_n(b'y', 60_000));
			b.extend(std::iter::repeat_n(b'z', 60_000));
			fs::write(root.join("p.bin"), &a).unwrap();
			fs::write(root.join("q.bin"), &b).unwrap();
		}

		/// THE BOUNDARY, both sides of it, as GNU draws it: 4095 is binary and
		/// 4096 is text. Asserted as the two different OUTPUTS, not as a
		/// constant, so the test fails if the window moves rather than if a
		/// number is renamed.
		#[test]
		fn a_nul_just_inside_the_window_is_binary_and_just_outside_is_text() {
			let (_dir, root) = canonical_tempdir();

			pair_with_nul_at(&root, 4095);
			let (code, inside, _) = run_in(root.clone(), vec!["-u", "p.bin", "q.bin"]);
			assert_eq!(code, 1);
			assert_eq!(inside, "Binary files p.bin and q.bin differ\n", "4095 is inside");

			pair_with_nul_at(&root, 4096);
			let (code, outside, stderr) = run_in(root, vec!["-u", "p.bin", "q.bin"]);
			assert_eq!(code, 1, "{stderr}");
			assert!(
				outside.starts_with("--- p.bin\n+++ q.bin\n"),
				"4096 is outside, so a real diff is produced: {outside:?}"
			);
		}

		/// THE REGRESSION THIS FIXES: a NUL between the old 8 KiB window and the
		/// new 4 KiB one now produces a diff, where before it produced a
		/// refusal. 5000 is the offset GNU was measured at.
		#[test]
		fn a_nul_between_four_and_eight_kilobytes_now_produces_a_diff() {
			let (_dir, root) = canonical_tempdir();
			pair_with_nul_at(&root, 5000);

			let (code, stdout, stderr) = run_in(root, vec!["-u", "p.bin", "q.bin"]);

			assert_eq!(code, 1, "{stderr}");
			assert!(
				!stdout.starts_with("Binary"),
				"GNU diffs this file, so we must too: {}",
				&stdout[..stdout.len().min(80)]
			);
			assert!(stdout.starts_with("--- p.bin\n+++ q.bin\n"), "got: {stdout:?}");
		}

		/// A NUL near the START is still binary, so the window has not been
		/// widened into uselessness. This is the ordinary case: a real binary
		/// has NULs in its first bytes.
		#[test]
		fn a_nul_at_the_start_is_still_binary() {
			let (_dir, root) = canonical_tempdir();
			pair_with_nul_at(&root, 4);

			let (code, stdout, _) = run_in(root, vec!["-u", "p.bin", "q.bin"]);

			assert_eq!((code, stdout.as_str()), (1, "Binary files p.bin and q.bin differ\n"));
		}

		/// `-a` overrides the verdict on BOTH sides of the boundary, which is
		/// what makes the fixed window safe: a user who disagrees with it has a
		/// flag.
		#[test]
		fn text_overrides_the_verdict_wherever_the_nul_sits() {
			let (_dir, root) = canonical_tempdir();
			pair_with_nul_at(&root, 4);

			let (code, stdout, stderr) = run_in(root, vec!["-u", "-a", "p.bin", "q.bin"]);

			assert_eq!(code, 1, "{stderr}");
			assert!(stdout.starts_with("--- p.bin\n+++ q.bin\n"), "got: {stdout:?}");
		}

		/// A file with NO NUL at all is text however large it is, so the sniff is
		/// not reporting on the window's contents in general, only on NULs.
		#[test]
		fn a_large_file_with_no_nul_is_text() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("p.bin"), "line\n".repeat(20_000)).unwrap();
			fs::write(root.join("q.bin"), format!("{}changed\n", "line\n".repeat(19_999))).unwrap();

			let (code, stdout, _) = run_in(root, vec!["-u", "p.bin", "q.bin"]);

			assert_eq!(code, 1);
			assert!(stdout.starts_with("--- p.bin\n+++ q.bin\n"), "got: {stdout:?}");
		}
	}
	/// Byte-exact pins on the unified output.
	///
	/// WHY THIS SUITE EXISTS. The formatter used to be `similar`'s `UnifiedDiff`
	/// and was replaced by a hand-written one, because supporting the flags that
	/// change how two lines COMPARE (`-i`, `-w`, `-b`, `-Z`, `-E`) means diffing
	/// comparison KEYS while printing ORIGINAL bytes, and `similar` has no hook
	/// for that. These cases were written against the OLD formatter and passed
	/// unchanged against the new one, which is what makes the replacement
	/// provably identical everywhere no ignore flag is given.
	///
	/// Every assertion is the whole stdout as bytes. Nothing here checks a
	/// shape.
	mod the_unified_format_is_pinned_byte_for_byte {
		use super::*;

		/// A hunk of exactly one changed line uses the SHORT range form, `@@ -1
		/// +1 @@` with no length, which is the case a naive `start,len`
		/// formatter gets wrong.
		#[test]
		fn a_single_line_file_uses_the_short_range_form() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a"), "one\n").unwrap();
			fs::write(root.join("b"), "two\n").unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-u", "a", "b"]);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "--- a\n+++ b\n@@ -1 +1 @@\n-one\n+two\n");
		}

		/// An EMPTY side produces a zero-length range, which GNU and `similar`
		/// both print as `-0,0`: the beginning is pulled back one line because
		/// there is no line to point at.
		#[test]
		fn an_empty_side_produces_a_zero_length_range() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a"), "").unwrap();
			fs::write(root.join("b"), "x\ny\n").unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-u", "a", "b"]);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "--- a\n+++ b\n@@ -0,0 +1,2 @@\n+x\n+y\n");
		}

		/// A missing final newline on the LEFT gets the marker after the deleted
		/// line.
		#[test]
		fn a_missing_final_newline_on_the_left_is_marked() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a"), "a\nb").unwrap();
			fs::write(root.join("b"), "a\nb\n").unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-u", "a", "b"]);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(
				stdout,
				"--- a\n+++ b\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n"
			);
		}

		/// The same on the RIGHT, where the marker lands last and the file
		/// therefore ends with it rather than with a diff line.
		#[test]
		fn a_missing_final_newline_on_the_right_is_marked() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a"), "a\nb\n").unwrap();
			fs::write(root.join("b"), "a\nb").unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-u", "a", "b"]);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(
				stdout,
				"--- a\n+++ b\n@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file\n"
			);
		}

		/// BOTH sides missing it, with the last line actually changed, so the
		/// marker appears twice in one hunk.
		#[test]
		fn both_sides_missing_the_final_newline_are_marked_twice() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a"), "a\nb").unwrap();
			fs::write(root.join("b"), "a\nc").unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-u", "a", "b"]);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(
				stdout,
				"--- a\n+++ b\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No \
				 newline at end of file\n"
			);
		}

		/// A file with no final newline whose last line is CONTEXT still carries
		/// the marker, so the marker follows the line rather than the change.
		#[test]
		fn a_context_line_without_a_final_newline_is_marked() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a"), "old\ntail").unwrap();
			fs::write(root.join("b"), "new\ntail").unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-u", "a", "b"]);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(
				stdout,
				"--- a\n+++ b\n@@ -1,2 +1,2 @@\n-old\n+new\n tail\n\\ No newline at end of file\n"
			);
		}

		/// TWO hunks, far enough apart that the shared middle is not merged into
		/// one. This pins the rule that the `---`/`+++` header is printed ONCE,
		/// before the first hunk, and not once per hunk.
		#[test]
		fn two_distant_changes_make_two_hunks_under_one_header() {
			let (_dir, root) = canonical_tempdir();
			let old: String = (1..=20).map(|i| format!("l{i}\n")).collect();
			let new = old.replace("l2\n", "L2\n").replace("l19\n", "L19\n");
			fs::write(root.join("a"), &old).unwrap();
			fs::write(root.join("b"), &new).unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-u", "a", "b"]);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(
				stdout,
				"--- a\n+++ b\n@@ -1,5 +1,5 @@\n l1\n-l2\n+L2\n l3\n l4\n l5\n@@ -16,5 +16,5 @@\n \
				 l16\n l17\n l18\n-l19\n+L19\n l20\n"
			);
		}

		/// A file of 250 lines, which is long enough for the alignment to split
		/// the region several times.
		///
		/// The reason has changed and the case has not: it was written when the
		/// alignment was `similar`'s, whose internal representation switches
		/// around 100 lines, and it now covers `compareseq` recursing through a
		/// region far larger than any other case here. Both are the same
		/// question, whether the formatter is handed the ops it expects once
		/// the comparison is doing more than one step.
		#[test]
		fn a_file_over_a_hundred_lines_still_diffs_the_same() {
			let (_dir, root) = canonical_tempdir();
			let old: String = (1..=250).map(|i| format!("line {i}\n")).collect();
			let new = old.replace("line 125\n", "LINE 125\n");
			fs::write(root.join("a"), &old).unwrap();
			fs::write(root.join("b"), &new).unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-u", "a", "b"]);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(
				stdout,
				"--- a\n+++ b\n@@ -122,7 +122,7 @@\n line 122\n line 123\n line 124\n-line 125\n+LINE \
				 125\n line 126\n line 127\n line 128\n"
			);
		}

		/// `-U 0` drops context entirely, so each change is its own hunk and the
		/// ranges are the changed lines alone.
		#[test]
		fn zero_context_makes_one_hunk_per_change() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a"), "keep\ndrop\nkeep2\n").unwrap();
			fs::write(root.join("b"), "keep\nkeep2\nadd\n").unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-U", "0", "a", "b"]);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "--- a\n+++ b\n@@ -2 +1,0 @@\n-drop\n@@ -3,0 +3 @@\n+add\n");
		}

		/// A CRLF file: the `\r` belongs to the line, so it is printed back and
		/// the line count is the number of `\n` bytes.
		#[test]
		fn carriage_returns_stay_inside_the_line() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a"), "one\r\ntwo\r\n").unwrap();
			fs::write(root.join("b"), "one\r\n2\r\n").unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-u", "a", "b"]);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "--- a\n+++ b\n@@ -1,2 +1,2 @@\n one\r\n-two\r\n+2\r\n");
		}

		/// A LONE `\r` is NOT a line terminator. GNU diff 3.10 splits on `\n`
		/// only, so `a\rb` is ONE line and the hunk reads `@@ -1 +1 @@`.
		/// `similar`'s line tokenizer disagrees and treats a bare `\r` as a
		/// break, which made this input print a two-line hunk that GNU never
		/// produces. The hand-written splitter is what fixes it.
		#[test]
		fn a_lone_carriage_return_does_not_start_a_line() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a"), "a\rb\n").unwrap();
			fs::write(root.join("b"), "a\rc\n").unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-u", "a", "b"]);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "--- a\n+++ b\n@@ -1 +1 @@\n-a\rb\n+a\rc\n");
		}

		/// `--label` reaches the pinned header, so the two are not independently
		/// formatted paths.
		#[test]
		fn labels_replace_the_header_names_in_the_pinned_output() {
			let (_dir, root) = canonical_tempdir();
			fs::write(root.join("a"), "x\n").unwrap();
			fs::write(root.join("b"), "y\n").unwrap();

			let (code, stdout, stderr) =
				run_in(root, vec!["-u", "--label", "L", "--label", "R", "a", "b"]);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "--- L\n+++ R\n@@ -1 +1 @@\n-x\n+y\n");
		}
	}
	/// The six flags that change how two lines COMPARE, driven through the real
	/// argument surface.
	///
	/// WHY THIS SUITE EXISTS. These flags used to be rejected outright, which
	/// made `diff -w` a hard error on a tool that otherwise looks like GNU
	/// diff. Every expectation here was captured from GNU diffutils 3.10 rather
	/// than derived, because the flags are close enough to each other that
	/// reasoning about them gets the boundaries wrong: `-b` and `-w` differ
	/// only over a space that appears from nothing, `-Z` and `-b` differ only
	/// over internal spacing, and `-B` is hunk-level where the other five are
	/// line-level.
	///
	/// The unit-level behaviour of the transform lives beside it in
	/// `unified::tests`. This suite proves the flags REACH it and that the
	/// verdict, the exit code, and the printed bytes all agree.
	mod comparison_flags_change_equality_and_not_output {
		use super::*;

		fn pair(root: &Path, left: &str, right: &str) {
			fs::write(root.join("a"), left).unwrap();
			fs::write(root.join("b"), right).unwrap();
		}

		/// `-i` folds case, so two files differing only in case are identical and
		/// the run exits 0 with nothing printed.
		#[test]
		fn ignore_case_makes_a_case_only_difference_disappear() {
			let (_dir, root) = canonical_tempdir();
			pair(&root, "Hello\nWorld\n", "hello\nworld\n");

			let (code, stdout, stderr) = run_in(root.clone(), vec!["-u", "-i", "a", "b"]);
			assert_eq!((code, stdout.as_str()), (0, ""), "{stderr}");

			let (code, stdout, _) = run_in(root, vec!["-u", "a", "b"]);
			assert_eq!(code, 1, "without -i the same pair differs");
			assert_eq!(stdout, "--- a\n+++ b\n@@ -1,2 +1,2 @@\n-Hello\n-World\n+hello\n+world\n");
		}

		/// The long form reaches the same flag, so `--ignore-case` is not a
		/// second unwired spelling.
		#[test]
		fn the_long_spellings_reach_the_same_flags() {
			let (_dir, root) = canonical_tempdir();
			pair(&root, "A\n", "a\n");

			for spelling in ["-i", "--ignore-case"] {
				let (code, stdout, stderr) = run_in(root.clone(), vec!["-u", spelling, "a", "b"]);
				assert_eq!((code, stdout.as_str()), (0, ""), "{spelling}: {stderr}");
			}
		}

		/// `-w` ignores whitespace ENTIRELY, so a space that was not there before
		/// is not a difference either.
		#[test]
		fn ignore_all_space_hides_a_space_that_appeared() {
			let (_dir, root) = canonical_tempdir();
			pair(&root, "ab\n", "a b\n");

			for spelling in ["-w", "--ignore-all-space"] {
				let (code, stdout, stderr) = run_in(root.clone(), vec!["-u", spelling, "a", "b"]);
				assert_eq!((code, stdout.as_str()), (0, ""), "{spelling}: {stderr}");
			}
		}

		/// `-b` does NOT hide that space, which is the single case that tells
		/// `-b` and `-w` apart. GNU 3.10 exits 1 here and 0 for `-w`.
		#[test]
		fn ignore_space_change_keeps_a_space_that_appeared() {
			let (_dir, root) = canonical_tempdir();
			pair(&root, "ab\n", "a b\n");

			let (code, stdout, stderr) = run_in(root.clone(), vec!["-u", "-b", "a", "b"]);
			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "--- a\n+++ b\n@@ -1 +1 @@\n-ab\n+a b\n");

			pair(&root, "a  b\n", "a b\n");
			let (code, stdout, stderr) = run_in(root, vec!["-u", "-b", "a", "b"]);
			assert_eq!((code, stdout.as_str()), (0, ""), "a run that only GREW is hidden: {stderr}");
		}

		/// `-Z` reaches the end of the line and no further: trailing whitespace
		/// is hidden and internal whitespace is not.
		#[test]
		fn ignore_trailing_space_stops_at_the_line_end() {
			let (_dir, root) = canonical_tempdir();
			pair(&root, "trail   \nsame\n", "trail\nsame\n");
			let (code, stdout, stderr) = run_in(root.clone(), vec!["-u", "-Z", "a", "b"]);
			assert_eq!((code, stdout.as_str()), (0, ""), "{stderr}");

			pair(&root, "a  b\n", "a b\n");
			let (code, stdout, stderr) = run_in(root, vec!["-u", "-Z", "a", "b"]);
			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "--- a\n+++ b\n@@ -1 +1 @@\n-a  b\n+a b\n");
		}

		/// `-Z` makes a CRLF file equal to the same file with LF endings, because
		/// the `\r` is trailing whitespace. This is the practical reason to
		/// reach for it.
		#[test]
		fn ignore_trailing_space_reconciles_crlf_with_lf() {
			let (_dir, root) = canonical_tempdir();
			pair(&root, "one\r\ntwo\r\n", "one\ntwo\n");

			let (code, stdout, stderr) = run_in(root.clone(), vec!["-u", "-Z", "a", "b"]);
			assert_eq!((code, stdout.as_str()), (0, ""), "{stderr}");

			let (code, ..) = run_in(root, vec!["-u", "a", "b"]);
			assert_eq!(code, 1, "without -Z the line endings are a difference");
		}

		/// `-E` expands tabs to the next 8-column stop, so a tab after one
		/// character equals SEVEN spaces and not eight. Both directions are
		/// asserted because getting the stop arithmetic wrong passes the
		/// eight-space case by accident.
		#[test]
		fn ignore_tab_expansion_uses_eight_column_stops() {
			let (_dir, root) = canonical_tempdir();

			pair(&root, "a\tb\n", "a       b\n");
			let (code, stdout, stderr) = run_in(root.clone(), vec!["-u", "-E", "a", "b"]);
			assert_eq!((code, stdout.as_str()), (0, ""), "seven spaces match: {stderr}");

			pair(&root, "a\tb\n", "a        b\n");
			let (code, _, stderr) = run_in(root.clone(), vec!["-u", "-E", "a", "b"]);
			assert_eq!(code, 1, "eight spaces do NOT match: {stderr}");

			pair(&root, "\ta\n", "        a\n");
			let (code, stdout, stderr) = run_in(root, vec!["-u", "-E", "a", "b"]);
			assert_eq!((code, stdout.as_str()), (0, ""), "a leading tab is eight: {stderr}");
		}

		/// `-B` drops a change made only of blank lines, so the run exits 0 and
		/// prints nothing at all.
		#[test]
		fn ignore_blank_lines_drops_a_blank_only_change() {
			let (_dir, root) = canonical_tempdir();
			pair(&root, "x\n\n\ny\n", "x\ny\n");

			let (code, stdout, stderr) = run_in(root.clone(), vec!["-u", "-B", "a", "b"]);
			assert_eq!((code, stdout.as_str()), (0, ""), "{stderr}");

			let (code, stdout, _) = run_in(root, vec!["-u", "a", "b"]);
			assert_eq!(code, 1, "without -B the blank lines are a difference");
			assert_eq!(stdout, "--- a\n+++ b\n@@ -1,4 +1,2 @@\n x\n-\n-\n y\n");
		}

		/// `-B` is HUNK-level: a hunk that also carries a real change is printed
		/// whole, blank lines included. This is the case that a line-level filter
		/// gets wrong by silently swallowing the blank line from the output.
		#[test]
		fn ignore_blank_lines_prints_a_mixed_hunk_whole() {
			let (_dir, root) = canonical_tempdir();
			pair(&root, "x\n\nold\n", "x\nnew\n");

			let (code, stdout, stderr) = run_in(root, vec!["-u", "-B", "a", "b"]);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "--- a\n+++ b\n@@ -1,3 +1,2 @@\n x\n-\n-old\n+new\n");
		}

		/// A context line prints the LEFT file's ORIGINAL bytes, trailing space
		/// and all, even though the key that matched it had none. This is the
		/// property the whole design exists for.
		#[test]
		fn a_context_line_matched_by_key_still_prints_its_own_bytes() {
			let (_dir, root) = canonical_tempdir();
			pair(&root, "trail \nx\nchanged\n", "trail\nx\nother\n");

			let (code, stdout, stderr) = run_in(root, vec!["-u", "-w", "a", "b"]);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(
				stdout, "--- a\n+++ b\n@@ -1,3 +1,3 @@\n trail \n x\n-changed\n+other\n",
				"the trailing space survives into the context line"
			);
		}

		/// The flags COMPOSE: `-i -w` makes `Hello  World` equal `hello World`,
		/// which neither does alone.
		#[test]
		fn case_and_whitespace_compose() {
			let (_dir, root) = canonical_tempdir();
			pair(&root, "Hello  World\n", "hello World\n");

			let (code, stdout, stderr) = run_in(root.clone(), vec!["-u", "-i", "-w", "a", "b"]);
			assert_eq!((code, stdout.as_str()), (0, ""), "{stderr}");

			for alone in ["-i", "-w"] {
				let (code, ..) = run_in(root.clone(), vec!["-u", alone, "a", "b"]);
				assert_eq!(code, 1, "{alone} alone is not enough");
			}
		}

		/// `-B -w` treats a whitespace-only line as blank, where `-B` alone does
		/// not, because the blank test reads the transformed key. Verified
		/// against GNU 3.10 in both directions.
		#[test]
		fn blank_lines_composes_with_all_space() {
			let (_dir, root) = canonical_tempdir();
			pair(&root, "x\n   \ny\n", "x\ny\n");

			let (code, _, stderr) = run_in(root.clone(), vec!["-q", "-B", "a", "b"]);
			assert_eq!(code, 1, "-B alone sees a non-empty line: {stderr}");

			let (code, stdout, stderr) = run_in(root, vec!["-q", "-B", "-w", "a", "b"]);
			assert_eq!((code, stdout.as_str()), (0, ""), "-w empties it: {stderr}");
		}

		/// `-q` reports the verdict the flags produce rather than the byte
		/// verdict, so a pair that is equal under `-i` prints nothing and exits
		/// 0 even though its bytes differ.
		#[test]
		fn brief_reports_the_verdict_the_flags_produce() {
			let (_dir, root) = canonical_tempdir();
			pair(&root, "A\n", "a\n");

			let (code, stdout, stderr) = run_in(root.clone(), vec!["-q", "-i", "a", "b"]);
			assert_eq!((code, stdout.as_str()), (0, ""), "{stderr}");

			let (code, stdout, _) = run_in(root, vec!["-q", "a", "b"]);
			assert_eq!((code, stdout.as_str()), (1, "Files a and b differ\n"));
		}

		/// `-s` says so too, which is the only way a script learns the difference
		/// between "equal under the flags" and "never compared".
		#[test]
		fn report_identical_covers_equality_the_flags_produced() {
			let (_dir, root) = canonical_tempdir();
			pair(&root, "trail \n", "trail\n");

			let (code, stdout, stderr) = run_in(root, vec!["-s", "-w", "a", "b"]);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "Files a and b are identical\n");
		}

		/// An unterminated last line equals a terminated one under `-Z`, because
		/// GNU counts the missing terminator as trailing whitespace.
		#[test]
		fn a_missing_final_newline_is_trailing_whitespace() {
			let (_dir, root) = canonical_tempdir();
			pair(&root, "a\nb", "a\nb\n");

			let (code, stdout, stderr) = run_in(root.clone(), vec!["-u", "-Z", "a", "b"]);
			assert_eq!((code, stdout.as_str()), (0, ""), "{stderr}");

			let (code, stdout, _) = run_in(root, vec!["-u", "a", "b"]);
			assert_eq!(code, 1);
			assert_eq!(
				stdout,
				"--- a\n+++ b\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n"
			);
		}

		/// BINARY DETECTION BEATS THE FLAGS. Two files with a NUL that are equal
		/// under `-w` still report `Binary files a and b differ` and exit 1,
		/// which is GNU's behaviour: the transform is defined on lines of text
		/// and these are not that. `-a` is the way through.
		#[test]
		fn binary_detection_beats_the_comparison_flags() {
			let (_dir, root) = canonical_tempdir();
			pair(&root, "a\0b \nx\n", "a\0b\nx\n");

			let (code, stdout, stderr) = run_in(root.clone(), vec!["-w", "a", "b"]);
			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "Binary files a and b differ\n");

			let (code, stdout, stderr) = run_in(root.clone(), vec!["-q", "-w", "a", "b"]);
			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "Files a and b differ\n", "-q keeps its own wording for binaries");

			let (code, stdout, stderr) = run_in(root, vec!["-u", "-a", "-w", "a", "b"]);
			assert_eq!((code, stdout.as_str()), (0, ""), "-a lets the flags decide: {stderr}");
		}

		/// The flags reach DIRECTORY mode, and a pair the flags make equal gets
		/// no `diff -r a/f b/f` line, because that line is printed only ahead
		/// of a diff that is coming.
		#[test]
		fn the_flags_reach_directory_mode_and_suppress_its_prefix() {
			let (_dir, root) = canonical_tempdir();
			fs::create_dir(root.join("x")).unwrap();
			fs::create_dir(root.join("y")).unwrap();
			fs::write(root.join("x/same"), "trail \n").unwrap();
			fs::write(root.join("y/same"), "trail\n").unwrap();
			fs::write(root.join("x/real"), "one\n").unwrap();
			fs::write(root.join("y/real"), "two\n").unwrap();

			let (code, stdout, stderr) = run_in(root, vec!["-u", "-w", "x", "y"]);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(
				stdout, "diff -u -w x/real y/real\n--- x/real\n+++ y/real\n@@ -1 +1 @@\n-one\n+two\n",
				"only the pair that really differs is reported"
			);
		}
	}
}
