//! `grep` implemented as an in-process shell builtin on top of the ripgrep
//! libraries (`grep-regex` for the matcher, `grep-searcher` for line scanning),
//! with directory recursion via `veyyon-walker` and `--include` filtering via
//! `globset`. All I/O and path resolution is routed through `veyyon-uutils-ctx`
//! so the builtin writes to the command's redirected file descriptors and
//! resolves relative paths against the shell's working directory.
//!
//! Entry point: [`run`]. It never calls `std::process::exit`; clap
//! help/usage/error output is rendered to the context streams and an exit code
//! is returned following the GNU convention (0 = matched, 1 = no match,
//! 2 = error).
//!
//! # Binary input
//!
//! Two separate rules decide that input is binary, both of them GNU's, and they
//! withhold different amounts of output.
//!
//! A NUL byte makes the whole FILE binary. Every record from that file is
//! withheld, matching lines are still counted, and `grep: FILE: binary file
//! matches` goes to stderr once the file has matched.
//!
//! Text the locale's codeset cannot represent makes a single LINE binary. That
//! line is withheld and counted, later lines in the same file still print, and
//! the file gets the same notice at the end. The codeset comes from `LC_ALL`,
//! then `LC_CTYPE`, then `LANG`, and only a UTF-8 codeset is multibyte, so the
//! same file is binary under `en_US.UTF-8` and plain text under `LC_ALL=C`.
//! What is judged is the bytes about to be printed, not the line they came
//! from, so `grep -o hit bad.bin` prints every `hit` it finds and reports
//! nothing.
//!
//! `-a` and `--binary-files=text` skip both rules and print the bytes.
//! `--binary-files=without-match` withholds the records of a NUL file and gives
//! no notice for either rule.

mod bre;
mod rg;
#[cfg(test)]
mod test_temp;
mod walk_end;

use std::{
	ffi::{OsStr, OsString},
	fs::File,
	io::{self, BufWriter, Read, Write},
	path::{Path, PathBuf},
};

use clap::{ArgMatches, CommandFactory, FromArgMatches, Parser, ValueEnum, parser::ValueSource};
use globset::{Glob, GlobMatcher};
use grep_matcher::{LineTerminator, Matcher};
use grep_pcre2::RegexMatcherBuilder as PcreMatcherBuilder;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{BinaryDetection, Searcher, Sink, SinkContext, SinkFinish, SinkMatch};
pub use rg::{run as run_rg, try_parse_argv as try_parse_rg_argv, uu_app as rg_uu_app};
use veyyon_grep_kernel::{
	CompiledMatcher, SearcherSpec, build_searcher as kernel_build_searcher, escape_literal_pattern,
	pcre_matcher_defaults,
};

#[derive(Parser, Debug)]
#[command(
	name = "grep",
	version = concat!("grep (veyyon-uu-grep) ", env!("CARGO_PKG_VERSION")),
	about = "Search for PATTERN in each FILE or standard input.",
	disable_help_flag = true,
	disable_version_flag = true,
	args_override_self = true
)]
struct Cli {
	/// Use PATTERN for matching (may be repeated; all patterns are OR-ed).
	#[arg(short = 'e', long = "regexp", value_name = "PATTERN")]
	patterns: Vec<String>,

	/// Read patterns from FILE, one per line.
	#[arg(short = 'f', long = "file", value_name = "FILE")]
	pattern_files: Vec<OsString>,

	/// Interpret PATTERN as a strict extended regular expression.
	#[arg(short = 'E', long = "extended-regexp")]
	extended: bool,

	/// Interpret PATTERN as a POSIX basic regular expression, where `+`, `?`,
	/// `|`, `(`, `)`, `{` and `}` match themselves and `\+`, `\?`, `\|`, `\(`,
	/// `\)`, `\{` and `\}` are the operators.
	#[arg(short = 'G', long = "basic-regexp")]
	basic: bool,

	/// Interpret PATTERN as a fixed string.
	#[arg(short = 'F', long = "fixed-strings")]
	fixed: bool,

	/// Interpret PATTERN as a Perl-compatible regular expression.
	#[arg(short = 'P', long = "perl-regexp")]
	perl: bool,

	/// Ignore case distinctions in patterns and data.
	#[arg(short = 'i', short_alias = 'y', long = "ignore-case")]
	ignore_case: bool,

	/// Restore case-sensitive matching after an earlier -i.
	#[arg(long = "no-ignore-case")]
	no_ignore_case: bool,

	/// Select non-matching lines.
	#[arg(short = 'v', long = "invert-match")]
	invert: bool,

	/// Match only whole words.
	#[arg(short = 'w', long = "word-regexp")]
	word: bool,

	/// Match only whole lines.
	#[arg(short = 'x', long = "line-regexp")]
	line_regexp: bool,

	/// Print only a count of selected lines per FILE.
	#[arg(short = 'c', long = "count")]
	count: bool,

	/// Print only the names of FILEs with at least one selected line.
	#[arg(short = 'l', long = "files-with-matches")]
	files_with_matches: bool,

	/// Print only the names of FILEs with no selected lines. Exits 0 when a name
	/// is printed and 1 when none is, so the status reports what was listed
	/// rather than what matched.
	#[arg(short = 'L', long = "files-without-match")]
	files_without_match: bool,

	/// Stop after NUM selected lines in each input.
	#[arg(short = 'm', long = "max-count", value_name = "NUM", allow_hyphen_values = true)]
	max_count: Option<i64>,

	/// Print only the matched non-empty parts of selected lines.
	#[arg(short = 'o', long = "only-matching")]
	only_matching: bool,

	/// Quiet; suppress normal output and stop after the first selected line.
	#[arg(short = 'q', long = "quiet", visible_alias = "silent")]
	quiet: bool,

	/// Suppress error messages about nonexistent or unreadable files.
	#[arg(short = 's', long = "no-messages")]
	no_messages: bool,

	/// Prefix output with the zero-based byte offset.
	#[arg(short = 'b', long = "byte-offset")]
	byte_offset: bool,

	/// Always print the file name with output lines.
	#[arg(short = 'H', long = "with-filename")]
	with_filename: bool,

	/// Never print the file name with output lines.
	#[arg(short = 'h', long = "no-filename")]
	no_filename: bool,

	/// Use LABEL as the displayed name for standard input.
	#[arg(long = "label", value_name = "LABEL")]
	label: Option<OsString>,

	/// Prefix each output line with its one-based line number.
	#[arg(short = 'n', long = "line-number")]
	line_number: bool,

	/// Line the output up as a table: right-align the line number and byte
	/// offset in one column as wide as the input needs, then start every body
	/// after a tab.
	#[arg(short = 'T', long = "initial-tab")]
	initial_tab: bool,

	/// Write NUL instead of the separator following a file name. With -l or -L
	/// that NUL is the whole record terminator, so no newline follows it.
	#[arg(short = 'Z', long = "null")]
	null_paths: bool,

	/// Print NUM lines of trailing context after selected lines.
	#[arg(short = 'A', long = "after-context", value_name = "NUM")]
	after_context: Option<usize>,

	/// Print NUM lines of leading context before selected lines.
	#[arg(short = 'B', long = "before-context", value_name = "NUM")]
	before_context: Option<usize>,

	/// Print NUM lines of leading and trailing context.
	#[arg(short = 'C', long = "context", value_name = "NUM")]
	context: Option<usize>,

	/// Print STRING between non-adjacent groups of context lines.
	#[arg(long = "group-separator", value_name = "STRING")]
	group_separator: Option<String>,

	/// Do not print a separator between context groups.
	#[arg(long = "no-group-separator")]
	no_group_separator: bool,

	/// Process binary input as text.
	#[arg(short = 'a', long = "text")]
	text: bool,

	/// Treat binary input as having no selected lines.
	#[arg(short = 'I')]
	binary_without_match: bool,

	/// Choose how binary input is searched.
	#[arg(long = "binary-files", value_name = "TYPE")]
	binary_files: Option<BinaryFiles>,

	/// Choose how device, FIFO, and socket operands are handled.
	#[arg(short = 'D', long = "devices", value_name = "ACTION")]
	devices: Option<DeviceAction>,

	/// Choose how directory operands are handled.
	#[arg(short = 'd', long = "directories", value_name = "ACTION")]
	directories: Option<DirectoryAction>,

	/// Search files matching GLOB.
	#[arg(long = "include", value_name = "GLOB")]
	include: Vec<String>,

	/// Skip files matching GLOB.
	#[arg(long = "exclude", value_name = "GLOB")]
	exclude: Vec<String>,

	/// Read file exclusion globs from FILE.
	#[arg(long = "exclude-from", value_name = "FILE")]
	exclude_from: Vec<OsString>,

	/// Skip directories matching GLOB during recursive searches.
	#[arg(long = "exclude-dir", value_name = "GLOB")]
	exclude_dir: Vec<String>,

	/// Search directories matching GLOB during recursive searches.
	#[arg(long = "include-dir", value_name = "GLOB")]
	include_dir: Vec<String>,

	/// Recursively search each directory operand.
	#[arg(short = 'r', long = "recursive")]
	recursive: bool,

	/// Recursively search and follow every symbolic link.
	#[arg(short = 'R', long = "dereference-recursive")]
	dereference_recursive: bool,

	/// Follow symbolic links named as command-line operands.
	#[arg(short = 'O')]
	follow_command_line: bool,

	/// Do not follow symbolic links during recursive searches.
	#[arg(short = 'p')]
	no_follow: bool,

	/// Follow every symbolic link during recursive searches.
	#[arg(short = 'S')]
	follow_all: bool,

	/// Flush standard output after each output record.
	#[arg(long = "line-buffered")]
	line_buffered: bool,

	/// Read in binary mode. Accepted for CLI compatibility and does nothing
	/// here: the flag exists for platforms that rewrite line endings on the way
	/// in, and this builtin never rewrites them. It does NOT decide whether a
	/// file counts as binary; see `-a`, `-I` and `--binary-files`.
	#[arg(short = 'U', long = "binary")]
	binary_io: bool,

	/// Treat NUL rather than newline as the input and output record delimiter.
	/// Applies to data records only: a count, a listed file name and the `--`
	/// group separator still end with a newline.
	#[arg(short = 'z', long = "null-data")]
	null_data: bool,

	/// Request memory-mapped input where supported.
	#[allow(dead_code, reason = "accepted BSD grep compatibility option")]
	#[arg(long = "mmap")]
	mmap: bool,

	/// Accepted compatibility option with no effect.
	#[allow(dead_code, reason = "accepted GNU grep compatibility option")]
	#[arg(short = 'u')]
	unix_byte_offsets: bool,

	/// Print a help message.
	#[allow(dead_code, reason = "clap consumes help before options are inspected")]
	#[arg(long = "help", action = clap::ArgAction::Help)]
	help: Option<bool>,

	/// Print version information.
	#[allow(dead_code, reason = "clap consumes version before options are inspected")]
	#[arg(short = 'V', long = "version", action = clap::ArgAction::Version)]
	version: Option<bool>,

	/// Accept color configuration without injecting ANSI into redirected output.
	#[allow(dead_code, reason = "color is intentionally disabled for builtin output")]
	#[arg(
		long = "color",
		alias = "colour",
		value_name = "WHEN",
		num_args = 0..=1,
		require_equals = true,
		default_missing_value = "auto",
	)]
	color: Option<String>,

	/// PATTERN followed by FILEs (PATTERN is omitted with -e or -f).
	#[arg(value_name = "ARGS")]
	args: Vec<OsString>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum BinaryFiles {
	Binary,
	Text,
	WithoutMatch,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum DeviceAction {
	Read,
	Skip,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum DirectoryAction {
	Read,
	Skip,
	Recurse,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MatchMode {
	/// No pattern-syntax flag: a modern regular expression, which is what this
	/// shell's users expect from a bare `grep` and what every other search
	/// surface here accepts. GNU grep would read a BASIC expression, so `-G` is
	/// the flag that asks for that; see [`MatchMode::Basic`].
	Default,
	/// `-G`: a POSIX basic regular expression, translated by [`crate::bre`].
	Basic,
	Extended,
	Fixed,
	Perl,
}

/// Resolved, flag-free options shared with the search [`Sink`].
struct Options {
	line_number:         bool,
	byte_offset:         bool,
	count:               bool,
	files_with_matches:  bool,
	files_without_match: bool,
	only_matching:       bool,
	/// The POSIX longest-span engine, when the run has one. Present only for the
	/// modes that print a span; see [`PosixLongest`].
	posix_longest:       Option<PosixLongest>,
	before:              usize,
	after:               usize,
	no_messages:         bool,
	quiet:               bool,
	prefix_filename:     bool,
	initial_tab:         bool,
	null_paths:          bool,
	/// The byte that ends a DATA record: a matching line, a context line, or an
	/// `-o` span. `-z` makes it NUL; otherwise it is a newline.
	///
	/// It is deliberately NOT the terminator of a report line. See
	/// [`REPORT_TERMINATOR`].
	record_terminator:   u8,
	group_separator:     Option<Vec<u8>>,
	/// Whether this run GROUPS its output, which is what makes a separator exist
	/// at all.
	///
	/// True when a context option was given, `-A0` included, and the mode prints
	/// records rather than a summary. `zero_radius_groups` below is the narrower
	/// half of the same question. GNU grep prints the group separator BETWEEN
	/// two files exactly when it would print one inside a file, which is why
	/// this is a property of the run and not of one input.
	groups_output:       bool,
	/// Whether the run asked for context and asked for ZERO lines of it.
	///
	/// A request of zero still GROUPS the output: `grep -A0` prints `--` between
	/// non-adjacent matches and plain `grep` prints none, measured against GNU
	/// grep 3.11. The searcher reports a break only where it is actually keeping
	/// context lines, so with a radius of zero the gaps have to be noticed in
	/// the sink instead. See `GrepSink::separate_group`.
	zero_radius_groups:  bool,
	line_buffered:       bool,
	binary_files:        BinaryFiles,
	/// Whether the locale's codeset is multibyte, which decides whether badly
	/// encoded text counts as binary data.
	///
	/// GNU grep treats a line holding a sequence the codeset cannot represent as
	/// binary: measured on GNU grep 3.11 in `en_US.UTF-8`, a file whose first
	/// line holds `\xff\xfe` prints the OTHER matching lines and reports
	/// `grep: bad.bin: binary file matches`, while the same file in `LC_ALL=C`
	/// prints both lines and reports nothing, because in a single-byte codeset
	/// every byte is a character.
	multibyte_locale:    bool,
}

struct PathRule {
	include: bool,
	matcher: GlobMatcher,
}

struct RuleSpec {
	index:   usize,
	include: bool,
	pattern: String,
}

#[derive(Default)]
struct PathRules {
	files: Vec<PathRule>,
	dirs:  Vec<PathRule>,
}

impl PathRules {
	fn allows_file(&self, path: &Path) -> bool {
		Self::allows(&self.files, path)
	}

	fn allows_dir(&self, path: &Path) -> bool {
		Self::allows(&self.dirs, path)
	}

	fn allows(rules: &[PathRule], path: &Path) -> bool {
		let mut allowed = rules.first().is_none_or(|first| !first.include);
		for rule in rules {
			if path_suffix_matches(&rule.matcher, path) {
				allowed = rule.include;
			}
		}
		allowed
	}
}

fn path_suffix_matches(matcher: &GlobMatcher, path: &Path) -> bool {
	let mut components = path.components();
	loop {
		let suffix = components.as_path();
		if suffix.as_os_str().is_empty() {
			return false;
		}
		if matcher.is_match(suffix) {
			return true;
		}
		if components.next().is_none() {
			return false;
		}
	}
}

fn last_index(matches: &ArgMatches, id: &str) -> Option<usize> {
	if matches.value_source(id) != Some(ValueSource::CommandLine) {
		return None;
	}
	matches.indices_of(id).and_then(|indices| indices.max())
}

fn choose_latest<T>(selected: &mut (usize, T), index: Option<usize>, value: T) {
	if let Some(index) = index
		&& index >= selected.0
	{
		*selected = (index, value);
	}
}

/// GNU's message for two different pattern-syntax flags in one run.
const CONFLICTING_MATCHERS: &str = "conflicting matchers specified";

/// Which pattern syntax the run asked for.
///
/// The pattern-syntax flags are the ONE place this builtin does not resolve a
/// conflict by taking the last flag, because GNU grep 3.11 refuses instead:
/// `grep -E -G x` exits 2 with `conflicting matchers specified`, and so does
/// any other pair of distinct kinds. Repeating the SAME flag is fine, and `-E
/// -F -E` still conflicts, so the rule is on the SET of kinds named and not on
/// how many flags were seen. Taking the last one here would silently search
/// with a syntax the user did not ask for, in the one dimension where the
/// difference decides what a pattern MEANS: `a+b` is two things depending on
/// the answer.
fn resolve_match_mode(matches: &ArgMatches) -> Result<MatchMode, String> {
	let named: Vec<MatchMode> = [
		("basic", MatchMode::Basic),
		("extended", MatchMode::Extended),
		("fixed", MatchMode::Fixed),
		("perl", MatchMode::Perl),
	]
	.into_iter()
	.filter(|(flag, _)| last_index(matches, flag).is_some())
	.map(|(_, mode)| mode)
	.collect();
	match named.as_slice() {
		[] => Ok(MatchMode::Default),
		[only] => Ok(*only),
		_ => Err(CONFLICTING_MATCHERS.to_string()),
	}
}

fn resolve_ignore_case(matches: &ArgMatches) -> bool {
	let mut selected = (0, false);
	choose_latest(&mut selected, last_index(matches, "ignore_case"), true);
	choose_latest(&mut selected, last_index(matches, "no_ignore_case"), false);
	selected.1
}

fn resolve_filename_prefix(matches: &ArgMatches) -> Option<bool> {
	let mut selected = (0, None);
	choose_latest(&mut selected, last_index(matches, "with_filename"), Some(true));
	choose_latest(&mut selected, last_index(matches, "no_filename"), Some(false));
	selected.1
}

fn resolve_file_list_modes(matches: &ArgMatches) -> (bool, bool) {
	let mut selected = (0, None);
	choose_latest(&mut selected, last_index(matches, "files_with_matches"), Some(true));
	choose_latest(&mut selected, last_index(matches, "files_without_match"), Some(false));
	match selected.1 {
		Some(true) => (true, false),
		Some(false) => (false, true),
		None => (false, false),
	}
}

fn resolve_context(cli: &Cli, matches: &ArgMatches) -> (usize, usize) {
	let mut events = Vec::with_capacity(3);
	if let (Some(index), Some(value)) = (last_index(matches, "after_context"), cli.after_context) {
		events.push((index, false, value));
	}
	if let (Some(index), Some(value)) = (last_index(matches, "before_context"), cli.before_context) {
		events.push((index, true, value));
	}
	if let (Some(index), Some(value)) = (last_index(matches, "context"), cli.context) {
		events.push((index, false, value));
		events.push((index, true, value));
	}
	events.sort_unstable_by_key(|event| event.0);

	let mut before = 0;
	let mut after = 0;
	for (_, is_before, value) in events {
		if is_before {
			before = value;
		} else {
			after = value;
		}
	}
	(before, after)
}

fn resolve_group_separator(cli: &Cli, matches: &ArgMatches) -> Option<Vec<u8>> {
	let mut selected = (0, Some(b"--".to_vec()));
	if let Some(separator) = &cli.group_separator {
		choose_latest(
			&mut selected,
			last_index(matches, "group_separator"),
			Some(separator.as_bytes().to_vec()),
		);
	}
	choose_latest(&mut selected, last_index(matches, "no_group_separator"), None);
	selected.1
}

fn resolve_directory_action(cli: &Cli, matches: &ArgMatches) -> DirectoryAction {
	let mut selected = (0, DirectoryAction::Read);
	choose_latest(&mut selected, last_index(matches, "recursive"), DirectoryAction::Recurse);
	choose_latest(
		&mut selected,
		last_index(matches, "dereference_recursive"),
		DirectoryAction::Recurse,
	);
	if let Some(action) = cli.directories {
		choose_latest(&mut selected, last_index(matches, "directories"), action);
	}
	selected.1
}

fn resolve_follow_links(cli: &Cli, matches: &ArgMatches) -> veyyon_walker::FollowLinks {
	let mut selected = (0, veyyon_walker::FollowLinks::Roots);
	choose_latest(
		&mut selected,
		last_index(matches, "recursive"),
		veyyon_walker::FollowLinks::Roots,
	);
	choose_latest(
		&mut selected,
		last_index(matches, "dereference_recursive"),
		veyyon_walker::FollowLinks::Always,
	);
	if cli.directories == Some(DirectoryAction::Recurse) {
		choose_latest(
			&mut selected,
			last_index(matches, "directories"),
			veyyon_walker::FollowLinks::Roots,
		);
	}
	choose_latest(
		&mut selected,
		last_index(matches, "follow_command_line"),
		veyyon_walker::FollowLinks::Roots,
	);
	choose_latest(
		&mut selected,
		last_index(matches, "no_follow"),
		veyyon_walker::FollowLinks::Never,
	);
	choose_latest(
		&mut selected,
		last_index(matches, "follow_all"),
		veyyon_walker::FollowLinks::Always,
	);
	selected.1
}

/// Whether the locale's codeset is multibyte, which is what decides whether
/// badly encoded text counts as binary data.
///
/// The three variables are read in the order the C standard gives them:
/// `LC_ALL` overrides everything, then `LC_CTYPE`, then `LANG`. A codeset of
/// `UTF-8`, in any of its usual spellings, is the multibyte case; `C` and
/// `POSIX` are not, and neither is an unset environment, which is why the
/// default answer is `false`. Measured on GNU grep 3.11: the same file is
/// binary under `en_US.UTF-8` and plain text under `LC_ALL=C`.
fn locale_is_multibyte() -> bool {
	let locale = ["LC_ALL", "LC_CTYPE", "LANG"]
		.into_iter()
		.filter_map(veyyon_uutils_ctx::var)
		.find(|value| !value.is_empty());
	let Some(locale) = locale else {
		return false;
	};
	let codeset = locale
		.rsplit_once('.')
		.map_or("", |(_, codeset)| codeset)
		.split('@')
		.next()
		.unwrap_or("");
	codeset.eq_ignore_ascii_case("utf-8") || codeset.eq_ignore_ascii_case("utf8")
}

/// How the run treats an input that holds a NUL.
///
/// The DEFAULT is `Binary`, which is GNU's: report `binary file matches` on
/// stderr and print no records. This builtin used to default to `Text`, called
/// "byte-transparent", and the consequence was that `grep pattern a.o` dumped
/// raw bytes into the shell's output, NULs and all, which is the behaviour GNU
/// moved away from because it corrupts a terminal. A NUL makes the whole file
/// binary and badly encoded text makes one line binary; see the crate docs.
fn resolve_binary_files(cli: &Cli, matches: &ArgMatches) -> BinaryFiles {
	let mut selected = (0, BinaryFiles::Binary);
	choose_latest(&mut selected, last_index(matches, "text"), BinaryFiles::Text);
	choose_latest(
		&mut selected,
		last_index(matches, "binary_without_match"),
		BinaryFiles::WithoutMatch,
	);
	if let Some(mode) = cli.binary_files {
		choose_latest(&mut selected, last_index(matches, "binary_files"), mode);
	}
	// `-U` is NOT in this list. It asks for binary I/O on a platform that
	// distinguishes it from text I/O, which is about line endings and not about
	// whether a file counts as binary, and this one does not distinguish them at
	// all. Mapping it to `Binary` here made it OVERRIDE the flags that do decide:
	// `grep -a -U pattern file` reported `binary file matches` where GNU prints the
	// records, in either order, and `grep -I -U` lost its `-I`.
	selected.1
}

fn resolve_max_count(cli: &Cli) -> Result<Option<u64>, String> {
	match cli.max_count {
		None | Some(-1) => Ok(None),
		Some(value) if value >= 0 => u64::try_from(value)
			.map(Some)
			.map_err(|_| format!("invalid max count: {value}")),
		Some(value) => Err(format!("invalid max count: {value}")),
	}
}

fn option_takes_next_value(arg: &str) -> bool {
	matches!(
		arg,
		"-e"
			| "-f" | "-m"
			| "-A" | "-B"
			| "-C" | "-D"
			| "-d" | "--regexp"
			| "--file"
			| "--max-count"
			| "--after-context"
			| "--before-context"
			| "--context"
			| "--label"
			| "--group-separator"
			| "--binary-files"
			| "--devices"
			| "--directories"
			| "--include"
			| "--exclude"
			| "--exclude-from"
			| "--exclude-dir"
			| "--include-dir"
	)
}

/// Rewrite `grep`'s `-NUM` context shorthand into the long form clap can parse.
///
/// Public because it runs before parsing and is therefore part of what the
/// command accepts: `-3` is a valid invocation of `grep` and clap never sees
/// it. Anything checking the argument surface has to go through here first, or
/// it is checking a different command than the one users get.
#[must_use]
pub fn normalize_context_args(argv: Vec<OsString>) -> Vec<OsString> {
	let mut normalized = Vec::with_capacity(argv.len());
	let mut literal = false;
	let mut value_pending = false;

	for (index, arg) in argv.into_iter().enumerate() {
		if index == 0 || literal || value_pending {
			value_pending = false;
			normalized.push(arg);
			continue;
		}
		let Some(text) = arg.to_str() else {
			normalized.push(arg);
			continue;
		};
		if text == "--" {
			literal = true;
			normalized.push(arg);
			continue;
		}
		if let Some(digits) = text.strip_prefix('-')
			&& !digits.is_empty()
			&& digits.bytes().all(|byte| byte.is_ascii_digit())
		{
			normalized.push(OsString::from(format!("--context={digits}")));
			continue;
		}
		value_pending = option_takes_next_value(text);
		normalized.push(arg);
	}
	normalized
}

/// Escape regular-expression meta-characters so a pattern is matched literally
/// (used to implement `-F`/`--fixed-strings` and the per-alternative literal
/// demotion below).
///
/// This used to carry its own meta-character list with a comment saying it
/// mirrored the escaper in `regex`. It did, character for character, which is
/// exactly why it was a hazard: nothing kept it mirroring, and `regex-syntax`
/// has added meta characters before. The rule now has one owner in the kernel;
/// see [`escape_literal_pattern`] for the recall argument.
fn escape_literal(pat: &str) -> String {
	escape_literal_pattern(pat)
}

/// What this builtin's flags mean to a matcher, derived ONCE and read by both
/// engines.
///
/// WHY THIS EXISTS. `-P` compiles with PCRE2 and every other mode compiles with
/// the Rust engine, and both branches used to derive the same three decisions
/// from `cli` themselves, in two spellings: `case_insensitive` against
/// `caseless`, and `cli.word && !cli.line_regexp` written out twice. A change
/// to the `-w`-under-`-x` rule had to be made in both places or the same
/// pattern would match differently depending only on whether `-P` was passed.
///
/// The struct is DESTRUCTURED WITHOUT `..` in both appliers below, so adding a
/// field here is a compile error in each one, by name. Do not "tidy" either
/// destructure into `..`; that is the whole mechanism.
///
/// This is NOT [`crate::rg`]'s nine-field flag set, and the two are
/// deliberately separate: the `rg` builtin exposes smart case, `--crlf`,
/// `--multiline` and `--no-unicode`, none of which `grep` has, and the kernel's
/// [`pcre_matcher_defaults`] documents the same decision for the settings it
/// does own. One struct covering both surfaces would make each one name fields
/// its own CLI cannot produce.
struct GrepMatcherFlags {
	case_insensitive: bool,
	word:             bool,
	whole_line:       bool,
	/// The byte a line ends at: NUL under `-z`, otherwise the engine default.
	///
	/// `None` means "do not touch the setting" rather than "no terminator". Only
	/// the Rust engine takes it; see the note in the PCRE2 applier.
	line_terminator:  Option<u8>,
}

impl GrepMatcherFlags {
	fn from_cli(cli: &Cli, ignore_case: bool) -> Self {
		Self {
			case_insensitive: ignore_case,
			// `-x` beats `-w` REGARDLESS OF ORDER, verified against GNU grep 3.11:
			// `grep -w -x hit` and `grep -x -w hit` both match only the line that
			// is exactly `hit`. Whole-line matching already fixes both ends, and
			// asking for word boundaries on top of it rejects a line whose first or
			// last character is not a word character.
			//
			// DO NOT "fix" this into an `overrides_with` pair to match the `rg`
			// builtin, which is last-wins for these two flags. The two tools
			// genuinely disagree: `rg -x -w hit` matches whole WORDS and so also
			// matches `hit there`. Locked by `x_beats_w_regardless_of_order`.
			word:             cli.word && !cli.line_regexp,
			whole_line:       cli.line_regexp,
			line_terminator:  cli.null_data.then_some(b'\0'),
		}
	}
}

/// Apply the flag set to the Rust engine's builder.
fn apply_rust_flags(builder: &mut RegexMatcherBuilder, flags: &GrepMatcherFlags) {
	let GrepMatcherFlags { case_insensitive, word, whole_line, line_terminator } = *flags;
	builder
		.case_insensitive(case_insensitive)
		.word(word)
		.whole_line(whole_line);
	if let Some(terminator) = line_terminator {
		builder.line_terminator(Some(terminator));
	}
}

/// Apply the flag set to PCRE2's builder.
fn apply_pcre_flags(builder: &mut PcreMatcherBuilder, flags: &GrepMatcherFlags) {
	// `line_terminator: _` is the one deliberate omission. PCRE2 has no line
	// terminator setting to give it, so `-z` changes what the searcher SPLITS on
	// and not what the pattern is compiled against. Naming the field keeps the
	// destructure exhaustive, so a future field cannot be dropped here silently.
	let GrepMatcherFlags { case_insensitive, word, whole_line, line_terminator: _ } = *flags;
	builder
		.caseless(case_insensitive)
		.word(word)
		.whole_line(whole_line);
	pcre_matcher_defaults(builder);
}

/// Compile all patterns using the last-selected matcher mode.
/// A record without its terminator.
///
/// Both builtins strip one in the places where the terminator is not part of
/// what they are looking at: the bytes a span is measured against, and the
/// bytes a notice is appended after. One owner, so `-z` cannot mean one thing
/// in `grep` and another in `rg`.
pub(crate) fn strip_record_terminator(bytes: &[u8], terminator: u8) -> &[u8] {
	bytes.strip_suffix(&[terminator]).unwrap_or(bytes)
}

/// The POSIX rule for WHICH span a match reports, for the two modes that show
/// one.
///
/// GNU grep is a POSIX matcher, so where several alternatives match at the same
/// place it reports the LONGEST of them. Measured on GNU grep 3.11:
/// `grep -o -E 'hit|hit hit'` over `hit hit hit` prints `hit hit` and then
/// `hit`. Both engines this builtin can use are leftmost-FIRST, the Rust
/// `regex` engine and PCRE2 alike, so each prints `hit` three times: they agree
/// the line matches and disagree about how much of it the match covers.
///
/// This is a second automaton over the SAME compiled patterns, built with
/// `MatchKind::All`, which is regex-automata's way of saying "do not stop at
/// the first match state": an anchored overlapping search from a known start
/// then reports every end a match could have there, and the longest is GNU's
/// answer. It is used for the span alone. The first engine still decides
/// whether a line matches and where a match STARTS, so the scan every other
/// mode runs is untouched, and this work happens only under `-o`, which is the
/// only mode whose output shows a span.
///
/// Two runs deliberately keep the leftmost-first span, and both are recorded
/// rather than silent. A pattern that needs PCRE2 (a back-reference under `-G`,
/// or `-P`) has no equivalent here, because the construct is not regular and
/// this engine cannot compile it. And `-x` has nothing to choose: a whole-line
/// match covers the line however it was written.
struct PosixLongest {
	dfa:  regex_automata::hybrid::dfa::DFA,
	/// Whether the end of a span has to fall on a word boundary, which is what
	/// `-w` asks. The START is already the first engine's answer, so only the
	/// end is filtered here.
	word: bool,
}

impl PosixLongest {
	/// Build the span engine for the patterns the first engine compiled.
	///
	/// Returns `None` when the rule does not apply or cannot be applied: a
	/// whole-line match has no choice of span, and a pattern this engine refuses
	/// (which the first engine may still have accepted, since the two support
	/// different constructs) leaves the leftmost-first span in place rather than
	/// failing the run over a difference the caller cannot see.
	fn build(compiled: &[String], flags: &GrepMatcherFlags) -> Option<Self> {
		use regex_automata::{MatchKind, hybrid::dfa::DFA, util::syntax};

		if flags.whole_line {
			return None;
		}
		let dfa = DFA::builder()
			.configure(DFA::config().match_kind(MatchKind::All))
			.syntax(syntax::Config::new().case_insensitive(flags.case_insensitive))
			.build_many(compiled)
			.ok()?;
		Some(Self { dfa, word: flags.word })
	}

	/// A cache for one search thread, which the DFA needs and cannot share.
	fn cache(&self) -> regex_automata::hybrid::dfa::Cache {
		self.dfa.create_cache()
	}

	/// The end of the longest match that starts at `start`, or `None` when this
	/// engine finds none there.
	///
	/// `line` must not carry its terminator: the terminator is not part of the
	/// line GNU matches against, and leaving it on would let `.` and a character
	/// class swallow it and report a span one byte too long.
	fn longest_end(
		&self,
		cache: &mut regex_automata::hybrid::dfa::Cache,
		line: &[u8],
		start: usize,
	) -> Option<usize> {
		use regex_automata::{Anchored, Input, hybrid::dfa::OverlappingState};

		let input = Input::new(line)
			.span(start..line.len())
			.anchored(Anchored::Yes);
		let mut state = OverlappingState::start();
		let mut longest = None;
		loop {
			// A DFA that cannot be built out further gives up rather than
			// answering wrongly, and the caller then keeps the first engine's span.
			self
				.dfa
				.try_search_overlapping_fwd(cache, &input, &mut state)
				.ok()?;
			let Some(half) = state.get_match() else { break };
			let end = half.offset();
			if self.ends_a_word(line, end) && longest.is_none_or(|best| end > best) {
				longest = Some(end);
			}
		}
		longest
	}

	/// Whether a span ending at `end` satisfies `-w`.
	///
	/// `-w` asks that the match be bounded by non-word constituents. The start
	/// is the first engine's answer and already satisfies it, so only the end
	/// is asked about here: the byte after the span must not be a word byte.
	/// Without `-w` every end qualifies.
	fn ends_a_word(&self, line: &[u8], end: usize) -> bool {
		if !self.word {
			return true;
		}
		line
			.get(end)
			.is_none_or(|byte| !byte.is_ascii_alphanumeric() && *byte != b'_' && *byte < 0x80)
	}
}

/// A compiled matcher and the patterns the engine actually saw.
///
/// The patterns are not the ones the caller passed. `-F` escapes them, `-G`
/// rewrites them, and the default mode may escape the ones that would not
/// compile, so the strings that reached the engine are the only ones a SECOND
/// engine can be built from without guessing. `PosixLongest` needs exactly
/// those, which is why they are returned here rather than rebuilt at the call
/// site.
struct BuiltMatcher {
	matcher:       CompiledMatcher,
	compiled:      Vec<String>,
	/// The span engine, attached by `build_matcher` once the matcher is known.
	posix_longest: Option<PosixLongest>,
}

impl BuiltMatcher {
	fn new(matcher: CompiledMatcher, compiled: Vec<String>) -> Self {
		Self { matcher, compiled, posix_longest: None }
	}
}

/// Compile the patterns and, when a mode will print a span, the engine that
/// decides which span POSIX would report.
///
/// The span engine is built here rather than at the call site because this is
/// where both halves of what it needs live: the patterns as the first engine
/// saw them, and the flags they were compiled with. It is built ONLY for a run
/// that prints a span, since building a second automaton for a run that never
/// shows one is pure cost.
fn build_matcher(
	patterns: &[String],
	cli: &Cli,
	mode: MatchMode,
	ignore_case: bool,
) -> Result<BuiltMatcher, String> {
	let flags = GrepMatcherFlags::from_cli(cli, ignore_case);
	let mut built = compile_matcher(patterns, mode, &flags)?;
	if cli.only_matching && matches!(built.matcher, CompiledMatcher::Rust(_)) {
		built.posix_longest = PosixLongest::build(&built.compiled, &flags);
	}
	Ok(built)
}

fn compile_matcher(
	patterns: &[String],
	mode: MatchMode,
	flags: &GrepMatcherFlags,
) -> Result<BuiltMatcher, String> {
	if mode == MatchMode::Perl {
		let mut builder = PcreMatcherBuilder::new();
		apply_pcre_flags(&mut builder, flags);
		return builder
			.build_many(patterns)
			.map(|matcher| BuiltMatcher::new(CompiledMatcher::Pcre(matcher), patterns.to_vec()))
			.map_err(|error| error.to_string());
	}

	if mode == MatchMode::Basic {
		// A BRE is rewritten, never fed through, and a bad one is an ERROR rather
		// than a literal: GNU grep exits 2 for `grep -G 'a\{'` and so does this.
		// There is no fallback here on purpose, because the fallback in the default
		// mode below is what would turn a mistyped operator into a silent literal
		// search.
		let translated = patterns
			.iter()
			.map(|pattern| bre::translate(pattern))
			.collect::<Result<Vec<_>, String>>()?;
		// One back-reference anywhere sends every pattern to PCRE2, because the
		// engines are chosen per run and not per pattern.
		let back_reference = translated
			.iter()
			.any(|translated| translated.back_reference);
		let rewritten: Vec<String> = translated
			.into_iter()
			.map(|translated| translated.pattern)
			.collect();
		if back_reference {
			let mut builder = PcreMatcherBuilder::new();
			apply_pcre_flags(&mut builder, flags);
			return builder
				.build_many(&rewritten)
				.map(|matcher| BuiltMatcher::new(CompiledMatcher::Pcre(matcher), rewritten.clone()))
				.map_err(|error| error.to_string());
		}
		let mut builder = RegexMatcherBuilder::new();
		apply_rust_flags(&mut builder, flags);
		return builder
			.build_many(&rewritten)
			.map(|matcher| BuiltMatcher::new(CompiledMatcher::Rust(matcher), rewritten.clone()))
			.map_err(|error| error.to_string());
	}

	let mut builder = RegexMatcherBuilder::new();
	apply_rust_flags(&mut builder, flags);
	if mode == MatchMode::Fixed {
		let escaped: Vec<String> = patterns
			.iter()
			.map(|pattern| escape_literal(pattern))
			.collect();
		return builder
			.build_many(&escaped)
			.map(|matcher| BuiltMatcher::new(CompiledMatcher::Rust(matcher), escaped.clone()))
			.map_err(|error| error.to_string());
	}

	match builder.build_many(patterns) {
		Ok(matcher) => Ok(BuiltMatcher::new(CompiledMatcher::Rust(matcher), patterns.to_vec())),
		Err(error) if mode == MatchMode::Default => {
			// The historical builtin accepts ERE syntax by default but falls
			// back to literals per malformed alternative.
			let sanitized: Vec<String> = patterns
				.iter()
				.map(|pattern| {
					if builder.build(pattern).is_ok() {
						pattern.clone()
					} else {
						escape_literal(pattern)
					}
				})
				.collect();
			builder
				.build_many(&sanitized)
				.map(|matcher| BuiltMatcher::new(CompiledMatcher::Rust(matcher), sanitized.clone()))
				.map_err(|_| error.to_string())
		},
		Err(error) => Err(error.to_string()),
	}
}

/// The byte that ends a REPORT line on stdout: the `--` group separator, a `-c`
/// count, and a `-l`/`-L` listed path.
///
/// The binary-file notice is NOT one of these. It goes to stderr, where the
/// record terminator has no say; see `finish`.
///
/// WHY THIS IS A CONSTANT AND NOT `Options::record_terminator`. `-z`
/// (`--null-data`) changes the terminator of a DATA record and nothing else.
/// GNU grep 3.11 on this machine:
///
/// ```text
/// grep -z    hit  ->  hit\0            data record, NUL
/// grep -z -n hit  ->  2:hit\0          still a data record
/// grep -z -C1 hit ->  ...b\0--\n...    the separator keeps its newline
/// grep -z -c hit  ->  2\n              a count keeps its newline
/// grep -z -l hit  ->  path\n           a listed path keeps its newline
/// ```
///
/// This is where `grep` and `rg` genuinely disagree, so neither surface can
/// borrow the other's rule. ripgrep 15.1.0 terminates all four with NUL under
/// `--null-data` (`2\0`, `path\0`, `--\0`), which is why [`crate::rg`] passes
/// its own `record_terminator` through every writer. This printer is the `grep`
/// builtin and follows `grep`.
///
/// `-Z` (`--null`) is the flag that DOES change a report line, and only where a
/// path is involved: it replaces the byte after the path, so `-Z -l` ends the
/// listed path with NUL instead of this byte.
const REPORT_TERMINATOR: u8 = b'\n';

/// A search sink that renders GNU-compatible records and tracks selection.
struct GrepSink<'a, M: Matcher, W: Write> {
	out:             &'a mut W,
	matcher:         &'a M,
	display:         &'a [u8],
	opts:            &'a Options,
	/// The column `-T` right-aligns this input's numeric fields in. 1 without
	/// `-T`, which pads nothing. See `aligned_field_width`.
	field_width:     usize,
	/// The byte offset a record would have to start at to CONTINUE the last one,
	/// used to notice a gap when the context radius is zero. `None` until this
	/// input has printed a record.
	next_offset:     Option<u64>,
	match_count:     u64,
	any_match:       bool,
	binary:          bool,
	/// Whether another input has already printed a record, so this one's first
	/// record is preceded by the group separator. Comes from the run, not from
	/// this input; see `begin_search`.
	follows_a_group: bool,
	/// Whether THIS input has printed a record yet, which is also the answer the
	/// run needs for the next input.
	printed_group:   bool,
	/// The span engine's cache for THIS input, built on first use.
	///
	/// A `hybrid` DFA needs a mutable cache and cannot share one across threads,
	/// so it belongs to the sink rather than to the options. Built lazily so a
	/// run whose lines never match pays nothing for it.
	longest_cache:   Option<regex_automata::hybrid::dfa::Cache>,
	/// Set when a line held a sequence the locale's codeset cannot represent.
	///
	/// Kept apart from `binary`, which is the NUL answer, because the two behave
	/// differently: a NUL replaces the whole file's records with the notice,
	/// while badly encoded text suppresses only the LINES that hold it and lets
	/// the rest print. Measured on GNU grep 3.11, which prints `plain hit` from
	/// the second line of a file whose first line is badly encoded, and then
	/// reports the file.
	bad_encoding:    bool,
}

impl<M: Matcher, W: Write> GrepSink<'_, M, W> {
	fn flush_record(&mut self) -> io::Result<()> {
		if self.opts.line_buffered {
			self.out.flush()?;
		}
		Ok(())
	}

	/// The group separator that stands between one input's records and the
	/// next's.
	///
	/// GNU grep prints it between two files wherever it prints one inside a
	/// file: `grep -A1 hit a b` puts `--` between the two files' groups,
	/// `--group-separator=XX` changes it in both places, `--no-group-separator`
	/// removes it from both, and plain `grep hit a b` prints none because
	/// nothing asked for grouping. Measured against GNU grep 3.11.
	///
	/// This printer had NO cross-file separator, so every context run ran one
	/// file's block straight into the next's with nothing to mark the boundary.
	/// The mark is what makes the output readable when several files match, and
	/// under `-h`, where the records carry no name, it is the only boundary
	/// there is.
	fn begin_search(&mut self) -> io::Result<()> {
		if self.printed_group {
			return Ok(());
		}
		self.printed_group = true;
		if self.follows_a_group
			&& self.opts.groups_output
			&& let Some(separator) = &self.opts.group_separator
		{
			self.out.write_all(separator)?;
			self.write_report_terminator()?;
			self.flush_record()?;
		}
		Ok(())
	}

	fn write_prefix(
		&mut self,
		line_number: Option<u64>,
		byte_offset: u64,
		separator: u8,
	) -> io::Result<()> {
		self.begin_search()?;
		let mut has_prefix = false;
		if self.opts.prefix_filename {
			self.out.write_all(self.display)?;
			if self.opts.null_paths {
				self.out.write_all(b"\0")?;
			} else {
				self.out.write_all(&[separator])?;
			}
			has_prefix = true;
		}
		// `-T` right-aligns the numeric fields, which is the whole point of the flag:
		// the bodies then start at the same column and the output reads as a table.
		// Without it the width is 1 and a number wider than that simply pushes past,
		// so this is the same code path either way.
		let width = self.field_width;
		if self.opts.line_number
			&& let Some(number) = line_number
		{
			write!(self.out, "{number:>width$}")?;
			self.out.write_all(&[separator])?;
			has_prefix = true;
		}
		if self.opts.byte_offset {
			write!(self.out, "{byte_offset:>width$}")?;
			self.out.write_all(&[separator])?;
			has_prefix = true;
		}
		if self.opts.initial_tab && has_prefix {
			self.out.write_all(b"\t")?;
		}
		Ok(())
	}

	/// Write the group separator when a record starting at `offset` does not
	/// continue the previous one.
	///
	/// This is the zero-radius half of the grouping. Adjacency is decided from
	/// BYTE OFFSETS and not from line numbers, because a line number exists
	/// only when `-n` asked for one and the grouping does not depend on `-n`.
	/// The whole matching LINE advances the mark, so the several records `-o`
	/// prints for one line are never separated from each other.
	fn separate_group(&mut self, offset: u64, line: &[u8]) -> io::Result<()> {
		if !self.opts.zero_radius_groups {
			return Ok(());
		}
		if let Some(next) = self.next_offset
			&& next != offset
			&& let Some(separator) = &self.opts.group_separator
		{
			self.out.write_all(separator)?;
			self.write_report_terminator()?;
			self.flush_record()?;
		}
		let length =
			u64::try_from(line.len()).map_err(|error| io::Error::other(error.to_string()))?;
		self.next_offset = Some(offset.saturating_add(length));
		Ok(())
	}

	fn write_record(&mut self, record: &[u8]) -> io::Result<()> {
		self.out.write_all(record)?;
		if record.last().copied() != Some(self.opts.record_terminator) {
			self.out.write_all(&[self.opts.record_terminator])?;
		}
		self.flush_record()
	}

	/// Write the terminator that ends a report line. One owner, four callers.
	fn write_report_terminator(&mut self) -> io::Result<()> {
		self.out.write_all(&[REPORT_TERMINATOR])
	}

	/// A `-l`/`-L` listed path is a report line, so `-z` does not touch its
	/// terminator. `-Z` does: it replaces the byte after the path, and for this
	/// record that byte IS the terminator.
	fn write_path_record(&mut self) -> io::Result<()> {
		self.out.write_all(self.display)?;
		if self.opts.null_paths {
			self.out.write_all(b"\0")?;
		} else {
			self.write_report_terminator()?;
		}
		self.flush_record()
	}

	fn print_only_matching(
		&mut self,
		line: &[u8],
		line_number: Option<u64>,
		line_offset: u64,
	) -> io::Result<()> {
		let mut at = 0usize;
		while at <= line.len() {
			let Some(found) = self
				.matcher
				.find_at(line, at)
				.map_err(|error| io::Error::other(error.to_string()))?
			else {
				break;
			};
			if found.is_empty() {
				at = found.end() + 1;
				continue;
			}
			let found = self.posix_span(line, found);
			let match_offset = line_offset.saturating_add(
				u64::try_from(found.start()).map_err(|error| io::Error::other(error.to_string()))?,
			);
			let text = &line[found.start()..found.end()];
			// Each match stands on its own here: one whose bytes the codeset cannot
			// represent is skipped and marks the file, while its neighbours still print.
			if self.line_is_badly_encoded(text) {
				self.bad_encoding = true;
			} else {
				self.write_prefix(line_number, match_offset, b':')?;
				self.write_record(text)?;
			}
			at = found.end();
		}
		Ok(())
	}

	/// The span GNU grep would report for the match the first engine found.
	///
	/// The start is the first engine's, which is already POSIX-correct: both
	/// engines find the leftmost match. Only the END can differ, and only when
	/// several alternatives match at that start, so this asks the span engine
	/// for the longest end and keeps the original span when there is no span
	/// engine or it finds nothing (a pattern it could not compile, or PCRE2). A
	/// shorter end than the first engine's is impossible by construction and is
	/// ignored rather than trusted.
	fn posix_span(&mut self, line: &[u8], found: grep_matcher::Match) -> grep_matcher::Match {
		let Some(longest) = self.opts.posix_longest.as_ref() else {
			return found;
		};
		if self.longest_cache.is_none() {
			self.longest_cache = Some(longest.cache());
		}
		let cache = self
			.longest_cache
			.as_mut()
			.expect("the cache was just built");
		// The terminator is not part of the line the pattern is matched against.
		let content = strip_record_terminator(line, self.opts.record_terminator);
		match longest.longest_end(cache, content, found.start()) {
			Some(end) if end > found.end() => found.with_end(end),
			_ => found,
		}
	}

	fn normal_output_is_suppressed(&self) -> bool {
		self.opts.count
			|| self.opts.files_with_matches
			|| self.opts.files_without_match
			|| self.opts.quiet
	}

	/// Whether this line holds a sequence the locale's codeset cannot represent.
	///
	/// Only asked in a multibyte locale, and never under
	/// `-a`/`--binary-files=text`, which say to print the bytes whatever they
	/// are. UTF-8 is the only multibyte codeset this builtin decodes, and it is
	/// the one every current system uses.
	fn line_is_badly_encoded(&self, line: &[u8]) -> bool {
		self.opts.multibyte_locale
			&& self.opts.binary_files != BinaryFiles::Text
			&& std::str::from_utf8(line).is_err()
	}

	/// Whether the badly encoded lines this file held earn the end-of-file
	/// notice.
	///
	/// Only `--binary-files=binary`, the default, has a notice to give. Measured
	/// on GNU grep 3.11: `grep --binary-files=without-match hit bad.bin` prints
	/// the good line and NOTHING on stderr, because `-I` speaks about files it
	/// assumed do not match, and this file did match.
	/// `-a`/`--binary-files=text` never gets here at all, since it prints the
	/// bytes and sets no flag.
	fn bad_encoding_summary(&self) -> bool {
		self.bad_encoding && self.opts.binary_files == BinaryFiles::Binary
	}

	fn binary_summary(&self) -> bool {
		self.binary
			&& self.opts.binary_files == BinaryFiles::Binary
			&& !self.normal_output_is_suppressed()
	}
}

impl<M: Matcher, W: Write> Sink for GrepSink<'_, M, W> {
	type Error = io::Error;

	fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, io::Error> {
		if self.binary && self.opts.binary_files == BinaryFiles::WithoutMatch {
			return Ok(false);
		}
		self.any_match = true;
		self.match_count += 1;
		if self.opts.quiet
			|| self.opts.files_with_matches
			|| self.opts.files_without_match
			|| self.binary_summary()
		{
			return Ok(false);
		}
		if self.opts.count {
			return Ok(true);
		}
		// What decides the encoding question is the bytes about to be PRINTED, not the
		// line they came from. Measured on GNU grep 3.11: `grep -o hit bad.bin` prints
		// BOTH `hit`s, one of them from a badly encoded line, and reports nothing,
		// because the match text itself is representable. Without `-o` the whole line
		// is the output, so a bad line is counted, not printed, and reported at the
		// end.
		if self.opts.only_matching {
			self.separate_group(mat.absolute_byte_offset(), mat.bytes())?;
			self.print_only_matching(mat.bytes(), mat.line_number(), mat.absolute_byte_offset())?;
		} else if self.line_is_badly_encoded(mat.bytes()) {
			self.bad_encoding = true;
		} else {
			self.separate_group(mat.absolute_byte_offset(), mat.bytes())?;
			self.write_prefix(mat.line_number(), mat.absolute_byte_offset(), b':')?;
			self.write_record(mat.bytes())?;
		}
		Ok(true)
	}

	fn context(&mut self, _searcher: &Searcher, ctx: &SinkContext<'_>) -> Result<bool, io::Error> {
		if self.normal_output_is_suppressed() || self.opts.only_matching || self.binary_summary() {
			return Ok(true);
		}
		// The same rule as a matching line: a context line whose bytes the codeset
		// cannot represent is not printed, and it marks the file.
		if self.line_is_badly_encoded(ctx.bytes()) {
			self.bad_encoding = true;
			return Ok(true);
		}
		self.separate_group(ctx.absolute_byte_offset(), ctx.bytes())?;
		self.write_prefix(ctx.line_number(), ctx.absolute_byte_offset(), b'-')?;
		self.write_record(ctx.bytes())?;
		Ok(true)
	}

	fn context_break(&mut self, _searcher: &Searcher) -> Result<bool, io::Error> {
		// `-o` is deliberately NOT consulted here. It replaces the BODY of a record
		// with the match, and GNU grep 3.11 still separates the groups: `grep -B0 -o`
		// prints `--` between its three matches. This used to check `only_matching`
		// and lose the separator, which left a caller unable to tell three matches on
		// one line from three on lines far apart.
		if !self.normal_output_is_suppressed()
			&& !self.binary_summary()
			&& let Some(separator) = &self.opts.group_separator
		{
			self.out.write_all(separator)?;
			self.write_report_terminator()?;
			self.flush_record()?;
		}
		Ok(true)
	}

	fn binary_data(
		&mut self,
		_searcher: &Searcher,
		_binary_byte_offset: u64,
	) -> Result<bool, io::Error> {
		self.binary = true;
		if self.opts.binary_files == BinaryFiles::WithoutMatch {
			self.any_match = false;
			self.match_count = 0;
			return Ok(false);
		}
		Ok(true)
	}

	fn finish(&mut self, _searcher: &Searcher, _: &SinkFinish) -> Result<(), io::Error> {
		if self.opts.quiet {
			return Ok(());
		}
		if (self.binary_summary() || self.bad_encoding_summary()) && self.any_match {
			// STDERR, and GNU grep 3.11's wording. This used to write
			// `Binary file <path> matches` to STDOUT, which is grep 3.4's text and,
			// worse, its stream: `grep hit *.o | wc -l` counted the notice as a
			// matching line, and a caller reading stdout got a sentence where it
			// expected records. GNU moved the notice to stderr in 3.5 and reworded it,
			// and it is not a file error, so `-s` does NOT suppress it; `-q` does,
			// above, along with everything else.
			let _ = writeln!(
				veyyon_uutils_ctx::stderr(),
				"grep: {}: binary file matches",
				String::from_utf8_lossy(self.display)
			);
			return Ok(());
		}
		if self.opts.files_with_matches {
			if self.any_match {
				self.write_path_record()?;
			}
		} else if self.opts.files_without_match {
			if !self.any_match {
				self.write_path_record()?;
			}
		} else if self.opts.count {
			if self.opts.prefix_filename {
				self.out.write_all(self.display)?;
				if self.opts.null_paths {
					self.out.write_all(b"\0")?;
				} else {
					self.out.write_all(b":")?;
				}
			}
			write!(self.out, "{}", self.match_count)?;
			self.write_report_terminator()?;
			self.flush_record()?;
		}
		Ok(())
	}
}

/// Whether an input that matched, or did not, is one the run SELECTED.
///
/// For every mode but `-L` these are the same question, which is why the two
/// drifted apart: `process_reader` returned "this file matched" and every
/// caller treated it as "this file produced output", including the exit status.
/// `-L` LISTS the files that did NOT match, so a file that matched produces
/// nothing and is not selected. GNU grep and ripgrep both exit 1 when `-L`
/// lists nothing, and this builtin exited 0, reporting success for a search
/// whose whole output was empty.
///
/// This is the one place the distinction can be drawn, because the bool that
/// leaves here is all a caller ever sees.
fn selected_input(opts: &Options, any_match: bool) -> bool {
	if opts.files_without_match {
		!any_match
	} else {
		any_match
	}
}

/// The size GNU grep 3.11 assumes for an input whose length it cannot know.
///
/// A pipe or a terminal has no size to stat, so the width is computed from the
/// largest size a file could have instead of from a guess that would misalign
/// the moment the input got long. It is `off_t`'s maximum and not
/// `uintmax_t`'s, which is measurable: a piped input aligns to NINETEEN
/// columns, the digit count of 9223372036854775807, and not to twenty.
const UNKNOWN_INPUT_SIZE: u64 = i64::MAX as u64;

/// The column `-T` right-aligns this input's numeric fields in.
///
/// GNU grep 3.11 pads `-n` and `-b` to the digit count of the largest number
/// the input can produce, and uses ONE width for both fields. The rule,
/// measured against files built to exact sizes: the number is the input's size,
/// plus one when `-n` is on, since a byte offset starts at zero where a line
/// number starts at one. A 999-byte file therefore aligns `-b` to three columns
/// and `-n` to four; one byte more and both are four; and asking for both
/// fields at once gives them both the wider width.
///
/// Without `-T` the width is 1, which pads nothing: a number wider than one
/// column simply pushes past it. That keeps the padding out of the record
/// writer, which has one code path rather than two.
fn aligned_field_width(align_tabs: bool, numbers_lines: bool, usable_size: Option<u64>) -> usize {
	if !align_tabs {
		return 1;
	}
	let largest = usable_size
		.unwrap_or(UNKNOWN_INPUT_SIZE)
		.saturating_add(u64::from(numbers_lines));
	let mut width = 1usize;
	let mut remaining = largest / 10;
	while remaining != 0 {
		width += 1;
		remaining /= 10;
	}
	width
}

/// State that belongs to the RUN rather than to one input.
///
/// `printed` is why this is a struct rather than the `&mut bool` for
/// `had_error` it grew out of: the group separator between two files can only
/// be decided by something that outlives one input, and threading a second
/// `&mut bool` through the walk closure would have meant a second `Cell` beside
/// it. Both fields are monotone, which is what lets the walk copy the state, OR
/// into it, and write it back.
#[derive(Clone, Copy, Default)]
struct RunState {
	/// Whether any input failed, which the exit status reports.
	had_error: bool,
	/// Whether any input has printed a record yet.
	printed:   bool,
}

/// One input to search: its bytes, the name a diagnostic or a record prefix
/// calls it, and its size when it has one.
///
/// The three travel together because they describe the SAME input and are read
/// together at every call site: `-T` aligns its field to the size, a diagnostic
/// names the display path, and the reader is what the searcher walks. Passing
/// them separately made `process_reader` an eight-argument function whose
/// arguments could be transposed silently, since two of them are byte-ish.
struct Input<'a, R> {
	reader:      R,
	/// The name to print, which is the operand as the CALLER wrote it and never
	/// a path this crate resolved internally.
	display:     &'a [u8],
	/// `None` for a pipe, a directory or a device, which is what makes `-T`
	/// align to the widest number a file could hold instead of to this input's.
	usable_size: Option<u64>,
}

/// Search one input and return whether it contained a selected record.
fn process_reader<M: Matcher, R: Read, W: Write>(
	matcher: &M,
	searcher: &mut Searcher,
	input: Input<'_, R>,
	opts: &Options,
	out: &mut W,
	run: &mut RunState,
) -> io::Result<bool> {
	let Input { reader, display, usable_size } = input;
	let field_width = aligned_field_width(opts.initial_tab, opts.line_number, usable_size);
	let mut sink = GrepSink {
		out,
		matcher,
		display,
		opts,
		field_width,
		next_offset: None,
		match_count: 0,
		any_match: false,
		binary: false,
		follows_a_group: run.printed,
		printed_group: false,
		longest_cache: None,
		bad_encoding: false,
	};
	let outcome = searcher.search_reader(matcher, reader, &mut sink);
	// Recorded even when the search failed partway, because whatever it printed is
	// on stdout and the next input has to be separated from it.
	run.printed |= sink.printed_group;
	outcome?;
	Ok(selected_input(opts, sink.any_match))
}

fn display_path_for_operand(operand: &OsStr, resolved: &Path, path: &Path) -> PathBuf {
	let rel = path.strip_prefix(resolved).unwrap_or(path);
	if rel.as_os_str().is_empty() {
		PathBuf::from(operand)
	} else {
		Path::new(operand).join(rel)
	}
}

#[allow(clippy::too_many_arguments)]
fn search_file_path<M: Matcher, W: Write>(
	operand: &OsStr,
	resolved: &Path,
	path: &Path,
	matcher: &M,
	searcher: &mut Searcher,
	opts: &Options,
	out: &mut W,
	run: &mut RunState,
) -> bool {
	let display_path = display_path_for_operand(operand, resolved, path);
	match File::open(path) {
		Ok(file) => {
			let display = display_path.as_os_str().as_encoded_bytes();
			// The size is read from the OPEN file rather than the path, so it is the
			// file that is about to be searched and not whatever the name points at a
			// moment later. A directory or device gives no size, which is the same
			// answer a pipe gives: `-T` then aligns to the widest number a file could
			// hold, exactly as GNU grep does.
			let usable_size = file
				.metadata()
				.ok()
				.filter(|meta| meta.is_file())
				.map(|meta| meta.len());
			match process_reader(
				matcher,
				searcher,
				Input { reader: file, display, usable_size },
				opts,
				out,
				run,
			) {
				Ok(selected) => selected,
				Err(error) => {
					run.had_error = true;
					if !opts.no_messages {
						let _ = writeln!(
							veyyon_uutils_ctx::stderr(),
							"grep: {}: {}",
							display_path.to_string_lossy(),
							io_reason(&error)
						);
					}
					false
				},
			}
		},
		Err(error) => {
			run.had_error = true;
			if !opts.no_messages {
				let _ = writeln!(
					veyyon_uutils_ctx::stderr(),
					"grep: {}: {}",
					display_path.to_string_lossy(),
					io_reason(&error)
				);
			}
			false
		},
	}
}

fn grep_walk_request(
	root: &Path,
	follow_links: veyyon_walker::FollowLinks,
) -> veyyon_walker::WalkRequest {
	veyyon_walker::WalkRequest::new(root)
		.hidden(true)
		.gitignore(false)
		.skip_git(false)
		.skip_node_modules(false)
		.follow_links(follow_links)
		.detail(veyyon_walker::WalkDetail::Minimal)
		.order(veyyon_walker::WalkOrder::Unordered)
		.emit_root(true)
		.depth(0, usize::MAX)
		.visit_order(veyyon_walker::VisitOrder::PreOrder)
		.directory_errors(veyyon_walker::DirectoryErrorMode::Visit)
		.same_file_system(false)
		.cache(false)
		.filter(veyyon_walker::WalkFilter::all())
}

/// Recursively search a directory operand while pruning excluded directories.
#[allow(clippy::too_many_arguments)]
fn search_dir<M: Matcher, W: Write>(
	operand: &OsStr,
	resolved: &Path,
	matcher: &M,
	searcher: &mut Searcher,
	opts: &Options,
	rules: &PathRules,
	follow_links: veyyon_walker::FollowLinks,
	out: &mut W,
	run: &mut RunState,
) -> bool {
	let request = grep_walk_request(resolved, follow_links);
	let mut any = false;
	let run_state = std::cell::Cell::new(*run);
	let walk = request.for_each_entry_with_heartbeat(
		walk_end::cancellation_heartbeat(),
		|entry: veyyon_walker::EntryMeta<'_>| {
			if opts.quiet && any {
				return Ok(veyyon_walker::WalkDecision::Stop);
			}
			if entry.file_type == veyyon_walker::FileType::Dir {
				if entry.depth > 0 && !rules.allows_dir(Path::new(entry.relative_path)) {
					return Ok(veyyon_walker::WalkDecision::SkipDescend);
				}
				return Ok(veyyon_walker::WalkDecision::Include);
			}
			if entry.file_type != veyyon_walker::FileType::File
				|| !rules.allows_file(Path::new(entry.relative_path))
			{
				return Ok(veyyon_walker::WalkDecision::Skip);
			}
			let mut entry_run = run_state.get();
			let matched = search_file_path(
				operand,
				resolved,
				entry.absolute_path.as_ref(),
				matcher,
				searcher,
				opts,
				out,
				&mut entry_run,
			);
			run_state.set(entry_run);
			any |= matched;
			if opts.quiet && any {
				Ok(veyyon_walker::WalkDecision::Stop)
			} else {
				Ok(veyyon_walker::WalkDecision::Include)
			}
		},
		|error: veyyon_walker::DirectoryError<'_>| {
			let mut failed = run_state.get();
			failed.had_error = true;
			run_state.set(failed);
			if !opts.no_messages {
				let display_path = display_path_for_operand(operand, resolved, error.path);
				let _ = writeln!(
					veyyon_uutils_ctx::stderr(),
					"grep: {}: {}",
					display_path.to_string_lossy(),
					error.error
				);
			}
			Ok(veyyon_walker::WalkDecision::Include)
		},
	);
	*run = run_state.get();
	match walk_end::classify_walk_end("grep", walk, |path| {
		display_path_for_operand(operand, resolved, path)
	}) {
		walk_end::WalkEnd::Finished => any,
		// Cancellation sets the status and stays silent: the shell wrapper owns
		// the user-visible cancelled status.
		walk_end::WalkEnd::Cancelled => {
			run.had_error = true;
			any
		},
		walk_end::WalkEnd::Failed(message) => {
			run.had_error = true;
			if !opts.no_messages {
				let _ = writeln!(veyyon_uutils_ctx::stderr(), "{message}");
			}
			any
		},
	}
}

/// What GNU grep prints for an operating-system failure: the reason alone.
///
/// `io::Error`'s own `Display` appends ` (os error N)`, which GNU never prints.
/// `grep: missing.txt: No such file or directory` is the whole line, and a
/// script matching on that text does not expect a code after it. The suffix is
/// stripped rather than the message being rebuilt from `raw_os_error`, because
/// an error that is NOT an OS error (a broken pipe from our own writer, a
/// decode failure) has no code and its message is already the reason.
///
/// The sibling `rg` builtin deliberately KEEPS the suffix, because ripgrep
/// prints it: `rg: hit: ... No such file or directory (os error 2)`. The two
/// reference tools disagree, so this owner belongs to the `grep` half alone.
fn io_reason(error: &io::Error) -> String {
	let text = error.to_string();
	match (error.raw_os_error(), text.rfind(" (os error ")) {
		(Some(_), Some(at)) if text.ends_with(')') => text[..at].to_string(),
		_ => text,
	}
}

fn read_auxiliary_file(path: &OsStr) -> Result<Vec<u8>, String> {
	let mut bytes = Vec::new();
	let result = if path == OsStr::new("-") {
		veyyon_uutils_ctx::stdin().read_to_end(&mut bytes)
	} else {
		File::open(veyyon_uutils_ctx::resolve(path)).and_then(|mut file| file.read_to_end(&mut bytes))
	};
	result
		.map(|_| bytes)
		.map_err(|error| format!("{}: {}", path.to_string_lossy(), io_reason(&error)))
}

fn pattern_file_lines(bytes: &[u8]) -> Vec<String> {
	if bytes.is_empty() {
		return Vec::new();
	}
	String::from_utf8_lossy(bytes)
		.split_terminator('\n')
		.map(str::to_owned)
		.collect()
}

fn resolve_patterns(cli: &Cli) -> Result<(Vec<String>, Vec<OsString>), String> {
	let has_explicit_patterns = !cli.patterns.is_empty() || !cli.pattern_files.is_empty();
	let mut patterns = Vec::new();
	let mut files = Vec::new();

	if has_explicit_patterns {
		for pattern in &cli.patterns {
			patterns.extend(pattern.split('\n').map(str::to_owned));
		}
		for path in &cli.pattern_files {
			patterns.extend(pattern_file_lines(&read_auxiliary_file(path)?));
		}
		files.clone_from(&cli.args);
		return Ok((patterns, files));
	}

	let mut args = cli.args.iter();
	let Some(pattern) = args.next() else {
		return Err("no pattern given\nUsage: grep [OPTION]... PATTERN [FILE]...".to_owned());
	};
	patterns.extend(pattern.to_string_lossy().split('\n').map(str::to_owned));
	files.extend(args.cloned());
	Ok((patterns, files))
}

fn collect_rule_specs(
	cli: &Cli,
	matches: &ArgMatches,
) -> Result<(Vec<RuleSpec>, Vec<RuleSpec>), String> {
	let mut files = Vec::new();
	if let Some(indices) = matches.indices_of("include") {
		for (index, pattern) in indices.zip(&cli.include) {
			files.push(RuleSpec { index, include: true, pattern: pattern.clone() });
		}
	}
	if let Some(indices) = matches.indices_of("exclude") {
		for (index, pattern) in indices.zip(&cli.exclude) {
			files.push(RuleSpec { index, include: false, pattern: pattern.clone() });
		}
	}
	if let Some(indices) = matches.indices_of("exclude_from") {
		for (index, path) in indices.zip(&cli.exclude_from) {
			for pattern in pattern_file_lines(&read_auxiliary_file(path)?) {
				files.push(RuleSpec { index, include: false, pattern });
			}
		}
	}

	let mut dirs = Vec::new();
	if let Some(indices) = matches.indices_of("include_dir") {
		for (index, pattern) in indices.zip(&cli.include_dir) {
			dirs.push(RuleSpec { index, include: true, pattern: pattern.clone() });
		}
	}
	if let Some(indices) = matches.indices_of("exclude_dir") {
		for (index, pattern) in indices.zip(&cli.exclude_dir) {
			dirs.push(RuleSpec { index, include: false, pattern: pattern.clone() });
		}
	}
	Ok((files, dirs))
}

fn compile_rules(mut specs: Vec<RuleSpec>) -> Result<Vec<PathRule>, String> {
	specs.sort_by_key(|spec| spec.index);
	specs
		.into_iter()
		.map(|spec| {
			Glob::new(&spec.pattern)
				.map(|glob| PathRule { include: spec.include, matcher: glob.compile_matcher() })
				.map_err(|error| format!("{}: {error}", spec.pattern))
		})
		.collect()
}

fn build_path_rules(cli: &Cli, matches: &ArgMatches) -> Result<PathRules, String> {
	let (files, dirs) = collect_rule_specs(cli, matches)?;
	Ok(PathRules { files: compile_rules(files)?, dirs: compile_rules(dirs)? })
}

/// GNU `grep` options, translated into the shared searcher spec.
///
/// The translation IS the surface: `--binary-files` has three spellings here
/// and two in `rg`, and neither vocabulary belongs in the other. What the two
/// share is the construction, which is why only this function is grep-shaped
/// and `veyyon_grep_kernel::build_searcher` is not.
fn build_searcher(cli: &Cli, opts: &Options, max_count: Option<u64>) -> Searcher {
	let binary_detection = if cli.null_data || opts.binary_files == BinaryFiles::Text {
		BinaryDetection::none()
	} else if opts.binary_files == BinaryFiles::WithoutMatch {
		BinaryDetection::quit(b'\0')
	} else {
		BinaryDetection::convert(b'\0')
	};
	kernel_build_searcher(SearcherSpec {
		line_number: opts.line_number,
		before_context: opts.before,
		after_context: opts.after,
		invert_match: cli.invert,
		binary_detection,
		max_matches: max_count,
		// `grep -z` makes NUL the record separator, so a "line" runs to the next
		// NUL rather than to the next newline.
		line_terminator: cli.null_data.then(|| LineTerminator::byte(b'\0')),
		..SearcherSpec::default()
	})
}

#[allow(clippy::too_many_arguments)]
fn execute_search<M: Matcher>(
	cli: &Cli,
	matcher: &M,
	files: &[OsString],
	directory_action: DirectoryAction,
	follow_links: veyyon_walker::FollowLinks,
	rules: &PathRules,
	opts: &Options,
	max_count: Option<u64>,
) -> i32 {
	let mut searcher = build_searcher(cli, opts, max_count);
	let mut out = BufWriter::new(veyyon_uutils_ctx::stdout());
	let mut any_selected = false;
	let mut run = RunState::default();
	let mut processed_operand = false;

	for operand in files {
		if opts.quiet && any_selected {
			break;
		}
		if processed_operand && veyyon_uutils_ctx::is_cancelled() {
			run.had_error = true;
			break;
		}
		processed_operand = true;

		if operand == OsStr::new("-") {
			let display = cli
				.label
				.as_deref()
				.unwrap_or_else(|| OsStr::new("(standard input)"))
				.as_encoded_bytes();
			match process_reader(
				matcher,
				&mut searcher,
				Input {
					reader: veyyon_uutils_ctx::stdin(),
					display,
					usable_size: veyyon_uutils_ctx::stdin_size(),
				},
				opts,
				&mut out,
				&mut run,
			) {
				Ok(selected) => any_selected |= selected,
				Err(error) => {
					run.had_error = true;
					if !opts.no_messages {
						let _ = writeln!(
							veyyon_uutils_ctx::stderr(),
							"grep: (standard input): {}",
							io_reason(&error)
						);
					}
				},
			}
			if veyyon_uutils_ctx::is_cancelled() {
				run.had_error = true;
				break;
			}
			continue;
		}

		let resolved = veyyon_uutils_ctx::resolve(operand);
		match std::fs::metadata(&resolved) {
			Ok(metadata) if metadata.is_dir() => match directory_action {
				DirectoryAction::Recurse => {
					if rules.allows_dir(Path::new(operand))
						&& search_dir(
							operand.as_os_str(),
							&resolved,
							matcher,
							&mut searcher,
							opts,
							rules,
							follow_links,
							&mut out,
							&mut run,
						) {
						any_selected = true;
					}
				},
				DirectoryAction::Skip => {},
				DirectoryAction::Read => {
					run.had_error = true;
					// `-s` hides the sentence and never the status, which is the whole
					// contract of `--no-messages`: a script still learns from the exit
					// code that an operand could not be read. This was the one report in
					// the builtin that ignored the flag, so `grep -s pattern somedir`
					// printed where `grep -s pattern missingfile` stayed quiet.
					if !opts.no_messages {
						let _ = writeln!(
							veyyon_uutils_ctx::stderr(),
							"grep: {}: Is a directory",
							operand.to_string_lossy()
						);
					}
					// GNU grep OPENED the directory and then read nothing from it, so a
					// summary mode still reports it as an input that matched nothing:
					// measured on GNU grep 3.11, `grep -c hit somedir a.txt` prints
					// `somedir:0` beside `a.txt:2` and `grep -L hit somedir a.txt` lists
					// it, while `-l` and every record mode say nothing about it. A
					// missing operand gets no such line, because nothing ever opened it.
					// Searching an EMPTY reader is how that is spelled here: the same
					// printer answers, so the count line, the `-Z` terminator and the
					// listing rules cannot drift from the ones every other input gets.
					if let Ok(selected) = process_reader(
						matcher,
						&mut searcher,
						Input {
							reader:      io::empty(),
							display:     operand.as_encoded_bytes(),
							usable_size: None,
						},
						opts,
						&mut out,
						&mut run,
					) {
						any_selected |= selected;
					}
				},
			},
			Ok(metadata) => {
				if cli.devices == Some(DeviceAction::Skip) && !metadata.is_file() {
					continue;
				}
				if !rules.allows_file(Path::new(operand)) {
					continue;
				}
				if search_file_path(
					operand.as_os_str(),
					&resolved,
					&resolved,
					matcher,
					&mut searcher,
					opts,
					&mut out,
					&mut run,
				) {
					any_selected = true;
				}
			},
			Err(error) => {
				run.had_error = true;
				if !opts.no_messages {
					let _ = writeln!(
						veyyon_uutils_ctx::stderr(),
						"grep: {}: {}",
						operand.to_string_lossy(),
						io_reason(&error)
					);
				}
			},
		}
		if veyyon_uutils_ctx::is_cancelled() {
			run.had_error = true;
			break;
		}
	}

	let _ = out.flush();
	if opts.quiet {
		if any_selected {
			0
		} else if run.had_error {
			2
		} else {
			1
		}
	} else if run.had_error {
		2
	} else if any_selected {
		0
	} else {
		1
	}
}

fn report_clap_error(error: clap::Error) -> i32 {
	let rendered = error.to_string();
	if error.use_stderr() {
		let _ = write!(veyyon_uutils_ctx::stderr(), "{rendered}");
		2
	} else {
		let _ = write!(veyyon_uutils_ctx::stdout(), "{rendered}");
		0
	}
}

/// Runs the in-process grep builtin and returns a GNU-compatible exit code.
/// The clap command backing `grep`, before any argument has been read.
///
/// Named after the uutils convention that `veyyon-uu-diff` already follows, so
/// the two builtins expose their argument surface the same way.
#[must_use]
pub fn uu_app() -> clap::Command {
	Cli::command()
}

/// Turn `argv` into the parsed configuration, doing nothing else.
///
/// The deciding half of [`run`], split out so it has exactly one definition.
/// Both [`run`] and [`try_parse_argv`] call it, which is what keeps the fuzzed
/// parse and the shipped parse the same code rather than two things that agree
/// today.
fn parse(argv: Vec<OsString>) -> Result<(Cli, ArgMatches), clap::Error> {
	let matches = uu_app().try_get_matches_from(normalize_context_args(argv))?;
	let cli = Cli::from_arg_matches(&matches)?;
	Ok((cli, matches))
}

/// Parse `argv` and discard the result, reporting only whether it was accepted.
///
/// This exists so argument handling can be tested and fuzzed. [`run`] is the
/// natural entry point and the wrong one to point a fuzzer at: it opens files,
/// walks directories and writes output, so generating inputs for it would
/// generate filesystem operations rather than parses. This call touches nothing
/// outside the `argv` it is handed, and it is the same parse [`run`] performs,
/// so a defect it finds is a defect users hit.
///
/// # Errors
///
/// Returns the `clap` error for an argv the command rejects, including the
/// not-really-errors clap uses for `--help` and `--version`.
pub fn try_parse_argv(argv: Vec<OsString>) -> Result<(), clap::Error> {
	parse(argv).map(|_| ())
}

pub fn run(argv: Vec<OsString>) -> i32 {
	let (cli, matches) = match parse(argv) {
		Ok(parsed) => parsed,
		Err(error) => return report_clap_error(error),
	};

	let (mut patterns, mut files) = match resolve_patterns(&cli) {
		Ok(resolved) => resolved,
		Err(error) => {
			let _ = writeln!(veyyon_uutils_ctx::stderr(), "grep: {error}");
			return 2;
		},
	};
	let directory_action = resolve_directory_action(&cli, &matches);
	if files.is_empty() {
		files.push(OsString::from(if directory_action == DirectoryAction::Recurse {
			"."
		} else {
			"-"
		}));
	}

	let max_count = match resolve_max_count(&cli) {
		Ok(max_count) => max_count,
		Err(error) => {
			let _ = writeln!(veyyon_uutils_ctx::stderr(), "grep: {error}");
			return 2;
		},
	};
	let rules = match build_path_rules(&cli, &matches) {
		Ok(rules) => rules,
		Err(error) => {
			let _ = writeln!(veyyon_uutils_ctx::stderr(), "grep: {error}");
			return 2;
		},
	};
	let mode = match resolve_match_mode(&matches) {
		Ok(mode) => mode,
		Err(error) => {
			let _ = writeln!(veyyon_uutils_ctx::stderr(), "grep: {error}");
			return 2;
		},
	};
	let built = match build_matcher(&patterns, &cli, mode, resolve_ignore_case(&matches)) {
		Ok(built) => built,
		Err(error) => {
			let _ = writeln!(veyyon_uutils_ctx::stderr(), "grep: {error}");
			return 2;
		},
	};
	patterns.clear();

	let (files_with_matches, files_without_match) = resolve_file_list_modes(&matches);
	// `-o` is absent from this list on purpose: it drops context LINES, which the
	// sink does, and keeps the GROUPING, which needs the radius to reach the
	// searcher. A summary mode drops both.
	let suppress_context = cli.count || files_with_matches || files_without_match || cli.quiet;
	let (before, after) = if suppress_context {
		(0, 0)
	} else {
		resolve_context(&cli, &matches)
	};
	// A request of zero lines still groups, and the searcher will not say where the
	// gaps are, so the sink is told to look for them itself.
	let groups_output = !suppress_context
		&& ["after_context", "before_context", "context"]
			.into_iter()
			.any(|flag| last_index(&matches, flag).is_some());
	let zero_radius_groups = groups_output && before == 0 && after == 0;
	let prefix_filename = resolve_filename_prefix(&matches)
		.unwrap_or(directory_action == DirectoryAction::Recurse || files.len() > 1);
	let opts = Options {
		line_number: cli.line_number,
		byte_offset: cli.byte_offset,
		count: cli.count,
		files_with_matches,
		files_without_match,
		only_matching: cli.only_matching,
		before,
		after,
		no_messages: cli.no_messages,
		quiet: cli.quiet,
		prefix_filename,
		initial_tab: cli.initial_tab,
		null_paths: cli.null_paths,
		record_terminator: if cli.null_data { b'\0' } else { b'\n' },
		group_separator: resolve_group_separator(&cli, &matches),
		groups_output,
		zero_radius_groups,
		line_buffered: cli.line_buffered,
		binary_files: resolve_binary_files(&cli, &matches),
		multibyte_locale: locale_is_multibyte(),
		posix_longest: built.posix_longest,
	};
	let follow_links = resolve_follow_links(&cli, &matches);

	match built.matcher {
		CompiledMatcher::Rust(matcher) => execute_search(
			&cli,
			&matcher,
			&files,
			directory_action,
			follow_links,
			&rules,
			&opts,
			max_count,
		),
		CompiledMatcher::Pcre(matcher) => execute_search(
			&cli,
			&matcher,
			&files,
			directory_action,
			follow_links,
			&rules,
			&opts,
			max_count,
		),
	}
}

#[cfg(test)]
mod tests {
	use std::{
		collections::HashMap,
		io::Cursor,
		sync::{Arc, atomic::AtomicBool},
	};

	use parking_lot::Mutex;
	use veyyon_uutils_ctx::{ScopeIo, scope};

	use super::*;

	/// Sink that collects writes into a shared buffer for assertions.
	struct SharedBuf(Arc<Mutex<Vec<u8>>>);

	impl Write for SharedBuf {
		fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
			self.0.lock().extend_from_slice(buf);
			Ok(buf.len())
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	/// Run the `grep` builtin with `args` (no argv[0]) over `stdin`, returning
	/// `(exit_code, stdout, stderr)`.
	fn run_grep(args: &[&str], stdin: &str) -> (i32, String, String) {
		run_grep_in(args, stdin, &std::env::temp_dir())
	}

	fn run_grep_in(args: &[&str], stdin: &str, cwd: &Path) -> (i32, String, String) {
		let out = Arc::new(Mutex::new(Vec::new()));
		let err = Arc::new(Mutex::new(Vec::new()));
		let io = ScopeIo {
			stdin:                 Box::new(Cursor::new(stdin.as_bytes().to_vec())),
			stdin_fd:              None,
			stdin_is_search_input: true,
			stdout:                Box::new(SharedBuf(Arc::clone(&out))),
			stdout_is_terminal:    false,
			stderr:                Box::new(SharedBuf(Arc::clone(&err))),
			cwd:                   cwd.to_path_buf(),
			env:                   HashMap::new(),
			cancel:                Arc::new(AtomicBool::new(false)),
		};
		let argv: Vec<OsString> = std::iter::once("grep")
			.chain(args.iter().copied())
			.map(OsString::from)
			.collect();
		let code = scope(io, || run(argv));
		let stdout = String::from_utf8(out.lock().clone()).expect("utf8 stdout");
		let stderr = String::from_utf8(err.lock().clone()).expect("utf8 stderr");
		(code, stdout, stderr)
	}

	/// Run the builtin over raw `stdin` bytes with an explicit environment,
	/// returning `(exit_code, stdout_bytes, stderr)`.
	///
	/// The encoding rule reads `LC_ALL`/`LC_CTYPE`/`LANG` out of the scope, so a
	/// suite about it needs to set them, and `-a` puts bytes on stdout that are
	/// not UTF-8, so stdout comes back as bytes.
	fn run_grep_env(
		args: &[&str],
		stdin: &[u8],
		cwd: &Path,
		env: &[(&str, &str)],
	) -> (i32, Vec<u8>, String) {
		let out = Arc::new(Mutex::new(Vec::new()));
		let err = Arc::new(Mutex::new(Vec::new()));
		let io = ScopeIo {
			stdin:                 Box::new(Cursor::new(stdin.to_vec())),
			stdin_fd:              None,
			stdin_is_search_input: true,
			stdout:                Box::new(SharedBuf(Arc::clone(&out))),
			stdout_is_terminal:    false,
			stderr:                Box::new(SharedBuf(Arc::clone(&err))),
			cwd:                   cwd.to_path_buf(),
			env:                   env
				.iter()
				.map(|(key, value)| ((*key).to_string(), (*value).to_string()))
				.collect(),
			cancel:                Arc::new(AtomicBool::new(false)),
		};
		let argv: Vec<OsString> = std::iter::once("grep")
			.chain(args.iter().copied())
			.map(OsString::from)
			.collect();
		let code = scope(io, || run(argv));
		let stdout = out.lock().clone();
		let stderr = String::from_utf8(err.lock().clone()).expect("utf8 stderr");
		(code, stdout, stderr)
	}

	use crate::test_temp::{TempTree, unique_tree};

	#[test]
	fn max_count_accepts_compact_and_long_values() {
		for option in ["-m1", "--max-count=1"] {
			let (code, stdout, stderr) = run_grep(&[option, "hit"], "hit\nmiss\nhit\n");
			assert_eq!(code, 0, "{option}: {stderr}");
			assert_eq!(stdout, "hit\n", "{option}");
		}

		let (code, stdout, stderr) = run_grep(&["-m0", "hit"], "hit\n");
		assert_eq!(code, 1, "{stderr}");
		assert!(stdout.is_empty());
	}

	#[test]
	fn pattern_file_combines_patterns_without_consuming_a_file_operand() {
		let tree = unique_tree("patterns");
		std::fs::write(tree.join("patterns"), "alpha\nbeta\n").expect("pattern file written");
		std::fs::write(tree.join("haystack"), "alpha\ngamma\nbeta\n").expect("haystack written");

		let (code, stdout, stderr) = run_grep_in(&["-f", "patterns", "haystack"], "", &tree);
		assert_eq!(code, 0, "{stderr}");
		assert_eq!(stdout, "alpha\nbeta\n");

		let _ = std::fs::remove_dir_all(tree);
	}

	#[test]
	fn perl_mode_supports_lookbehind() {
		let (code, stdout, stderr) = run_grep(&["-P", "(?<=foo)bar"], "foobar\nbar\n");
		assert_eq!(code, 0, "{stderr}");
		assert_eq!(stdout, "foobar\n");
	}

	#[test]
	fn byte_offsets_labels_and_nul_filename_separators_are_rendered() {
		let (code, stdout, stderr) = run_grep(&["-bn", "hit"], "no\nhit\n");
		assert_eq!(code, 0, "{stderr}");
		assert_eq!(stdout, "2:3:hit\n");

		let (code, stdout, stderr) = run_grep(&["--label=pipe", "-HZ", "hit"], "hit\n");
		assert_eq!(code, 0, "{stderr}");
		assert_eq!(stdout.as_bytes(), b"pipe\0hit\n");
	}

	#[test]
	fn numeric_context_uses_the_configured_group_separator() {
		let input = "a\nhit\nb\ngap\nc\nhit\nd\n";
		let (code, stdout, stderr) = run_grep(&["-1", "--group-separator=@", "hit"], input);
		assert_eq!(code, 0, "{stderr}");
		assert_eq!(stdout, "a\nhit\nb\n@\nc\nhit\nd\n");
	}

	#[test]
	fn recursive_include_and_exclude_dir_rules_filter_the_walk() {
		let tree = unique_tree("filters");
		std::fs::write(tree.join("keep.rs"), "hit\n").expect("included file written");
		std::fs::write(tree.join("drop.txt"), "hit\n").expect("excluded file written");
		std::fs::create_dir(tree.join("vendor")).expect("excluded directory created");
		std::fs::write(tree.join("vendor/hidden.rs"), "hit\n").expect("excluded file written");

		let (code, stdout, stderr) =
			run_grep_in(&["-r", "--include=*.rs", "--exclude-dir=vendor", "hit", "."], "", &tree);
		assert_eq!(code, 0, "{stderr}");
		assert!(stdout.contains("keep.rs:hit"), "{stdout:?}");
		assert!(!stdout.contains("drop.txt"), "{stdout:?}");
		assert!(!stdout.contains("hidden.rs"), "{stdout:?}");

		let _ = std::fs::remove_dir_all(tree);
	}

	#[test]
	fn unbalanced_paren_pattern_matches_literally() {
		// Regression: `grep "fail)"` used to abort with `regex parse error:
		// unopened group`. It must now match the literal text and exit 0.
		let (code, stdout, stderr) = run_grep(&["-A", "1", "fail)"], "ok\n(1 fail)\nnext\n");
		assert_eq!(code, 0, "stderr: {stderr}");
		assert!(stderr.is_empty(), "no error expected, got: {stderr}");
		assert!(stdout.contains("(1 fail)"), "matched line missing: {stdout}");
		assert!(stdout.contains("next"), "after-context line missing: {stdout}");
	}

	#[test]
	fn extended_flag_reports_parse_error() {
		// -E opts into strict extended-regex syntax: the bad pattern is an error.
		let (code, _stdout, stderr) = run_grep(&["-E", "fail)"], "fail)\n");
		assert_eq!(code, 2);
		assert!(stderr.contains("grep:"), "expected a grep error, got: {stderr}");
	}

	#[test]
	fn valid_regex_still_applies() {
		// A parseable pattern is used as a regex, not matched literally.
		let (code, stdout, _err) = run_grep(&["fo+"], "foooo\nbar\n");
		assert_eq!(code, 0);
		assert!(stdout.contains("foooo"));
		assert!(!stdout.contains("bar"));
	}

	#[test]
	fn multi_pattern_keeps_valid_alternative_as_regex() {
		// Per-pattern fallback: valid `fo+` stays a regex while `bar)` is escaped.
		let (code, stdout, err) = run_grep(&["-e", "fo+", "-e", "bar)", "-h"], "foooo\nbar)\nbaz\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert!(stdout.contains("foooo"), "regex alternative should match: {stdout}");
		assert!(stdout.contains("bar)"), "literal alternative should match: {stdout}");
		assert!(!stdout.contains("baz"), "non-matching line leaked: {stdout}");
	}

	#[test]
	fn color_flag_is_accepted_and_ignored() {
		// Regression for #3755: the universal `alias grep='grep --color=auto'`
		// must not break bare `grep` in shell pipelines.
		for color in ["--color=auto", "--color=always", "--color=never", "--color", "--colour=auto"] {
			let (code, stdout, stderr) = run_grep(&[color, "foo"], "foo\nbar\n");
			assert_eq!(code, 0, "{color}: stderr: {stderr}");
			assert!(stderr.is_empty(), "{color}: unexpected stderr: {stderr}");
			assert_eq!(stdout, "foo\n", "{color}: matched lines: {stdout:?}");
		}
	}

	#[test]
	fn version_flag_prints_and_exits_zero() {
		// `grep --version` is the universal probe shells run; the builtin must
		// not reject it with exit 2.
		let (code, stdout, stderr) = run_grep(&["--version"], "");
		assert_eq!(code, 0, "stderr: {stderr}");
		assert!(stderr.is_empty(), "unexpected stderr: {stderr}");
		assert!(
			stdout.contains("grep") && stdout.contains("veyyon-uu-grep"),
			"version output should identify the builtin, got: {stdout:?}"
		);
	}

	/// Run `grep` with a pre-set cancel flag, mirroring how the shell wrapper
	/// flips the flag when an abort/timeout fires while the blocking task is
	/// still walking. Returns `(exit, stdout, stderr)`.
	fn run_grep_cancelled(args: &[&str], cwd: &Path) -> (i32, String, String) {
		let out = Arc::new(Mutex::new(Vec::new()));
		let err = Arc::new(Mutex::new(Vec::new()));
		let io = ScopeIo {
			stdin:                 Box::new(io::empty()),
			stdin_fd:              None,
			stdin_is_search_input: false,
			stdout:                Box::new(SharedBuf(Arc::clone(&out))),
			stdout_is_terminal:    false,
			stderr:                Box::new(SharedBuf(Arc::clone(&err))),
			cwd:                   cwd.to_path_buf(),
			env:                   HashMap::new(),
			cancel:                Arc::new(AtomicBool::new(true)),
		};
		let argv: Vec<OsString> = std::iter::once("grep")
			.chain(args.iter().copied())
			.map(OsString::from)
			.collect();
		let code = scope(io, || run(argv));
		let stdout = String::from_utf8(out.lock().clone()).expect("utf8 stdout");
		let stderr = String::from_utf8(err.lock().clone()).expect("utf8 stderr");
		(code, stdout, stderr)
	}

	#[test]
	fn recursive_search_observes_scope_cancellation() {
		// Regression for #3933: recursive grep used to pass a no-op heartbeat to
		// veyyon_walker, so directory walks ignored the uutils cancel flag and the
		// shell-side abort/timeout waited for the whole tree to be scanned.
		// The walk must now bail out before scanning any file when the flag is
		// already set, and it must do so without printing an "interrupted"
		// diagnostic — the shell wrapper owns the user-visible status.
		let tree = unique_tree("cancel");
		let walk_root = tree.join("walk-root");
		std::fs::create_dir_all(&walk_root).expect("walk root should be created");
		std::fs::write(walk_root.join("haystack.txt"), "match-me\n")
			.expect("walked file should be written");
		let later_file = tree.join("later.txt");
		std::fs::write(&later_file, "match-me\n").expect("later file should be written");

		let (code, stdout, stderr) = run_grep_cancelled(
			&[
				"-r",
				"match-me",
				walk_root.to_str().expect("utf8 path"),
				later_file.to_str().expect("utf8 path"),
			],
			&tree,
		);

		// Walker must have observed the heartbeat before visiting the file,
		// and the operand loop must not continue into the later regular file
		// after cancellation is observed.
		assert!(stdout.is_empty(), "cancelled walk should not output matches: {stdout:?}");
		assert!(
			stderr.is_empty(),
			"cancelled walk should stay silent — diagnostic is the shell's job: {stderr:?}"
		);
		assert_eq!(code, 2, "interrupted directory walk should report had_error (exit 2)");

		let _ = std::fs::remove_dir_all(&tree);
	}

	/// What the exit status reports when a mode's output is a LIST of files.
	///
	/// WHY THIS SUITE EXISTS. `grep`'s exit status is 0 when something was
	/// selected and 1 when nothing was, and for every mode but `-L` "selected"
	/// and "matched" are the same word. `-L` lists the files that did NOT
	/// match, so a file that matched produces no output at all, and
	/// this builtin still reported 0 for it: success, for a run whose entire
	/// output was empty.
	///
	/// The shape of the failure is what makes it worth a suite. `if grep -L
	/// pattern file; then` is how a script asks "is there a file here without
	/// this line", and the wrong answer is not a crash or a diagnostic, it is
	/// the opposite boolean, silently. GNU grep and ripgrep both exit 1
	/// here, checked against both while writing this.
	///
	/// Every case is a PAIR, the matching input and the non-matching one,
	/// because "exits 1" on its own is also what a mode that never selects
	/// anything does.
	mod list_modes_report_what_they_listed {
		use super::*;

		/// `-L` on a file that matches: nothing listed, so nothing was selected.
		#[test]
		fn files_without_match_exits_one_when_the_file_matches() {
			let (code, stdout, stderr) = run_grep(&["-L", "hit"], "one\nhit\ntwo\n");

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "");
		}

		/// `-L` on a file that does not match: the file is listed, so the run
		/// selected something.
		#[test]
		fn files_without_match_exits_zero_when_it_lists_the_file() {
			let (code, stdout, stderr) = run_grep(&["-L", "hit"], "one\ntwo\n");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "(standard input)\n");
		}

		/// `-l` is the mirror, and its status is NOT inverted. This is what makes
		/// the inversion a per-mode fact: a single global flip would turn this
		/// pair red.
		#[test]
		fn files_with_matches_keeps_the_ordinary_exit_status() {
			let (listed, stdout, stderr) = run_grep(&["-l", "hit"], "one\nhit\n");
			assert_eq!(listed, 0, "{stderr}");
			assert_eq!(stdout, "(standard input)\n");

			let (empty, stdout, stderr) = run_grep(&["-l", "hit"], "one\ntwo\n");
			assert_eq!(empty, 1, "{stderr}");
			assert_eq!(stdout, "");
		}

		/// And ordinary matching, which shares the same accumulator, is unmoved
		/// by the change.
		#[test]
		fn an_ordinary_search_still_reports_a_hit_and_a_miss() {
			let (hit, stdout, stderr) = run_grep(&["hit"], "one\nhit\n");
			assert_eq!(hit, 0, "{stderr}");
			assert_eq!(stdout, "hit\n");

			let (miss, stdout, stderr) = run_grep(&["absent"], "one\nhit\n");
			assert_eq!(miss, 1, "{stderr}");
			assert_eq!(stdout, "");
		}

		/// `-q` under `-L` reports the same answer as `-L` alone, and prints
		/// nothing either way. The quiet path takes its own early exit, so it
		/// is the branch most likely to keep the old meaning after a change to
		/// the shared one.
		#[test]
		fn quiet_agrees_with_the_list_mode_it_silences() {
			let (matched, stdout, _) = run_grep(&["-q", "-L", "hit"], "one\nhit\n");
			assert_eq!(matched, 1);
			assert_eq!(stdout, "");

			let (unmatched, stdout, _) = run_grep(&["-q", "-L", "hit"], "one\ntwo\n");
			assert_eq!(unmatched, 0);
			assert_eq!(stdout, "");
		}

		/// The sibling contract this builtin already had right, pinned so it
		/// stays that way: `-q` with a context request prints nothing. The `rg`
		/// builtin leaked a before-context line here, because its predicate
		/// omitted quiet while this one includes it.
		#[test]
		fn quiet_with_context_prints_nothing() {
			let (code, stdout, stderr) = run_grep(&["-q", "-C1", "hit"], "one\nhit\ntwo\n");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "");
		}
	}

	/// Both engines read one derivation of the flags.
	///
	/// WHY THIS SUITE EXISTS. `-P` compiles with PCRE2 and every other mode with
	/// the Rust engine, and each branch used to derive case, word and whole-line
	/// from `cli` itself. Two spellings of three decisions is six chances to
	/// disagree, and a disagreement here does not fail: it changes what a search
	/// RETURNS depending only on whether `-P` was passed, which is recall loss
	/// with no error.
	///
	/// The suite has two halves on purpose. The derivation tests read the flag
	/// set directly, because that is the only way to assert a rule whose effect
	/// the two engines agree on anyway (`-x` cancelling `-w`). The engine tests
	/// then drive both engines through the CLI, so the derivation being right is
	/// not mistaken for it being APPLIED.
	mod both_engines_read_one_set_of_flags {
		use super::*;

		/// Derive the flag set the way [`run`] does, from a real parse.
		fn flags_for(args: &[&str]) -> GrepMatcherFlags {
			let argv: Vec<OsString> = std::iter::once("grep")
				.chain(args.iter().copied())
				.map(OsString::from)
				.collect();
			let (cli, matches) = parse(argv).expect("argv should parse");
			GrepMatcherFlags::from_cli(&cli, resolve_ignore_case(&matches))
		}

		/// `-x` BEATS `-w` REGARDLESS OF ORDER, which is where this tool and the
		/// `rg` builtin in this same crate deliberately disagree.
		///
		/// PROBED ON BOTH TOOLS against the same fixture, `hit` / `hit there` /
		/// `xhitx`. GNU grep 3.11 prints only `hit` for `-w -x` AND for `-x -w`.
		/// Real ripgrep 15.1.0 prints only `hit` for `-w -x` but `hit` and
		/// `hit there` for `-x -w`, because its negatable and overriding flags
		/// are last-wins. So `rg` resolves this pair with clap's
		/// `overrides_with` and this tool resolves it with a fixed precedence,
		/// and neither is a mistake.
		///
		/// This case exists because the fixed precedence LOOKS like the bug that
		/// was just fixed in `rg`, and the next reader to notice the asymmetry
		/// should find a failing test rather than a tempting cleanup.
		#[test]
		fn x_beats_w_regardless_of_order() {
			for args in [&["-w", "-x", "hit"][..], &["-x", "-w", "hit"][..]] {
				let flags = flags_for(args);
				assert!(flags.whole_line, "whole-line anchoring survives for {args:?}");
				assert!(!flags.word, "word anchoring is dropped for {args:?}");
			}

			// The behavioural half, so the flag derivation is not the only thing
			// pinned: whole-line matching rejects the longer line in both orders.
			let haystack = "hit\nhit there\nxhitx\n";
			assert_eq!(run_grep(&["-w", "hit"], haystack).1, "hit\nhit there\n", "-w alone");
			assert_eq!(run_grep(&["-x", "hit"], haystack).1, "hit\n", "-x alone");
			assert_eq!(run_grep(&["-w", "-x", "hit"], haystack).1, "hit\n");
			assert_eq!(
				run_grep(&["-x", "-w", "hit"], haystack).1,
				"hit\n",
				"order must not matter here, unlike in the rg builtin"
			);
		}

		/// The default is every flag off and the engine's own line terminator
		/// left alone. This is the baseline the other cases move away from.
		#[test]
		fn nothing_is_set_by_default() {
			let flags = flags_for(&["hit"]);

			assert!(!flags.case_insensitive);
			assert!(!flags.word);
			assert!(!flags.whole_line);
			assert_eq!(flags.line_terminator, None);
		}

		/// `-i` sets case folding, and `--no-ignore-case` after it cancels it,
		/// which is the last-wins rule `resolve_ignore_case` owns. The flag set
		/// takes the resolved answer rather than re-deriving it.
		#[test]
		fn ignore_case_arrives_already_resolved() {
			assert!(flags_for(&["-i", "hit"]).case_insensitive);
			assert!(!flags_for(&["-i", "--no-ignore-case", "hit"]).case_insensitive);
			assert!(flags_for(&["--no-ignore-case", "-i", "hit"]).case_insensitive);
		}

		/// `-w` alone sets word matching.
		#[test]
		fn word_is_set_by_its_own_flag() {
			let flags = flags_for(&["-w", "hit"]);

			assert!(flags.word);
			assert!(!flags.whole_line);
		}

		/// `-x` alone sets whole-line matching.
		#[test]
		fn whole_line_is_set_by_its_own_flag() {
			let flags = flags_for(&["-x", "hit"]);

			assert!(flags.whole_line);
			assert!(!flags.word);
		}

		/// THE RULE THAT WAS WRITTEN TWICE: `-x` cancels `-w`. Whole-line
		/// matching already fixes both ends of the match, and asking for word
		/// boundaries on top of it rejects a line whose first or last character
		/// is not a word character.
		#[test]
		fn whole_line_cancels_word_in_either_order() {
			for args in [["-w", "-x", "hit"], ["-x", "-w", "hit"]] {
				let flags = flags_for(&args);

				assert!(flags.whole_line, "{args:?}");
				assert!(!flags.word, "-x must cancel -w: {args:?}");
			}
		}

		/// `-z` puts NUL in the flag set, which is how the Rust engine learns
		/// that a line ends at NUL rather than at a newline.
		#[test]
		fn null_data_sets_the_line_terminator() {
			assert_eq!(flags_for(&["-z", "hit"]).line_terminator, Some(b'\0'));
			assert_eq!(flags_for(&["hit"]).line_terminator, None);
		}

		/// `-i` reaches BOTH engines. Without `-i` neither matches, which is the
		/// non-vacuity half: a pass below is the flag arriving, not the pattern
		/// matching anyway.
		#[test]
		fn ignore_case_reaches_both_engines() {
			for engine in [&[][..], &["-P"][..]] {
				let mut folded = engine.to_vec();
				folded.extend_from_slice(&["-i", "HIT"]);
				let (code, stdout, stderr) = run_grep(&folded, "hit\n");
				assert_eq!(code, 0, "{engine:?} {stderr}");
				assert_eq!(stdout, "hit\n", "{engine:?}");

				let mut exact = engine.to_vec();
				exact.push("HIT");
				let (code, stdout, _) = run_grep(&exact, "hit\n");
				assert_eq!(code, 1, "{engine:?} must not fold case without -i");
				assert_eq!(stdout, "", "{engine:?}");
			}
		}

		/// `-w` reaches both engines: `hit` does not match inside `hits`, and
		/// does match the standalone word on the next line.
		#[test]
		fn word_matching_reaches_both_engines() {
			for engine in [&[][..], &["-P"][..]] {
				let mut args = engine.to_vec();
				args.extend_from_slice(&["-w", "hit"]);
				let (code, stdout, stderr) = run_grep(&args, "hits\nhit\n");

				assert_eq!(code, 0, "{engine:?} {stderr}");
				assert_eq!(stdout, "hit\n", "{engine:?} must reject the substring");
			}
		}

		/// `-x` reaches both engines: only the line that IS the pattern matches.
		#[test]
		fn whole_line_matching_reaches_both_engines() {
			for engine in [&[][..], &["-P"][..]] {
				let mut args = engine.to_vec();
				args.extend_from_slice(&["-x", "hit"]);
				let (code, stdout, stderr) = run_grep(&args, "a hit b\nhit\n");

				assert_eq!(code, 0, "{engine:?} {stderr}");
				assert_eq!(stdout, "hit\n", "{engine:?} must reject the embedded match");
			}
		}

		/// The two flags TOGETHER agree across engines, which is the case that
		/// would expose one branch keeping `word` while the other dropped it.
		///
		/// The pattern starts with `-`, so it needs `--` ahead of it or the
		/// parser reads it as an option and exits 2. That is the same thing GNU
		/// grep requires, and it is spelled out here because the first draft of
		/// this test failed on the parse rather than on the match.
		#[test]
		fn word_and_whole_line_together_agree_across_engines() {
			for engine in [&[][..], &["-P"][..]] {
				let mut args = engine.to_vec();
				args.extend_from_slice(&["-w", "-x", "--", "-hit-"]);
				let (code, stdout, stderr) = run_grep(&args, "-hit-\n");

				assert_eq!(code, 0, "{engine:?} {stderr}");
				assert_eq!(stdout, "-hit-\n", "{engine:?}");
			}
		}

		/// `-F` escaping and the flag set compose: the meta characters are
		/// literal AND the case folding still applies, in the branch that
		/// rewrites the patterns before building.
		#[test]
		fn fixed_strings_still_get_the_flags() {
			let (code, stdout, stderr) = run_grep(&["-F", "-i", "A.C"], "abc\nA.C\n");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "A.C\n", "-F must not let the dot match");
		}
	}

	/// `-z` ends a data record with NUL, and a report line with a newline.
	///
	/// WHY THIS SUITE EXISTS. This printer had one terminator for everything, so
	/// `-z` pushed NUL through the `--` group separator, the `-c` count, the
	/// `-l`/`-L` listed path and the binary notice as well as through matching
	/// and context lines. That is ripgrep's rule, not grep's, and the two
	/// genuinely differ. Nothing failed, because no test covered any of the
	/// four.
	///
	/// Every expectation here was captured from GNU grep 3.11 at `/usr/bin/grep`
	/// on this machine, byte for byte:
	///
	/// ```text
	/// grep -z hit      -> hit\0hit\0            grep -z -c hit  -> 2\n
	/// grep -z -n hit   -> 2:hit\0 6:hit\0       grep -z -l hit  -> path\n
	/// grep -z -C1 hit  -> a\0hit\0b\0--\n...    grep -Z -l hit  -> path\0
	/// ```
	///
	/// and the `rg` builtin's own suite pins the OTHER answer for the same three
	/// flags, so a future edit that unifies the two surfaces breaks one of them
	/// loudly instead of quietly picking a side.
	mod null_data_ends_data_records_only {
		use super::*;

		/// NUL-separated input with two matches and a gap, so the group
		/// separator has somewhere to appear.
		const NUL_HAYSTACK: &str = "a\0hit\0b\0c\0d\0hit\0e\0";

		/// The same records newline-separated, for the control cases.
		const LF_HAYSTACK: &str = "a\nhit\nb\nc\nd\nhit\ne\n";

		/// A data record ends with NUL. This is the half `-z` is for and the
		/// half this printer already had right.
		#[test]
		fn a_matching_record_ends_with_nul() {
			let (code, stdout, stderr) = run_grep(&["-z", "hit"], NUL_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "hit\0hit\0");
		}

		/// A prefixed data record is still a data record: the fields keep `:`
		/// between them and the whole line ends with NUL.
		///
		/// Spelled `\x00` because the next character is a digit and `\06` reads
		/// as an octal escape.
		#[test]
		fn a_prefixed_record_ends_with_nul() {
			let (code, stdout, stderr) = run_grep(&["-z", "-n", "hit"], NUL_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2:hit\x006:hit\x00");
		}

		/// A context line is a data record too, and `-b` offsets ride along in
		/// the prefix. Pinned together because both go through one writer.
		#[test]
		fn a_context_line_ends_with_nul() {
			let (code, stdout, stderr) = run_grep(&["-z", "-b", "-A1", "hit"], NUL_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2:hit\x006-b\x00--\n12:hit\x0016-e\x00");
		}

		/// THE FIRST BUG: the `--` group separator is a REPORT line, so it keeps
		/// its newline even in a NUL stream. This printer wrote `--\0`.
		#[test]
		fn the_group_separator_keeps_its_newline() {
			let (code, stdout, stderr) = run_grep(&["-z", "-C1", "hit"], NUL_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a\0hit\0b\0--\nd\0hit\0e\0");
		}

		/// A custom separator takes the same terminator, so the rule lives in
		/// the writer rather than in the default separator's bytes.
		#[test]
		fn a_custom_group_separator_keeps_its_newline() {
			let (code, stdout, stderr) =
				run_grep(&["-z", "--group-separator=XX", "-C1", "hit"], NUL_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a\0hit\0b\0XX\nd\0hit\0e\0");
		}

		/// THE NON-VACUITY TWIN for the separator: suppressing it removes the
		/// whole record rather than leaving a bare terminator behind, so the
		/// newline above is the separator's and not something else's.
		#[test]
		fn a_suppressed_group_separator_writes_no_terminator() {
			let (code, stdout, stderr) =
				run_grep(&["-z", "--no-group-separator", "-C1", "hit"], NUL_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a\0hit\0b\0d\0hit\0e\0");
		}

		/// THE SECOND BUG: a `-c` count is a report line. This printer wrote
		/// `2\0`, which is what `rg --null-data -c` writes and not what
		/// `grep -z -c` writes.
		#[test]
		fn a_count_keeps_its_newline() {
			let (code, stdout, stderr) = run_grep(&["-z", "-c", "hit"], NUL_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2\n");
		}

		/// A prefixed count keeps `:` after the path and a newline at the end.
		#[test]
		fn a_prefixed_count_keeps_its_newline() {
			let (code, stdout, stderr) = run_grep(&["-z", "-H", "-c", "hit"], NUL_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "(standard input):2\n");
		}

		/// THE THIRD BUG: a `-l` listed path is a report line, so `-z` leaves
		/// its newline alone. This printer wrote `path\0`.
		#[test]
		fn a_listed_path_keeps_its_newline() {
			let (code, stdout, stderr) = run_grep(&["-z", "-l", "hit"], NUL_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "(standard input)\n");
		}

		/// `-L` lists through the same writer, so it gets the same answer. It is
		/// pinned separately because it is reached from the other branch of
		/// `finish`.
		#[test]
		fn an_unmatched_listed_path_keeps_its_newline() {
			let (code, stdout, stderr) = run_grep(&["-z", "-L", "absent"], NUL_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "(standard input)\n");
		}

		/// `-o` writes the matched span through its own writer, and a span IS a
		/// data record, so it ends with NUL. This is the case that proves the
		/// fix did not simply replace every terminator with a newline.
		#[test]
		fn an_only_matching_span_ends_with_nul() {
			let (code, stdout, stderr) = run_grep(&["-z", "-o", "hit"], NUL_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "hit\0hit\0");
		}

		/// `-Z` is the flag that DOES change a report line: it replaces the byte
		/// after a path, and for a listed path that byte is the terminator.
		#[test]
		fn the_null_paths_flag_terminates_a_listed_path_with_nul() {
			let (code, stdout, stderr) = run_grep(&["-Z", "-l", "hit"], LF_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "(standard input)\0");
		}

		/// `-Z` on a prefix replaces only the separator after the path. The
		/// record still ends with a newline, which is the boundary between the
		/// two flags.
		#[test]
		fn the_null_paths_flag_replaces_only_the_separator_after_a_path() {
			let (code, stdout, stderr) = run_grep(&["-Z", "-H", "-n", "hit"], LF_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "(standard input)\x002:hit\n(standard input)\x006:hit\n");
		}

		/// And `-Z` with a count: NUL after the path, newline after the number.
		#[test]
		fn the_null_paths_flag_leaves_a_count_terminator_alone() {
			let (code, stdout, stderr) = run_grep(&["-Z", "-H", "-c", "hit"], LF_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "(standard input)\x002\n");
		}

		/// BOTH FLAGS AT ONCE, which is what a NUL pipeline over NUL-separated
		/// input actually passes: NUL after the path AND NUL at the end of each
		/// data record.
		#[test]
		fn the_two_flags_compose_on_a_data_record() {
			let (code, stdout, stderr) = run_grep(&["-z", "-Z", "-H", "-n", "hit"], NUL_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "(standard input)\x002:hit\x00(standard input)\x006:hit\x00");
			assert!(!stdout.contains('\n'), "a NUL data stream must emit no newlines: {stdout:?}");
		}

		/// Composed on a REPORT line the answer is different, and this is the
		/// case that catches a fix which routed both flags through one byte:
		/// `-z -Z -H -c` is NUL after the path and a NEWLINE after the count.
		#[test]
		fn the_two_flags_compose_on_a_report_line() {
			let (code, stdout, stderr) = run_grep(&["-z", "-Z", "-H", "-c", "hit"], NUL_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "(standard input)\x002\n");
		}

		/// THE CONTROL for the whole suite: without `-z` every record ends with
		/// a newline, so each NUL above is the flag working rather than a writer
		/// that stopped writing.
		#[test]
		fn without_the_flag_every_record_ends_with_a_newline() {
			let (matched, stdout, stderr) = run_grep(&["-n", "hit"], LF_HAYSTACK);
			assert_eq!(matched, 0, "{stderr}");
			assert_eq!(stdout, "2:hit\n6:hit\n");

			let (counted, stdout, stderr) = run_grep(&["-c", "hit"], LF_HAYSTACK);
			assert_eq!(counted, 0, "{stderr}");
			assert_eq!(stdout, "2\n");

			let (listed, stdout, stderr) = run_grep(&["-l", "hit"], LF_HAYSTACK);
			assert_eq!(listed, 0, "{stderr}");
			assert_eq!(stdout, "(standard input)\n");

			let (separated, stdout, stderr) = run_grep(&["-C1", "hit"], LF_HAYSTACK);
			assert_eq!(separated, 0, "{stderr}");
			assert_eq!(stdout, "a\nhit\nb\n--\nd\nhit\ne\n");
		}
	}
	/// What `-T/--initial-tab` aligns, and to what.
	///
	/// THE BUG. `-T` was implemented as "put a tab after the last prefix field",
	/// which is half the flag. GNU grep 3.11 also RIGHT-ALIGNS the numeric
	/// fields in a fixed-width column, and that is the whole reason the flag
	/// exists: the line bodies then start at the same column and the output
	/// reads as a table. Ours put the tab in and left the numbers ragged, so
	/// `-T` on a file with more than nine lines produced exactly the
	/// misalignment it was asked to remove.
	///
	/// Every expectation here was read off GNU grep 3.11 on a file built to an
	/// exact byte size, because the width comes from the SIZE and the
	/// boundaries are where a wrong rule shows: a nine-byte file and a ten-byte
	/// file differ.
	mod initial_tab_aligns_the_numeric_fields {
		use super::*;

		/// A file of exactly nine bytes and five lines. `-n` pads to two columns
		/// and `-b` pads to one, from the same file in the same run, which is
		/// the pair that pins the `+1` for line numbers: offsets start at 0 and
		/// line numbers start at 1, so the widest line number needs one more
		/// digit of room than the widest offset.
		#[test]
		fn a_line_number_gets_one_more_column_than_a_byte_offset() {
			let tree = unique_tree("initial-tab-nine");
			std::fs::write(tree.join("nine"), "a\na\na\na\na").expect("nine-byte file written");

			let (code, stdout, stderr) = run_grep_in(&["-T", "-n", "a", "nine"], "", &tree);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, " 1:\ta\n 2:\ta\n 3:\ta\n 4:\ta\n 5:\ta\n");

			let (code, stdout, stderr) = run_grep_in(&["-T", "-b", "a", "nine"], "", &tree);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "0:\ta\n2:\ta\n4:\ta\n6:\ta\n8:\ta\n",
				"one column, so no padding at all"
			);

			let _ = std::fs::remove_dir_all(tree);
		}

		/// One byte more, and the byte-offset field widens too. Same line count,
		/// same records, different padding: the width is read off the SIZE and
		/// not off anything the search discovers.
		#[test]
		fn one_more_byte_widens_the_offset_field() {
			let tree = unique_tree("initial-tab-ten");
			std::fs::write(tree.join("ten"), "a\na\na\na\na\n").expect("ten-byte file written");

			let (code, stdout, stderr) = run_grep_in(&["-T", "-b", "a", "ten"], "", &tree);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, " 0:\ta\n 2:\ta\n 4:\ta\n 6:\ta\n 8:\ta\n");

			let (code, stdout, stderr) = run_grep_in(&["-T", "-n", "a", "ten"], "", &tree);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, " 1:\ta\n 2:\ta\n 3:\ta\n 4:\ta\n 5:\ta\n",
				"the line field is unchanged"
			);

			let _ = std::fs::remove_dir_all(tree);
		}

		/// Asking for BOTH fields gives them the SAME width, the wider of the
		/// two, so the two columns line up with each other as well as with the
		/// bodies. On the nine-byte file that widens the offset field from one
		/// column to two, which is how this test proves there is one width and
		/// not two.
		#[test]
		fn both_fields_share_one_width() {
			let tree = unique_tree("initial-tab-both");
			std::fs::write(tree.join("nine"), "a\na\na\na\na").expect("nine-byte file written");

			let (code, stdout, stderr) = run_grep_in(&["-T", "-n", "-b", "a", "nine"], "", &tree);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, " 1: 0:\ta\n 2: 2:\ta\n 3: 4:\ta\n 4: 6:\ta\n 5: 8:\ta\n");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// A filename is NOT padded, and the tab still comes after the last
		/// numeric field. The path is as wide as it is, and aligning it would
		/// only move the problem.
		#[test]
		fn the_filename_is_not_part_of_the_column() {
			let tree = unique_tree("initial-tab-name");
			std::fs::write(tree.join("nine"), "a\na\na\na\na").expect("nine-byte file written");

			let (code, stdout, stderr) = run_grep_in(&["-T", "-n", "-H", "a", "nine"], "", &tree);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "nine: 1:\ta\nnine: 2:\ta\nnine: 3:\ta\nnine: 4:\ta\nnine: 5:\ta\n");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// CONTEXT lines are padded to the same column, which is the case that
		/// makes the flag worth having: a context record and a matching record
		/// differ only in their separator, and the bodies still start together.
		/// The file is exactly one hundred bytes, so the field is three columns
		/// wide.
		#[test]
		fn a_context_line_is_aligned_with_the_match() {
			let tree = unique_tree("initial-tab-context");
			let mut text = String::from("x\nx\nx\na\nx\nx\nx\n");
			text.push_str(&"z".repeat(100 - text.len()));
			std::fs::write(tree.join("ctx"), &text).expect("hundred-byte file written");

			let (code, stdout, stderr) = run_grep_in(&["-T", "-n", "-C", "1", "a", "ctx"], "", &tree);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "  3-\tx\n  4:\ta\n  5-\tx\n");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// THE NON-VACUITY TWIN: without `-T` nothing is padded, whatever the
		/// file's size. A padding rule that ran unconditionally would pass
		/// every test above.
		#[test]
		fn without_the_flag_nothing_is_padded() {
			let tree = unique_tree("initial-tab-off");
			std::fs::write(tree.join("nine"), "a\na\na\na\na").expect("nine-byte file written");

			let (code, stdout, stderr) = run_grep_in(&["-n", "-b", "a", "nine"], "", &tree);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:0:a\n2:2:a\n3:4:a\n4:6:a\n5:8:a\n");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// An input with no knowable size aligns to NINETEEN columns, the digit
		/// count of the largest `off_t`. A pipe cannot be measured in advance,
		/// and GNU grep pads to the widest number a file could hold rather than
		/// guessing small and misaligning the moment the input gets long.
		/// Measured: `cat file | grep -T -n x` aligns to nineteen and `grep -T
		/// -n x < file` aligns to the file's own width.
		#[test]
		fn an_unmeasurable_input_aligns_to_the_widest_a_file_could_be() {
			let (code, stdout, stderr) = run_grep(&["-T", "-n", "a"], "a\na\n");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "                  1:\ta\n                  2:\ta\n",
				"nineteen columns, since a test's in-process stdin has no size either"
			);
		}

		/// The width rule itself, at every magnitude and both boundaries, because
		/// a file per case would be slow and the interesting inputs are the
		/// sizes just under and just over a power of ten.
		#[test]
		fn the_width_is_the_digit_count_of_the_largest_number_the_input_can_hold() {
			for (size, offset_width, number_width) in [
				(0u64, 1usize, 1usize),
				(1, 1, 1),
				(9, 1, 2),
				(10, 2, 2),
				(11, 2, 2),
				(99, 2, 3),
				(100, 3, 3),
				(999, 3, 4),
				(1000, 4, 4),
				(9999, 4, 5),
				(10000, 5, 5),
				(100_000, 6, 6),
			] {
				assert_eq!(
					aligned_field_width(true, false, Some(size)),
					offset_width,
					"-b width for a {size}-byte input"
				);
				assert_eq!(
					aligned_field_width(true, true, Some(size)),
					number_width,
					"-n width for a {size}-byte input"
				);
			}

			assert_eq!(aligned_field_width(true, false, None), 19, "off_t's maximum has 19 digits");
			assert_eq!(aligned_field_width(true, true, None), 19, "and one more cannot widen it");

			assert_eq!(
				aligned_field_width(false, true, Some(10_000)),
				1,
				"without -T the width pads nothing"
			);
		}
	}
	/// `-G` through the CLI, over one haystack, with GNU grep 3.11's answers.
	///
	/// THE BUG. `-G` selected the same mode as no flag at all, so it was
	/// accepted and then ignored. A user who wrote `grep -G 'a+b'` was asking
	/// for the three characters `a+b` and got a search for one-or-more `a`
	/// followed by `b`: no error, no warning, a different answer. The
	/// translation itself is unit-tested in `crate::bre`; this suite proves the
	/// flag reaches it and that the rest of the run is unaffected.
	mod basic_regular_expressions_are_translated_not_ignored {
		use super::*;

		/// The haystack every case here searches. It holds a line for each syntax
		/// question: a literal `a+b`, the strings a quantifier would match
		/// instead, a leading asterisk, a backslash, and a repeated group.
		const HAY: &str = "a+b\naab\nab\n*abc\na\\b\nabab\nA+B\n";

		/// The operator characters match themselves, and the escaped forms are
		/// the operators. Both halves in one test, since a mode that ignored
		/// `-G` entirely would pass the second.
		#[test]
		fn an_unescaped_operator_is_a_character() {
			let (code, stdout, stderr) = run_grep(&["-G", "a+b"], HAY);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a+b\n", "GNU looks for the three characters");

			let (code, stdout, stderr) = run_grep(&["-G", r"a\+b"], HAY);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "aab\nab\n*abc\nabab\n", "and the escaped form quantifies");
		}

		/// A leading `*` has nothing to repeat, so it is a character. This is the
		/// case that a translator built only from a table of escapes gets wrong.
		#[test]
		fn a_leading_star_is_a_character() {
			let (code, stdout, stderr) = run_grep(&["-G", "*abc"], HAY);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "*abc\n");
		}

		/// A bracket expression has no escapes inside it, so `[\]` is the set
		/// containing a backslash.
		#[test]
		fn a_backslash_in_a_bracket_expression_is_a_character() {
			let (code, stdout, stderr) = run_grep(&["-G", r"a[\]b"], HAY);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a\\b\n");
		}

		/// A back-reference works, which means the run was handed to the engine
		/// that can compile one instead of failing or quietly dropping it. `-o`
		/// proves the span is real and not the whole line by accident.
		#[test]
		fn a_back_reference_selects_the_engine_that_supports_it() {
			let (code, stdout, stderr) = run_grep(&["-G", r"\(ab\)\1"], HAY);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "abab\n");

			let (code, stdout, stderr) = run_grep(&["-G", "-o", r"\(ab\)\1"], HAY);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "abab\n", "the match is the whole four characters");
		}

		/// The other flags still apply to a translated pattern: `-i` folds case,
		/// `-w` and `-x` still bound the match, and `-c` still counts.
		#[test]
		fn the_rest_of_the_flags_still_apply() {
			let (code, stdout, stderr) = run_grep(&["-G", "-i", "a+b"], HAY);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a+b\nA+B\n");

			let (code, stdout, stderr) = run_grep(&["-G", "-x", "a+b"], HAY);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a+b\n");

			let (code, stdout, stderr) = run_grep(&["-G", "-c", "a+b"], HAY);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1\n");
		}

		/// Alternation needs its backslash, and once it has one it works, which
		/// is the pair that shows the translation is not simply escaping
		/// everything.
		#[test]
		fn alternation_needs_its_backslash_and_then_works() {
			let (code, stdout, stderr) = run_grep(&["-G", r"a\|b"], HAY);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a+b\naab\nab\n*abc\na\\b\nabab\n");

			let (code, stdout, stderr) = run_grep(&["-G", "a|b"], HAY);
			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "", "no line holds the three characters a|b");
		}

		/// A malformed BRE is an ERROR with GNU's own wording, and not a literal
		/// search. The default mode falls back to a literal for a pattern it
		/// cannot compile, and that fallback is deliberately absent here: a
		/// mistyped operator is a mistake to report, not a string to look for.
		#[test]
		fn a_malformed_pattern_is_an_error_and_not_a_literal_search() {
			let (code, stdout, stderr) = run_grep(&["-G", r"a\{"], HAY);
			assert_eq!(code, 2);
			assert_eq!(stdout, "");
			assert_eq!(stderr, "grep: Unmatched \\{\n", "byte for byte GNU's message");

			let (code, _stdout, stderr) = run_grep(&["-G", "\\"], HAY);
			assert_eq!(code, 2);
			assert_eq!(stderr, "grep: Trailing backslash\n");

			let (code, _stdout, stderr) = run_grep(&["-G", "[a"], HAY);
			assert_eq!(code, 2);
			assert_eq!(stderr, "grep: Unmatched [, [^, [:, [., or [=\n");
		}

		/// THE DELIBERATE DIFFERENCE, stated as a test so it cannot drift into an
		/// accident. With NO syntax flag this builtin reads a modern regular
		/// expression, where GNU would read a basic one. That is the syntax every
		/// other search surface in this shell accepts, and `-G` is how a caller
		/// asks for the POSIX reading. The two must not be the same mode again.
		#[test]
		fn the_default_mode_is_not_basic() {
			let (code, stdout, stderr) = run_grep(&["a+b"], HAY);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "aab\nab\n*abc\nabab\n",
				"a bare pattern quantifies, where -G would look for a+b"
			);
		}
	}

	/// Two different pattern-syntax flags in one run.
	///
	/// THE BUG. Every other flag pair in this builtin resolves by taking the
	/// last one, and the pattern-syntax flags were resolved the same way, so
	/// `grep -E -G 'a+b'` picked one syntax and searched. GNU grep 3.11 refuses
	/// with `conflicting matchers specified` and exit 2, and it is right to: the
	/// choice decides what the pattern MEANS, so guessing turns a contradictory
	/// command line into a wrong answer rather than an error.
	mod conflicting_pattern_syntax_flags_are_refused {
		use super::*;

		/// Every unordered pair of distinct kinds, both ways round, because a
		/// rule that compared only adjacent flags would pass half of them.
		#[test]
		fn two_different_kinds_are_an_error() {
			for pair in [
				["-E", "-G"],
				["-G", "-E"],
				["-F", "-E"],
				["-E", "-F"],
				["-P", "-G"],
				["-G", "-P"],
				["-F", "-P"],
				["-P", "-F"],
				["-G", "-F"],
				["-F", "-G"],
				["-E", "-P"],
				["-P", "-E"],
			] {
				let (code, stdout, stderr) = run_grep(&[pair[0], pair[1], "a"], "aa\n");
				assert_eq!(code, 2, "{pair:?} should conflict");
				assert_eq!(stdout, "", "{pair:?}");
				assert_eq!(stderr, "grep: conflicting matchers specified\n", "{pair:?}");
			}
		}

		/// Repeating the SAME kind is fine, which is what makes this a rule about
		/// the set of kinds named and not about how many flags were seen. `-E
		/// -F -E` still conflicts, because the set has two kinds in it.
		#[test]
		fn repeating_one_kind_is_not_a_conflict() {
			for flag in ["-E", "-G", "-F", "-P"] {
				let (code, stdout, stderr) = run_grep(&[flag, flag, "a"], "aa\n");
				assert_eq!(code, 0, "{flag} twice: {stderr}");
				assert_eq!(stdout, "aa\n", "{flag} twice");
			}

			let (code, _stdout, stderr) = run_grep(&["-i", "-E", "-E", "a"], "aa\n");
			assert_eq!(code, 0, "another flag between them changes nothing: {stderr}");

			let (code, _stdout, stderr) = run_grep(&["-E", "-F", "-E", "a"], "aa\n");
			assert_eq!(code, 2, "two kinds conflict however many times each appears");
			assert_eq!(stderr, "grep: conflicting matchers specified\n");
		}
	}
	/// What a binary file that matched reports, and where.
	///
	/// THE BUG. The notice went to STDOUT as `Binary file <path> matches`, which
	/// is GNU grep 3.4's wording. GNU moved it to STDERR in 3.5 and reworded
	/// it, and 3.11 is what this builtin follows: `grep: <path>: binary file
	/// matches`. The stream is the part that mattered, because a caller reading
	/// stdout got a sentence where it expected records: `grep hit *.o | wc -l`
	/// counted the notice as a matching line.
	mod a_binary_file_reports_on_stderr {
		use super::*;

		/// A file with a NUL in it. The match is on the line that holds the NUL
		/// and on a later plain line, so a run that printed records would print
		/// two.
		const BINARY: &str = "bin\0hit\nplain hit\n";

		/// The notice, on stderr, with stdout left EMPTY and the status still 0.
		/// All three in one test, because the stream is the defect and the
		/// wording alone would pass on either stream.
		#[test]
		fn the_notice_is_stderr_and_stdout_stays_empty() {
			let (code, stdout, stderr) = run_grep(&["hit"], BINARY);

			assert_eq!(code, 0, "a binary file that matched is still a match");
			assert_eq!(stdout, "", "nothing on stdout for a pipeline to mistake for a record");
			assert_eq!(stderr, "grep: (standard input): binary file matches\n");
		}

		/// `-a` and `--binary-files=text` search it as text: the records print,
		/// NUL and all, and no notice is reported.
		#[test]
		fn reading_it_as_text_prints_the_records_instead() {
			for flag in ["-a", "--binary-files=text"] {
				let (code, stdout, stderr) = run_grep(&[flag, "-n", "hit"], BINARY);

				assert_eq!(code, 0, "{flag}: {stderr}");
				assert_eq!(stdout, "1:bin\0hit\n2:plain hit\n", "{flag}");
				assert_eq!(stderr, "", "{flag}: nothing to report once it is text");
			}
		}

		/// `-I` and `--binary-files=without-match` treat it as holding nothing,
		/// so the status is 1 and both streams are empty.
		#[test]
		fn refusing_to_read_it_reports_no_match_at_all() {
			for flag in ["-I", "--binary-files=without-match"] {
				let (code, stdout, stderr) = run_grep(&[flag, "hit"], BINARY);

				assert_eq!(code, 1, "{flag}: {stderr}");
				assert_eq!(stdout, "", "{flag}");
				assert_eq!(stderr, "", "{flag}: a file with no match has nothing to report");
			}
		}

		/// A summary mode answers its own question and never reports the notice:
		/// `-c` counts the matches it found, and `-l` names the file.
		#[test]
		fn a_summary_mode_answers_instead_of_reporting() {
			let (code, stdout, stderr) = run_grep(&["-c", "hit"], BINARY);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2\n", "both matches counted");
			assert_eq!(stderr, "");

			let (code, stdout, stderr) = run_grep(&["-l", "hit"], BINARY);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "(standard input)\n");
			assert_eq!(stderr, "");
		}

		/// `-q` suppresses the notice along with everything else, and `-s` does
		/// NOT: the notice is not a file error, and `--no-messages` is about
		/// errors.
		#[test]
		fn quiet_hides_the_notice_and_no_messages_does_not() {
			let (code, stdout, stderr) = run_grep(&["-q", "hit"], BINARY);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "");
			assert_eq!(stderr, "", "-q prints nothing at all");

			let (code, stdout, stderr) = run_grep(&["-s", "hit"], BINARY);
			assert_eq!(code, 0);
			assert_eq!(stdout, "");
			assert_eq!(
				stderr, "grep: (standard input): binary file matches\n",
				"-s suppresses file errors, not this"
			);
		}

		/// A binary file with NO match reports nothing and exits 1, which is the
		/// twin that proves the notice is tied to a match and not to the NUL.
		#[test]
		fn a_binary_file_without_a_match_says_nothing() {
			let (code, stdout, stderr) = run_grep(&["absent"], BINARY);

			assert_eq!(code, 1);
			assert_eq!(stdout, "");
			assert_eq!(stderr, "");
		}

		/// `-o` and `-v` reach the same notice and print no records, so the rule
		/// is about the FILE and not about which records a mode would have
		/// printed.
		#[test]
		fn the_notice_outranks_the_record_modes() {
			for flag in ["-o", "-v"] {
				let (code, stdout, stderr) = run_grep(&[flag, "hit"], BINARY);

				assert_eq!(code, 0, "{flag}: {stderr}");
				assert_eq!(stdout, "", "{flag}");
				assert_eq!(stderr, "grep: (standard input): binary file matches\n", "{flag}");
			}
		}

		/// `-z` turns the NUL into the RECORD SEPARATOR, so there is no binary
		/// byte left to detect and the records print. Measured against GNU grep
		/// 3.11 on the same input: the first record is `bin`, the second is
		/// `hit\nplain hit\n`, and the second is the one that matched.
		#[test]
		fn null_data_leaves_nothing_to_detect() {
			let (code, stdout, stderr) = run_grep(&["-z", "hit"], BINARY);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "hit\nplain hit\n\0");
			assert_eq!(stderr, "", "a separator is not binary data");
		}

		/// Only a NUL makes an input binary. A control byte does not, which is
		/// the twin that shows the rule is the byte and not "anything
		/// unprintable": measured against GNU grep 3.11, a file holding
		/// `a\x01b` prints its matching line with no notice.
		#[test]
		fn a_control_byte_is_not_binary_data() {
			let (code, stdout, stderr) = run_grep(&["hit"], "a\u{1}b\nhit\n");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "hit\n");
			assert_eq!(stderr, "");
		}
	}

	/// A context request of ZERO lines, which still groups the output.
	///
	/// `-A0`, `-B0` and `-C0` ask for no context lines and are not the same as
	/// asking for no context: GNU grep 3.11 still separates non-adjacent groups
	/// with `--`, so a caller can tell `1,3,5` from `1,2,3`. Every expectation
	/// here was measured on the same six-line input.
	mod a_zero_context_request_still_groups_the_output {
		use super::*;

		/// Three matches on lines 1, 3 and 5 of six, so every group is separated
		/// from the next by exactly one line.
		const HAY: &str = "one hit\ntwo\nthree hit\nfour\nfive hit\nsix\n";

		/// All three spellings of "no context lines" print the separator.
		#[test]
		fn zero_lines_of_context_is_not_the_absence_of_context() {
			for flag in ["-A0", "-B0", "-C0"] {
				let (code, stdout, stderr) = run_grep(&[flag, "-n", "hit"], HAY);

				assert_eq!(code, 0, "{flag}: {stderr}");
				assert_eq!(stdout, "1:one hit\n--\n3:three hit\n--\n5:five hit\n", "{flag}");
			}
		}

		/// THE TWIN: with no context flag at all there are no groups and no
		/// separators, which is what makes the test above about the request and
		/// not about the gaps between matches.
		#[test]
		fn no_context_request_prints_no_separator() {
			let (code, stdout, stderr) = run_grep(&["-n", "hit"], HAY);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:one hit\n3:three hit\n5:five hit\n");
		}

		/// The separator is still the one the caller chose, and can still be
		/// turned off, so the zero-context path goes through the same owner as
		/// any other.
		#[test]
		fn the_chosen_separator_is_used_and_can_be_removed() {
			let (code, stdout, stderr) = run_grep(&["-A0", "-n", "--group-separator=@@", "hit"], HAY);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:one hit\n@@\n3:three hit\n@@\n5:five hit\n");

			let (code, stdout, stderr) = run_grep(&["-A0", "-n", "--no-group-separator", "hit"], HAY);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:one hit\n3:three hit\n5:five hit\n");
		}

		/// Adjacent groups need no separator: with `-A1` the group around line 1
		/// ends where the group around line 3 begins.
		#[test]
		fn adjacent_groups_are_not_separated() {
			let (code, stdout, stderr) = run_grep(&["-A1", "-n", "hit"], HAY);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "1:one hit\n2-two\n3:three hit\n4-four\n5:five hit\n6-six\n",
				"one run of six lines, so nothing to separate"
			);
		}

		/// `-o` prints no context LINES and still prints the group SEPARATOR,
		/// which is the combination that used to lose it. Measured against GNU
		/// grep 3.11: `grep -B0 -o hit` prints three matches with `--` between
		/// them, and `grep -A1 -o hit` prints three with none, because those
		/// groups touch.
		#[test]
		fn only_matching_keeps_the_separator_and_drops_the_context_lines() {
			let (code, stdout, stderr) = run_grep(&["-B0", "-o", "hit"], HAY);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "hit\n--\nhit\n--\nhit\n");

			let (code, stdout, stderr) = run_grep(&["-A1", "-o", "hit"], HAY);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "hit\nhit\nhit\n", "adjacent groups, and no context text");
		}

		/// A summary mode ignores the request entirely, so `-c` counts the three
		/// matching lines and prints no separator.
		#[test]
		fn a_summary_mode_ignores_the_request() {
			let (code, stdout, stderr) = run_grep(&["-C0", "-c", "hit"], HAY);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "3\n");
		}

		/// Consecutive matches are ONE group, and the separator appears only at
		/// the real gap. This is the case a rule that printed a separator
		/// before every record after the first would get wrong.
		#[test]
		fn consecutive_matches_are_one_group() {
			let (code, stdout, stderr) = run_grep(&["-A0", "-n", "hit"], "a hit\nb hit\nc\nd hit\n");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:a hit\n2:b hit\n--\n4:d hit\n");
		}

		/// Two matches on ONE line are two records and still one group, so the
		/// separator does not appear between them. It appears before the distant
		/// third, which is what proves the grouping is per line and not per
		/// record.
		#[test]
		fn two_matches_on_one_line_are_not_separated_from_each_other() {
			let (code, stdout, stderr) = run_grep(&["-o", "-B0", "hit"], "hit hit\nno\nhit\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "hit\nhit\n--\nhit\n");

			let (code, stdout, stderr) = run_grep(&["-o", "-A0", "-n", "hit"], "hit hit\nno\nhit\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:hit\n1:hit\n--\n3:hit\n", "both records name line 1");
		}

		/// `-m1` stops after the first match, so there is no second group and
		/// nothing to separate. The separator must not be printed on the way
		/// out.
		#[test]
		fn a_max_count_of_one_leaves_nothing_to_separate() {
			let (code, stdout, stderr) = run_grep(&["-m1", "-A0", "-n", "hit"], HAY);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:one hit\n");
		}
	}

	/// `-v` with the modes that print something other than a whole line.
	///
	/// An inverted search selects the lines the pattern did NOT match, so there
	/// is no match to point at. Each mode has to answer for that, and GNU grep
	/// 3.11's answers are not the same: `-o` prints nothing at all, while `-c`
	/// still counts the lines it selected.
	mod inverted_search_has_no_match_to_point_at {
		use super::*;

		const HAY: &str = "one hit\ntwo\nthree hit\nfour\nfive hit\nsix\n";

		/// `-v -o` prints NOTHING and still exits 0, because lines were selected
		/// even though none of them holds a match to show.
		#[test]
		fn only_matching_prints_nothing_and_still_succeeds() {
			let (code, stdout, stderr) = run_grep(&["-v", "-o", "hit"], HAY);

			assert_eq!(code, 0, "three lines were selected: {stderr}");
			assert_eq!(stdout, "", "and none of them has a match to print");
		}

		/// `-v -c` counts the selected LINES, and `-o` does not change that.
		#[test]
		fn a_count_still_counts_the_selected_lines() {
			let (code, stdout, stderr) = run_grep(&["-v", "-c", "hit"], HAY);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "3\n");

			let (code, stdout, stderr) = run_grep(&["-v", "-c", "-o", "hit"], HAY);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "3\n", "-o has nothing to count differently");
		}

		/// Context still works around an inverted match, and the two separators
		/// keep their meanings: `:` for a line the run selected, `-` for one it
		/// pulled in as context. Here the context lines are the ones that DID
		/// match.
		#[test]
		fn context_around_an_inverted_match_keeps_both_separators() {
			let (code, stdout, stderr) = run_grep(&["-A1", "-v", "-n", "hit"], HAY);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2:two\n3-three hit\n4:four\n5-five hit\n6:six\n");
		}
	}

	/// What a DIRECTORY operand does, which is decided by `-d` and by `-r`.
	///
	/// GNU grep 3.11's default is `-d read`: it tries to read the directory,
	/// fails, and says so. `-d skip` passes over it in silence, and `-d
	/// recurse` is `-r`. The three were unpinned, and a directory operand is
	/// what a careless glob produces, so the difference between "said nothing
	/// and exited 1" and "reported and exited 2" is the difference between a
	/// script that notices and one that does not.
	mod a_directory_operand_follows_the_directories_flag {
		use super::*;

		/// A tree with a file at the top and one a level down, so recursion has
		/// something to prove.
		fn tree(label: &str) -> TempTree {
			let tree = unique_tree(label);
			std::fs::create_dir_all(tree.join("sub")).expect("subdirectory created");
			std::fs::write(tree.join("top"), "top hit\n").expect("top file written");
			std::fs::write(tree.join("sub/deep"), "deep hit\n").expect("deep file written");
			tree
		}

		/// The lines of `stdout`, sorted, because a walk has no promised order.
		fn sorted(stdout: &str) -> Vec<String> {
			let mut lines: Vec<String> = stdout.lines().map(str::to_string).collect();
			lines.sort();
			lines
		}

		/// The default reports the directory and exits 2, and `-d read` says the
		/// same thing, since it IS the default.
		#[test]
		fn reading_a_directory_is_an_error_that_says_so() {
			let tree = tree("dir-read");

			for args in [vec!["hit", "sub"], vec!["-d", "read", "hit", "sub"]] {
				let (code, stdout, stderr) = run_grep_in(&args, "", &tree);

				assert_eq!(code, 2, "{args:?}");
				assert_eq!(stdout, "", "{args:?}");
				assert_eq!(stderr, "grep: sub: Is a directory\n", "{args:?}");
			}

			let _ = std::fs::remove_dir_all(tree);
		}

		/// `-d skip` passes over it in silence: nothing on either stream, and the
		/// status is 1 because nothing was found rather than 2 because something
		/// went wrong.
		#[test]
		fn skipping_a_directory_is_silent_and_finds_nothing() {
			let tree = tree("dir-skip");

			let (code, stdout, stderr) = run_grep_in(&["-d", "skip", "hit", "sub"], "", &tree);

			assert_eq!(code, 1);
			assert_eq!(stdout, "");
			assert_eq!(stderr, "");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// `-d recurse` is `-r`: both walk the tree and both name every file they
		/// print, since more than one file is in play.
		#[test]
		fn recursing_reaches_every_file_under_the_operand() {
			let tree = tree("dir-recurse");

			for flag in [vec!["-d", "recurse"], vec!["-r"]] {
				let mut args = flag.clone();
				args.extend(["hit", "."]);
				let (code, stdout, stderr) = run_grep_in(&args, "", &tree);

				assert_eq!(code, 0, "{flag:?}: {stderr}");
				assert_eq!(
					sorted(&stdout),
					vec!["./sub/deep:deep hit".to_string(), "./top:top hit".to_string()],
					"{flag:?}: the operand is echoed as the caller wrote it"
				);
			}

			let _ = std::fs::remove_dir_all(tree);
		}

		/// The operand is echoed as the caller wrote it, so `dir` and `dir/` and
		/// `.` each produce the prefix they were given. Measured against GNU
		/// grep 3.11: `grep -r hit dir/` prints `dir/sub/deep:deep hit`, with
		/// one slash.
		#[test]
		fn the_operand_is_echoed_as_it_was_written() {
			let tree = tree("dir-prefix");

			let (code, stdout, stderr) = run_grep_in(&["-r", "hit", "sub"], "", &tree);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "sub/deep:deep hit\n");

			let (code, stdout, stderr) = run_grep_in(&["-r", "hit", "sub/"], "", &tree);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "sub/deep:deep hit\n", "one slash, not two");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// `-h` drops the names a recursive search would otherwise print, which
		/// is the twin that shows the prefix is a choice and not part of the
		/// record.
		#[test]
		fn no_filename_drops_the_prefix_a_walk_added() {
			let tree = tree("dir-h");

			let (code, stdout, stderr) = run_grep_in(&["-h", "-r", "hit", "."], "", &tree);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(sorted(&stdout), vec!["deep hit".to_string(), "top hit".to_string()]);

			let _ = std::fs::remove_dir_all(tree);
		}

		/// `-s` suppresses the message and NOT the status, so a script that
		/// checks the exit code still learns that something went wrong.
		#[test]
		fn no_messages_hides_the_report_and_keeps_the_status() {
			let tree = tree("dir-s");

			let (code, stdout, stderr) = run_grep_in(&["-s", "hit", "sub"], "", &tree);

			assert_eq!(code, 2, "still an error");
			assert_eq!(stdout, "");
			assert_eq!(stderr, "", "-s is about the message");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// A missing file is the same shape of report: the path, the reason, exit
		/// 2, and `-s` hides the sentence and nothing else.
		#[test]
		fn a_missing_file_reports_the_same_way() {
			let tree = tree("dir-missing");

			let (code, stdout, stderr) = run_grep_in(&["hit", "absent"], "", &tree);
			assert_eq!(code, 2);
			assert_eq!(stdout, "");
			assert!(
				stderr.starts_with("grep: absent: "),
				"the path comes first, then the reason: {stderr}"
			);

			let (code, _stdout, stderr) = run_grep_in(&["-s", "hit", "absent"], "", &tree);
			assert_eq!(code, 2);
			assert_eq!(stderr, "");

			let _ = std::fs::remove_dir_all(tree);
		}
	}
	/// `-U/--binary`, which decides nothing about binary files.
	///
	/// THE BUG. `-U` was wired to `BinaryFiles::Binary`, so it took part in the
	/// last-flag-wins race with the flags that DO decide how a binary file is
	/// read. `grep -a -U pattern file` reported `binary file matches` where GNU
	/// grep 3.11 prints the records, and `grep -I -U` lost its `-I`. What `-U`
	/// actually asks for is binary I/O on a platform that rewrites line endings
	/// on the way in, which this builtin never does, so the flag is accepted
	/// and has no effect.
	mod the_binary_io_flag_decides_nothing_about_binary_files {
		use super::*;

		const BINARY: &str = "bin\0hit\nplain hit\n";

		/// `-a` survives `-U` in BOTH orders, which is the pair that pins it out
		/// of the race rather than merely reordering it.
		#[test]
		fn it_does_not_undo_reading_a_file_as_text() {
			for args in [vec!["-a", "-U", "hit"], vec!["-U", "-a", "hit"]] {
				let (code, stdout, stderr) = run_grep(&args, BINARY);

				assert_eq!(code, 0, "{args:?}: {stderr}");
				assert_eq!(stdout, "bin\0hit\nplain hit\n", "{args:?}");
				assert_eq!(stderr, "", "{args:?}");
			}
		}

		/// `--binary-files=text` survives it too, so the rule is about the flag
		/// and not about the one spelling of it.
		#[test]
		fn it_does_not_undo_the_long_spelling_either() {
			let (code, stdout, stderr) = run_grep(&["--binary-files=text", "-U", "hit"], BINARY);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "bin\0hit\nplain hit\n");
		}

		/// `-I` survives it as well: the file still counts as holding nothing, so
		/// the status is 1 and both streams are empty.
		#[test]
		fn it_does_not_undo_refusing_to_read_a_binary_file() {
			let (code, stdout, stderr) = run_grep(&["-I", "-U", "hit"], BINARY);

			assert_eq!(code, 1);
			assert_eq!(stdout, "");
			assert_eq!(stderr, "");
		}

		/// THE TWIN: on its own it changes nothing, so the default still applies
		/// and the notice still appears. Without this case a flag that was
		/// simply dropped would look the same as one wired correctly.
		#[test]
		fn on_its_own_it_leaves_the_default_alone() {
			let (code, stdout, stderr) = run_grep(&["-U", "hit"], BINARY);

			assert_eq!(code, 0);
			assert_eq!(stdout, "");
			assert_eq!(stderr, "grep: (standard input): binary file matches\n");
		}

		/// And it changes nothing at all for a text file, records included.
		#[test]
		fn a_text_file_reads_exactly_the_same() {
			let (code, stdout, stderr) = run_grep(&["-U", "-n", "hit"], "one hit\ntwo\n");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:one hit\n");
		}
	}

	/// Which files a run is allowed to search, and where the rules apply.
	///
	/// `--include`, `--exclude`, `--exclude-from` and `--exclude-dir` had one
	/// test between them, and the interesting question had none: the rules
	/// apply to a file NAMED ON THE COMMAND LINE, not only to files a recursive
	/// walk found. Measured against GNU grep 3.11, `grep --exclude='h*' hit
	/// hay` prints nothing and exits 1 even though `hay` was asked for by name.
	mod the_path_rules_apply_to_named_files_too {
		use super::*;

		fn tree(label: &str) -> TempTree {
			let tree = unique_tree(label);
			std::fs::create_dir_all(tree.join("sub")).expect("subdirectory created");
			std::fs::write(tree.join("hay"), "one hit\n").expect("hay written");
			std::fs::write(tree.join("top"), "top hit\n").expect("top written");
			std::fs::write(tree.join("sub/deep"), "deep hit\n").expect("deep written");
			tree
		}

		fn sorted(stdout: &str) -> Vec<String> {
			let mut lines: Vec<String> = stdout.lines().map(str::to_string).collect();
			lines.sort();
			lines
		}

		/// An `--include` the named file does not match leaves nothing to search,
		/// and the status is 1: nothing was found, and nothing went wrong.
		#[test]
		fn an_include_that_misses_the_named_file_finds_nothing() {
			let tree = tree("rules-include");

			let (code, stdout, stderr) = run_grep_in(&["--include=nomatch*", "hit", "hay"], "", &tree);
			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "");
			assert_eq!(stderr, "", "a filtered file is not an error");

			let (code, stdout, stderr) = run_grep_in(&["--include=h*", "hit", "hay"], "", &tree);
			assert_eq!(code, 0, "THE TWIN: {stderr}");
			assert_eq!(stdout, "one hit\n");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// An `--exclude` that matches the named file removes it, however
		/// explicitly it was asked for.
		#[test]
		fn an_exclude_removes_a_file_named_on_the_command_line() {
			let tree = tree("rules-exclude");

			let (code, stdout, stderr) = run_grep_in(&["--exclude=h*", "hit", "hay"], "", &tree);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "");
			assert_eq!(stderr, "");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// `--exclude-from` reads the same patterns from a file, one per line,
		/// and applies them to a walk.
		#[test]
		fn exclude_from_reads_the_patterns_from_a_file() {
			let tree = tree("rules-exclude-from");
			std::fs::write(tree.join("skip"), "top\nhay\n").expect("pattern file written");

			let (code, stdout, stderr) =
				run_grep_in(&["-r", "--exclude-from=skip", "hit", "."], "", &tree);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				sorted(&stdout),
				vec!["./sub/deep:deep hit".to_string()],
				"top and hay are excluded by name, and the pattern file itself holds no match"
			);

			let _ = std::fs::remove_dir_all(tree);
		}

		/// `--exclude-dir` prunes the directory rather than filtering its files,
		/// so nothing under it is searched.
		#[test]
		fn exclude_dir_prunes_the_directory() {
			let tree = tree("rules-exclude-dir");

			let (code, stdout, stderr) =
				run_grep_in(&["-r", "--exclude-dir=sub", "hit", "."], "", &tree);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(sorted(&stdout), vec![
				"./hay:one hit".to_string(),
				"./top:top hit".to_string()
			]);

			let _ = std::fs::remove_dir_all(tree);
		}

		/// `--include` also filters a walk, which is the case that already worked
		/// and is kept here so the two paths are proved by the same suite.
		#[test]
		fn include_filters_a_walk_as_well() {
			let tree = tree("rules-include-walk");

			let (code, stdout, stderr) = run_grep_in(&["-r", "--include=t*", "hit", "."], "", &tree);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(sorted(&stdout), vec!["./top:top hit".to_string()]);

			let _ = std::fs::remove_dir_all(tree);
		}
	}
	/// Text the locale's codeset cannot represent is binary data to GNU grep,
	/// and the rule is finer than the NUL rule: only the offending LINE is
	/// withheld, the rest of the file still prints, and the file is named once
	/// at the end.
	///
	/// This whole module exists because the builtin used to detect binary data
	/// by NUL alone, so `grep hit bad.bin` in a UTF-8 locale wrote raw
	/// `\xff\xfe` bytes onto the terminal where GNU grep 3.11 withholds the
	/// line and reports the file. Every expectation below is a measurement of
	/// GNU grep 3.11 against the same input.
	mod badly_encoded_text_is_binary_data {
		use super::*;

		/// `hit \xff\xfe bad\nplain hit\n`: one matching line the codeset cannot
		/// represent, one it can.
		const MIXED: &[u8] = b"hit \xff\xfe bad\nplain hit\n";

		/// The locale every current desktop runs, spelled the way `locale` prints
		/// it.
		const UTF8: &[(&str, &str)] = &[("LC_ALL", "en_US.UTF-8")];

		/// Write `MIXED` into a fresh tree and hand back the tree.
		fn mixed_tree(label: &str) -> TempTree {
			let tree = unique_tree(label);
			std::fs::write(tree.join("bad.bin"), MIXED).expect("input should be written");
			tree
		}

		/// The headline case. The bad line matched, so it counts toward the exit
		/// code and toward the notice, and it is not printed; the good line
		/// that follows it still is. Printing it is what the old NUL-only
		/// detection did.
		#[test]
		fn a_badly_encoded_line_is_withheld_and_the_file_is_reported() {
			let tree = mixed_tree("bad-utf8");

			let (code, stdout, stderr) = run_grep_env(&["hit", "bad.bin"], b"", &tree, UTF8);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, b"plain hit\n");
			assert_eq!(stderr, "grep: bad.bin: binary file matches\n");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// Valid multi-byte text is TEXT, which is the half of the rule that is
		/// easy to get wrong: a UTF-8 locale must not call `café hit` binary
		/// just because the line holds bytes above 0x7f. A checker that looked
		/// for high bytes instead of decoding would withhold most of the
		/// world's source files.
		#[test]
		fn valid_multibyte_text_is_not_binary() {
			let tree = unique_tree("good-utf8");
			let good = "café hit\nplain hit\n".as_bytes();
			std::fs::write(tree.join("good.txt"), good).expect("input should be written");

			let (code, stdout, stderr) = run_grep_env(&["hit", "good.txt"], b"", &tree, UTF8);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, good);
			assert_eq!(stderr, "");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// A sequence that is merely CUT SHORT is as badly encoded as an
		/// impossible one: a line ending in a lone `\xc3` is withheld and
		/// reported. This is the case a "does every byte look like it could
		/// start a sequence" check passes and a decoder catches.
		#[test]
		fn a_truncated_sequence_is_badly_encoded() {
			let tree = unique_tree("trunc-utf8");
			std::fs::write(tree.join("trunc.bin"), b"hit \xc3\n").expect("input should be written");

			let (code, stdout, stderr) = run_grep_env(&["hit", "trunc.bin"], b"", &tree, UTF8);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, b"");
			assert_eq!(stderr, "grep: trunc.bin: binary file matches\n");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// The same bytes in a single-byte locale are just bytes: nothing is
		/// binary, nothing is withheld, and there is no notice. The rule is a
		/// property of the codeset, not of the file.
		#[test]
		fn the_c_locale_prints_the_bytes_and_reports_nothing() {
			let tree = mixed_tree("bad-c");

			let (code, stdout, stderr) =
				run_grep_env(&["hit", "bad.bin"], b"", &tree, &[("LC_ALL", "C")]);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, MIXED);
			assert_eq!(stderr, "");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// A codeset that is not multibyte is treated like `C`, and so is an
		/// environment with no locale variables at all, which is what a bare
		/// non-interactive process has.
		#[test]
		fn a_single_byte_codeset_and_an_empty_environment_both_mean_bytes() {
			let tree = mixed_tree("bad-latin1");

			for env in [&[("LC_ALL", "en_US.ISO-8859-1")][..], &[][..], &[("LC_ALL", "POSIX")][..]] {
				let (code, stdout, stderr) = run_grep_env(&["hit", "bad.bin"], b"", &tree, env);

				assert_eq!(code, 0, "{env:?}: {stderr}");
				assert_eq!(stdout, MIXED, "{env:?}");
				assert_eq!(stderr, "", "{env:?}");
			}

			let _ = std::fs::remove_dir_all(tree);
		}

		/// `-a` asks for the bytes whatever they are, so the rule is skipped
		/// entirely: both lines print raw and there is no notice.
		/// `--binary-files=text` is the long spelling of the same request.
		#[test]
		fn asking_for_the_bytes_skips_the_rule() {
			let tree = mixed_tree("bad-text");

			for flag in ["-a", "--binary-files=text"] {
				let (code, stdout, stderr) = run_grep_env(&[flag, "hit", "bad.bin"], b"", &tree, UTF8);

				assert_eq!(code, 0, "{flag}: {stderr}");
				assert_eq!(stdout, MIXED, "{flag}");
				assert_eq!(stderr, "", "{flag}");
			}

			let _ = std::fs::remove_dir_all(tree);
		}

		/// `--binary-files=without-match` says to assume binary files do not
		/// match. A badly encoded LINE does not make the file one of those: the
		/// good line still prints, and because `-I` has no notice to give,
		/// stderr stays empty. This is where the NUL rule and this rule part
		/// ways, and asserting it keeps the notice from leaking into `-I`.
		#[test]
		fn without_match_withholds_the_line_and_stays_quiet() {
			let tree = mixed_tree("bad-without-match");

			let (code, stdout, stderr) =
				run_grep_env(&["--binary-files=without-match", "hit", "bad.bin"], b"", &tree, UTF8);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, b"plain hit\n");
			assert_eq!(stderr, "");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// The modes that print no records print no notice either, and they still
		/// COUNT the bad line: `-c` says 2, not 1. The line is withheld from
		/// output, never from the tally.
		#[test]
		fn the_summary_modes_count_the_line_without_the_notice() {
			let tree = mixed_tree("bad-summary");

			for (args, want) in [
				(&["-c", "hit", "bad.bin"][..], &b"2\n"[..]),
				(&["-l", "hit", "bad.bin"][..], &b"bad.bin\n"[..]),
				(&["-o", "hit", "bad.bin"][..], &b"hit\nhit\n"[..]),
			] {
				let (code, stdout, stderr) = run_grep_env(args, b"", &tree, UTF8);

				assert_eq!(code, 0, "{args:?}: {stderr}");
				assert_eq!(stdout, want, "{args:?}");
				assert_eq!(stderr, "", "{args:?}");
			}

			let _ = std::fs::remove_dir_all(tree);
		}

		/// `-q` is silent on both streams and still reports the match through its
		/// exit code, exactly as it is for a NUL file.
		#[test]
		fn quiet_mode_says_nothing_at_all() {
			let tree = mixed_tree("bad-quiet");

			let (code, stdout, stderr) = run_grep_env(&["-q", "hit", "bad.bin"], b"", &tree, UTF8);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, b"");
			assert_eq!(stderr, "");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// `-o` prints only the match text, and `hit` is representable, so BOTH
		/// matches print and nothing is reported. Judging `-o` on the LINE
		/// instead of on the bytes it prints would swallow a match the terminal
		/// can render perfectly.
		#[test]
		fn only_matching_prints_every_match_the_codeset_can_represent() {
			let tree = mixed_tree("bad-only-matching");

			let (code, stdout, stderr) = run_grep_env(&["-o", "hit", "bad.bin"], b"", &tree, UTF8);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, b"hit\nhit\n");
			assert_eq!(stderr, "");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// `-m1` stops after the first matching line, and here that line is the
		/// bad one: nothing is printed, the file is still reported, and the
		/// exit code still says there was a match. An empty stdout with a zero
		/// exit code is the shape callers have to be able to read.
		#[test]
		fn a_match_limit_can_land_on_the_withheld_line() {
			let tree = mixed_tree("bad-max-count");

			let (code, stdout, stderr) = run_grep_env(&["-m1", "hit", "bad.bin"], b"", &tree, UTF8);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, b"");
			assert_eq!(stderr, "grep: bad.bin: binary file matches\n");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// A file whose ONLY matching line is badly encoded prints nothing on
		/// stdout, reports the file, and exits 0. `-c` on the same file still
		/// says 1.
		#[test]
		fn a_file_whose_only_match_is_withheld_still_reports_the_match() {
			let tree = unique_tree("bad-only-line");
			std::fs::write(tree.join("only.bin"), b"hit \xff\xfe bad\n")
				.expect("input should be written");

			let (code, stdout, stderr) = run_grep_env(&["hit", "only.bin"], b"", &tree, UTF8);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, b"");
			assert_eq!(stderr, "grep: only.bin: binary file matches\n");

			let (code, stdout, stderr) = run_grep_env(&["-c", "hit", "only.bin"], b"", &tree, UTF8);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, b"1\n");
			assert_eq!(stderr, "");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// `-v` selects the lines that do NOT match, and a selected line gets the
		/// same treatment: the bad one is withheld, the good one prints, the
		/// file is reported. The rule belongs to printing, not to matching.
		#[test]
		fn an_inverted_match_applies_the_same_rule() {
			let tree = mixed_tree("bad-invert");

			let (code, stdout, stderr) = run_grep_env(&["-v", "absent", "bad.bin"], b"", &tree, UTF8);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, b"plain hit\n");
			assert_eq!(stderr, "grep: bad.bin: binary file matches\n");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// A CONTEXT line is withheld the same way a matching line is, and it
		/// marks the file: `-A1` on a match followed by a bad line prints the
		/// match alone and reports the file. Checking only matching lines would
		/// have printed the bad context bytes.
		#[test]
		fn a_context_line_the_codeset_cannot_represent_is_withheld_too() {
			let tree = unique_tree("bad-context");
			std::fs::write(tree.join("ctx.bin"), b"hit one\nbad \xff\xfe line\nhit two\n")
				.expect("input should be written");

			let (code, stdout, stderr) =
				run_grep_env(&["-n", "-A1", "hit one", "ctx.bin"], b"", &tree, UTF8);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, b"1:hit one\n");
			assert_eq!(stderr, "grep: ctx.bin: binary file matches\n");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// Standard input is reported by the placeholder name, the same one the
		/// NUL notice uses, so a pipeline gets a name it can read instead of a
		/// bare colon.
		#[test]
		fn standard_input_is_reported_by_its_placeholder_name() {
			let tree = unique_tree("bad-stdin");

			let (code, stdout, stderr) = run_grep_env(&["hit"], MIXED, &tree, UTF8);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, b"plain hit\n");
			assert_eq!(stderr, "grep: (standard input): binary file matches\n");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// The three locale variables are read in the order the C standard gives
		/// them. `LC_CTYPE` alone decides the codeset, `LANG` alone decides it,
		/// an empty `LC_ALL` falls through to `LC_CTYPE`, and a set `LC_ALL=C`
		/// outranks a UTF-8 `LANG`. Reading them in any other order would make
		/// the same file binary on one machine and text on the next.
		#[test]
		fn the_locale_variables_are_read_in_their_standard_order() {
			let tree = mixed_tree("bad-locale-order");

			for (env, withheld) in [
				(&[("LC_CTYPE", "en_US.UTF-8")][..], true),
				(&[("LANG", "en_US.utf8")][..], true),
				(&[("LC_ALL", ""), ("LC_CTYPE", "en_US.UTF-8")][..], true),
				(&[("LC_ALL", "C"), ("LANG", "en_US.UTF-8")][..], false),
				(&[("LC_ALL", "en_US.UTF-8"), ("LC_CTYPE", "C")][..], true),
			] {
				let (code, stdout, stderr) = run_grep_env(&["hit", "bad.bin"], b"", &tree, env);

				assert_eq!(code, 0, "{env:?}: {stderr}");
				if withheld {
					assert_eq!(stdout, b"plain hit\n", "{env:?}");
					assert_eq!(stderr, "grep: bad.bin: binary file matches\n", "{env:?}");
				} else {
					assert_eq!(stdout, MIXED, "{env:?}");
					assert_eq!(stderr, "", "{env:?}");
				}
			}

			let _ = std::fs::remove_dir_all(tree);
		}

		/// A modifier after the codeset, as in `en_US.UTF-8@euro`, does not
		/// change the codeset, and a locale with no dot at all has no codeset
		/// to read, so it is the single-byte case.
		#[test]
		fn a_modifier_is_not_part_of_the_codeset() {
			let tree = mixed_tree("bad-locale-modifier");

			for (locale, withheld) in [("en_US.UTF-8@euro", true), ("en_US", false), ("C", false)] {
				let (code, stdout, stderr) =
					run_grep_env(&["hit", "bad.bin"], b"", &tree, &[("LC_ALL", locale)]);

				assert_eq!(code, 0, "{locale}: {stderr}");
				assert_eq!(withheld, stdout == b"plain hit\n", "{locale}");
			}

			let _ = std::fs::remove_dir_all(tree);
		}

		/// A file that holds both a NUL and a badly encoded line is reported
		/// ONCE, and by the NUL rule, which is the stronger one: it replaces
		/// every record.
		#[test]
		fn a_nul_and_a_bad_line_are_reported_once() {
			let tree = unique_tree("bad-and-nul");
			std::fs::write(tree.join("both.bin"), b"hit \xff\xfe bad\nhit \0 nul\nplain hit\n")
				.expect("input should be written");

			let (code, stdout, stderr) = run_grep_env(&["hit", "both.bin"], b"", &tree, UTF8);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, b"");
			assert_eq!(stderr, "grep: both.bin: binary file matches\n", "one notice, not two");

			let _ = std::fs::remove_dir_all(tree);
		}
	}

	/// The group separator between one FILE's records and the next's.
	///
	/// THE BUG. This printer separated groups inside a file and never between
	/// two files, so `grep -A1 hit a.txt b.txt` ran one file's context block
	/// straight into the next's. GNU grep 3.11 prints `--` there, the same mark
	/// it prints between two gaps in one file, and under `-h` it is the only
	/// boundary in the output at all. Found by the GNU grep differential suite,
	/// five of its eight first-run disagreements. See `GrepSink::begin_search`.
	mod the_group_separator_stands_between_two_files {
		use super::*;

		/// Three files, and the middle one matches nothing: a file that printed
		/// nothing must not be separated from anything.
		fn tree(label: &str) -> TempTree {
			let root = unique_tree(label);
			std::fs::write(root.join("f1.txt"), "x\nhit\ny\n").expect("the first fixture");
			std::fs::write(root.join("f2.txt"), "nope\n").expect("the quiet fixture");
			std::fs::write(root.join("f3.txt"), "hit\nz\n").expect("the last fixture");
			root
		}

		/// Every context flag prints it, and it goes BETWEEN: never above the
		/// first file, never after the last, and never around the file that
		/// printed nothing.
		#[test]
		fn each_context_flag_prints_it_between_the_two_files_that_printed() {
			let root = tree("grep-separator-context-flags");
			let files = ["f1.txt", "f2.txt", "f3.txt"];

			let (code, stdout, stderr) =
				run_grep_in(&["-A1", "hit", files[0], files[1], files[2]], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "f1.txt:hit\nf1.txt-y\n--\nf3.txt:hit\nf3.txt-z\n");

			let (code, stdout, stderr) =
				run_grep_in(&["-B1", "hit", files[0], files[1], files[2]], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "f1.txt-x\nf1.txt:hit\n--\nf3.txt:hit\n");

			let (code, stdout, stderr) =
				run_grep_in(&["-C1", "hit", files[0], files[1], files[2]], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "f1.txt-x\nf1.txt:hit\nf1.txt-y\n--\nf3.txt:hit\nf3.txt-z\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// A request of ZERO context lines still groups, so it separates files
		/// too. This is the case that decides the rule: the mark follows the
		/// GROUPING and not the number of context lines, which is why `-C0`
		/// prints it and plain `grep` does not.
		#[test]
		fn a_zero_radius_request_separates_files_as_well_as_gaps() {
			let root = tree("grep-separator-zero-radius");

			let (code, stdout, stderr) =
				run_grep_in(&["-C0", "hit", "f1.txt", "f2.txt", "f3.txt"], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "f1.txt:hit\n--\nf3.txt:hit\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// A run that asked for no grouping prints nothing between the files,
		/// which is the non-vacuity twin for every case above.
		#[test]
		fn a_run_that_asked_for_no_grouping_prints_none() {
			let root = tree("grep-separator-no-grouping");

			let (code, stdout, stderr) =
				run_grep_in(&["hit", "f1.txt", "f2.txt", "f3.txt"], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "f1.txt:hit\nf3.txt:hit\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// One setting shapes both places it appears: `--group-separator` changes
		/// the mark between files as well as the one between gaps, and
		/// `--no-group-separator` removes both. A second setting for the
		/// cross-file mark would be a second thing to keep in step.
		#[test]
		fn the_group_separator_flags_shape_it() {
			let root = tree("grep-separator-flags-shape-it");

			let (code, stdout, stderr) = run_grep_in(
				&["-A1", "--group-separator=XX", "hit", "f1.txt", "f2.txt", "f3.txt"],
				"",
				&root,
			);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "f1.txt:hit\nf1.txt-y\nXX\nf3.txt:hit\nf3.txt-z\n");

			let (code, stdout, stderr) = run_grep_in(
				&["-A1", "--no-group-separator", "hit", "f1.txt", "f2.txt", "f3.txt"],
				"",
				&root,
			);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "f1.txt:hit\nf1.txt-y\nf3.txt:hit\nf3.txt-z\n",
				"nothing at all, not an empty record"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// `-h` drops the names, and the separator is then the ONLY thing in the
		/// output that says where one file's lines end. It is printed for exactly
		/// that reason: it separates the output of two searches, not two names.
		#[test]
		fn it_is_printed_when_there_are_no_names_at_all() {
			let root = tree("grep-separator-no-filename");

			let (code, stdout, stderr) =
				run_grep_in(&["-h", "-A1", "hit", "f1.txt", "f2.txt", "f3.txt"], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "hit\ny\n--\nhit\nz\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// A summary mode prints one record per file and no separator, whatever
		/// context was asked for: `-c` and `-l` suppress context entirely, so
		/// there is no grouping left to mark.
		#[test]
		fn a_summary_mode_prints_none() {
			let root = tree("grep-separator-summary-mode");

			let (code, stdout, stderr) =
				run_grep_in(&["-A1", "-c", "hit", "f1.txt", "f2.txt", "f3.txt"], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "f1.txt:1\nf2.txt:0\nf3.txt:1\n");

			let (code, stdout, stderr) =
				run_grep_in(&["-A1", "-l", "hit", "f1.txt", "f2.txt", "f3.txt"], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "f1.txt\nf3.txt\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// A recursive search separates the files it walked to for the same
		/// reason, since the separator belongs to the OUTPUT and not to how the
		/// names were found. Two files in one directory, both matching, walked
		/// in a fixed order by naming them through `--include`.
		#[test]
		fn a_recursive_search_separates_the_files_it_walked_to() {
			let root = unique_tree("grep-separator-recursive");
			std::fs::create_dir_all(root.join("sub")).expect("the subdirectory");
			std::fs::write(root.join("sub/one.txt"), "hit\ntail\n").expect("the first fixture");

			let (code, stdout, stderr) =
				run_grep_in(&["-r", "-A1", "--include=one.txt", "hit", "sub"], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "sub/one.txt:hit\nsub/one.txt-tail\n");
			let _ = std::fs::remove_dir_all(root);
		}
	}

	/// The wording of a diagnostic about an operating-system failure.
	///
	/// THE BUG. Every one of these came from `io::Error`'s `Display`, which
	/// appends ` (os error N)`. GNU grep never prints that: the whole line is
	/// `grep: missing.txt: No such file or directory`, and a script or test
	/// matching on that text finds nothing when a code follows it. The sibling
	/// `rg` builtin KEEPS the suffix, because ripgrep prints it, which is why
	/// the rule has one owner per tool rather than one shared one. Found by the
	/// GNU grep differential suite. See `io_reason`.
	mod an_os_failure_is_reported_in_gnus_words {
		use super::*;

		/// A file that is not there, named exactly as the caller wrote it, with
		/// the reason and nothing after it.
		#[test]
		fn a_missing_operand_names_the_reason_alone() {
			let root = unique_tree("grep-io-reason-missing");
			std::fs::write(root.join("a.txt"), "alpha hit\n").expect("the fixture");

			let (code, stdout, stderr) = run_grep_in(&["hit", "a.txt", "missing.txt"], "", &root);

			assert_eq!(code, 2, "a failed operand sets the status even though another matched");
			assert_eq!(stdout, "a.txt:alpha hit\n", "and the operand that worked still printed");
			assert_eq!(stderr, "grep: missing.txt: No such file or directory\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// A file the process may not read reports the reason for THAT failure,
		/// so the rule is not a special case for one message.
		#[test]
		fn an_unreadable_file_names_its_own_reason() {
			let root = unique_tree("grep-io-reason-permission");
			let path = root.join("secret.txt");
			std::fs::write(&path, "alpha hit\n").expect("the fixture");
			let mut permissions = std::fs::metadata(&path).expect("metadata").permissions();
			#[cfg(unix)]
			{
				use std::os::unix::fs::PermissionsExt;
				permissions.set_mode(0o000);
			}
			std::fs::set_permissions(&path, permissions).expect("permissions should be set");

			let (code, stdout, stderr) = run_grep_in(&["hit", "secret.txt"], "", &root);

			// A root-run test can read it anyway, and then there is nothing to report.
			if code == 0 {
				assert_eq!(stdout, "alpha hit\n");
			} else {
				assert_eq!(code, 2);
				assert_eq!(stdout, "");
				assert_eq!(stderr, "grep: secret.txt: Permission denied\n");
			}
			let _ = std::fs::remove_dir_all(root);
		}

		/// `-f` reads its patterns from a file, and a missing one is reported the
		/// same way, through the same owner. The `grep: ` prefix is added by the
		/// caller here, which is why the reason has to arrive without a code
		/// attached.
		#[test]
		fn a_missing_pattern_file_names_the_reason_alone() {
			let root = unique_tree("grep-io-reason-pattern-file");

			let (code, stdout, stderr) = run_grep_in(&["-f", "missing.list", "a.txt"], "", &root);

			assert_eq!(code, 2);
			assert_eq!(stdout, "");
			assert_eq!(stderr, "grep: missing.list: No such file or directory\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `-s` hides the sentence and keeps the status, which is the contract of
		/// `--no-messages`: the wording rule above cannot be tested by a run that
		/// prints nothing, and this is the pair that shows the flag still works.
		#[test]
		fn no_messages_hides_the_sentence_and_keeps_the_status() {
			let root = unique_tree("grep-io-reason-quiet");
			std::fs::write(root.join("a.txt"), "alpha hit\n").expect("the fixture");

			let (code, stdout, stderr) =
				run_grep_in(&["-s", "hit", "a.txt", "missing.txt"], "", &root);

			assert_eq!(code, 2);
			assert_eq!(stdout, "a.txt:alpha hit\n");
			assert_eq!(stderr, "");
			let _ = std::fs::remove_dir_all(root);
		}

		/// A directory read as a file is reported in GNU's words too, and that
		/// message was never an `io::Error` at all: it is written by hand. Both
		/// shapes end up in the same form, which is the point of pinning them
		/// together.
		#[test]
		fn a_directory_operand_is_reported_the_same_way() {
			let root = unique_tree("grep-io-reason-directory");
			std::fs::create_dir_all(root.join("sub")).expect("the subdirectory");

			let (code, stdout, stderr) = run_grep_in(&["hit", "sub"], "", &root);

			assert_eq!(code, 2);
			assert_eq!(stdout, "");
			assert_eq!(stderr, "grep: sub: Is a directory\n");
			let _ = std::fs::remove_dir_all(root);
		}
	}

	/// What a summary mode reports for a DIRECTORY operand it could not read.
	///
	/// THE BUG. The builtin printed the diagnostic and moved on, so `grep -c hit
	/// somedir a.txt` reported only `a.txt:2`. GNU grep 3.11 prints `somedir:0`
	/// beside it and `-L` lists the directory, because GNU OPENED it and then
	/// read nothing: it is an input that was searched and matched nothing,
	/// which is a different thing from an operand that could not be opened at
	/// all. A caller comparing two trees file by file reads the missing line as
	/// "this path is not there". Found by the GNU grep differential suite.
	mod a_directory_read_as_a_file_is_an_input_that_matched_nothing {
		use super::*;

		/// A directory beside a file that matches twice.
		fn tree(label: &str) -> TempTree {
			let root = unique_tree(label);
			std::fs::create_dir_all(root.join("sub")).expect("the subdirectory");
			std::fs::write(root.join("sub/c.txt"), "deep hit\n").expect("the nested fixture");
			std::fs::write(root.join("a.txt"), "alpha hit\nhit hit\n").expect("the fixture");
			root
		}

		/// `-c` counts it as zero and keeps searching the operand after it, and
		/// the status still reports the failure.
		#[test]
		fn a_count_reports_zero_for_it() {
			let root = tree("grep-directory-count");

			let (code, stdout, stderr) = run_grep_in(&["-c", "hit", "sub", "a.txt"], "", &root);

			assert_eq!(code, 2, "the unreadable operand sets the status");
			assert_eq!(stdout, "sub:0\na.txt:2\n");
			assert_eq!(stderr, "grep: sub: Is a directory\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `-L` lists it and `-l` does not, which is the same answer read from
		/// both sides: it matched nothing.
		#[test]
		fn the_listing_modes_read_it_as_a_file_without_a_match() {
			let root = tree("grep-directory-listing");

			let (code, stdout, stderr) = run_grep_in(&["-L", "hit", "sub", "a.txt"], "", &root);
			assert_eq!(code, 2, "{stderr}");
			assert_eq!(stdout, "sub\n");

			let (code, stdout, stderr) = run_grep_in(&["-l", "hit", "sub", "a.txt"], "", &root);
			assert_eq!(code, 2, "{stderr}");
			assert_eq!(stdout, "a.txt\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// The zero count goes through the SAME printer as every other count, so
		/// `-Z` reaches it: a second code path for this one line would have been
		/// a second place for the separator rules to drift.
		#[test]
		fn the_null_separator_reaches_the_zero_count() {
			let root = tree("grep-directory-null");

			let (code, stdout, stderr) = run_grep_in(&["-c", "-Z", "hit", "sub", "a.txt"], "", &root);

			assert_eq!(code, 2, "{stderr}");
			// `\u{0}` rather than `\0`, so the digit after it cannot be read as part of
			// the escape by a human skimming the line.
			assert_eq!(stdout, "sub\u{0}0\na.txt\u{0}2\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `-s` hides the sentence and keeps the count line, because a count is
		/// not a message: `--no-messages` is about diagnostics and this line is
		/// output.
		#[test]
		fn no_messages_keeps_the_zero_count() {
			let root = tree("grep-directory-quiet");

			let (code, stdout, stderr) = run_grep_in(&["-c", "-s", "hit", "sub", "a.txt"], "", &root);

			assert_eq!(code, 2);
			assert_eq!(stdout, "sub:0\na.txt:2\n");
			assert_eq!(stderr, "");
			let _ = std::fs::remove_dir_all(root);
		}

		/// The pair that fixes the rule to what HAPPENED and not to what failed:
		/// a missing operand was never opened, so it gets no count line at all.
		#[test]
		fn a_missing_operand_gets_no_count_line() {
			let root = tree("grep-directory-missing-twin");

			let (code, stdout, stderr) =
				run_grep_in(&["-c", "hit", "a.txt", "missing.txt"], "", &root);

			assert_eq!(code, 2);
			assert_eq!(stdout, "a.txt:2\n", "no `missing.txt:0` line");
			assert_eq!(stderr, "grep: missing.txt: No such file or directory\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// A record mode says nothing about it, and `-d skip` says nothing
		/// either, which is the flag a caller uses to mean "walk past
		/// directories".
		#[test]
		fn a_record_mode_and_skip_both_stay_silent_about_it() {
			let root = tree("grep-directory-record-mode");

			let (code, stdout, stderr) = run_grep_in(&["-A1", "hit", "sub", "a.txt"], "", &root);
			assert_eq!(code, 2);
			assert_eq!(stdout, "a.txt:alpha hit\na.txt:hit hit\n");
			assert_eq!(stderr, "grep: sub: Is a directory\n");

			let (code, stdout, stderr) =
				run_grep_in(&["-c", "-d", "skip", "hit", "sub", "a.txt"], "", &root);
			assert_eq!(code, 0, "skipping is not a failure");
			assert_eq!(stdout, "a.txt:2\n");
			assert_eq!(stderr, "");
			let _ = std::fs::remove_dir_all(root);
		}
	}

	/// The POSIX span rule, and the guarantee that it costs nothing outside the
	/// one mode that needs it.
	///
	/// GNU grep reports the LONGEST of the alternatives that match at a
	/// position, and both engines this builtin can use report the one written
	/// first. The rule is implemented as a second automaton over the same
	/// compiled patterns, built only for a run that prints a span, and every
	/// expectation here was measured against GNU grep 3.11.
	mod the_reported_span_is_the_longest_one_posix_would_report {
		use super::*;

		/// Parse a command line the way `run` does, and build its matcher.
		///
		/// Through `parse`, the same function `run` uses, so a flag that reaches
		/// the span engine here reaches it in the shipped path too.
		fn built(pattern: &str, args: &[&str]) -> BuiltMatcher {
			let argv: Vec<OsString> = std::iter::once(OsString::from("grep"))
				.chain(args.iter().map(OsString::from))
				.chain(std::iter::once(OsString::from(pattern)))
				.chain(std::iter::once(OsString::from("a.txt")))
				.collect();
			let (cli, matches) = parse(argv).expect("the fixture argv should parse");
			let mode = resolve_match_mode(&matches).expect("the fixture mode should resolve");
			build_matcher(&[pattern.to_string()], &cli, mode, resolve_ignore_case(&matches))
				.expect("the fixture pattern should compile")
		}

		/// A run that prints no span builds no span engine.
		///
		/// This is the Law 7 half of the rule: the second automaton is real work,
		/// and a mode whose output never shows a span must not pay for it. The
		/// line scan every other mode runs is the first engine's, untouched.
		#[test]
		fn a_mode_that_prints_no_span_builds_no_span_engine() {
			for args in [
				vec!["-E"],
				vec!["-c", "-E"],
				vec!["-l", "-E"],
				vec!["-n", "-E"],
				vec!["-b", "-E"],
				vec!["-q", "-E"],
			] {
				assert!(
					built("hit|hit hit", &args).posix_longest.is_none(),
					"{args:?} prints no span and must not build the span engine"
				);
			}
		}

		/// `-o` does build one.
		#[test]
		fn only_matching_builds_the_span_engine() {
			assert!(built("hit|hit hit", &["-o", "-E"]).posix_longest.is_some());
		}

		/// `-x` builds none, because a whole-line match has no span to choose.
		///
		/// Not an optimisation: the span engine here would report a span the
		/// whole-line matcher never reports, so building it would be a way to get
		/// the answer wrong.
		#[test]
		fn whole_line_matching_has_no_span_to_choose() {
			assert!(
				built("hit hit hit|hit", &["-o", "-x", "-E"])
					.posix_longest
					.is_none()
			);
		}

		/// A pattern that needs PCRE2 keeps the leftmost-first span.
		///
		/// A back-reference is not a regular language, so this engine cannot
		/// compile it and there is nothing to build. The differential corpus
		/// carries the matching case, so the divergence is measured rather than
		/// assumed.
		#[test]
		fn a_pcre2_pattern_has_no_span_engine() {
			assert!(built("(hit) \\1", &["-o", "-P"]).posix_longest.is_none());
			assert!(
				built("\\(hit\\) \\1", &["-o", "-G"])
					.posix_longest
					.is_none()
			);
		}

		/// The engine reports the longest end at a start, whatever the branch
		/// order.
		#[test]
		fn the_longest_end_wins_in_either_branch_order() {
			for pattern in ["hit|hit hit", "hit hit|hit"] {
				let flags = GrepMatcherFlags {
					case_insensitive: false,
					word:             false,
					whole_line:       false,
					line_terminator:  None,
				};
				let longest = PosixLongest::build(&[pattern.to_string()], &flags)
					.expect("the pattern should compile");
				let mut cache = longest.cache();

				assert_eq!(
					longest.longest_end(&mut cache, b"hit hit hit", 0),
					Some(7),
					"{pattern}: `hit hit` is the longest match at 0"
				);
				assert_eq!(
					longest.longest_end(&mut cache, b"hit hit hit", 8),
					Some(11),
					"{pattern}: only `hit` is left at 8"
				);
				assert_eq!(
					longest.longest_end(&mut cache, b"hit hit hit", 1),
					None,
					"{pattern}: nothing matches at 1, since the search is anchored there"
				);
			}
		}

		/// Under `-w` the longest end that still ends a word wins.
		///
		/// The start is the first engine's answer and already satisfies `-w`, so
		/// this filters ends only: `hits` is a longer match than `hit` and it
		/// is the answer only where the line does not carry on into another
		/// word character.
		#[test]
		fn the_word_rule_filters_which_ends_are_allowed() {
			let flags = GrepMatcherFlags {
				case_insensitive: false,
				word:             true,
				whole_line:       false,
				line_terminator:  None,
			};
			let longest = PosixLongest::build(&["hit|hits".to_string()], &flags)
				.expect("the pattern should compile");
			let mut cache = longest.cache();

			assert_eq!(
				longest.longest_end(&mut cache, b"hits", 0),
				Some(4),
				"`hits` ends the line, so the longer span is allowed"
			);
			assert_eq!(
				longest.longest_end(&mut cache, b"hitsy", 0),
				None,
				"neither `hit` nor `hits` ends a word here, so `-w` allows no span"
			);
			assert_eq!(
				longest.longest_end(&mut cache, b"hit hits", 0),
				Some(3),
				"`hit ` ends a word and `hits` would not fit at 0"
			);
		}

		/// Case folding reaches the span engine too.
		///
		/// The span engine is a second compilation of the same patterns, so every
		/// flag that changes what matches has to be applied to it as well. `-i`
		/// is the one that would silently report NO span at all if it were
		/// forgotten, which would leave the leftmost-first span in place and
		/// look like the bug this whole thing fixes.
		#[test]
		fn case_folding_reaches_the_span_engine() {
			let flags = GrepMatcherFlags {
				case_insensitive: true,
				word:             false,
				whole_line:       false,
				line_terminator:  None,
			};
			let longest = PosixLongest::build(&["HIT|HIT HIT".to_string()], &flags)
				.expect("the pattern should compile");
			let mut cache = longest.cache();

			assert_eq!(longest.longest_end(&mut cache, b"hit hit hit", 0), Some(7));
		}

		/// Several patterns, one span engine.
		///
		/// `-e a -e b` compiles both, and the longest span across ALL of them is
		/// the answer, so the engine is built from the whole list rather than
		/// from the first pattern.
		#[test]
		fn every_pattern_in_the_list_can_own_the_longest_span() {
			let flags = GrepMatcherFlags {
				case_insensitive: false,
				word:             false,
				whole_line:       false,
				line_terminator:  None,
			};
			let patterns = ["hit".to_string(), "hit hit".to_string()];
			let longest =
				PosixLongest::build(&patterns, &flags).expect("both patterns should compile");
			let mut cache = longest.cache();

			assert_eq!(
				longest.longest_end(&mut cache, b"hit hit hit", 0),
				Some(7),
				"the second pattern is the longer match at 0"
			);
		}

		/// The terminator is not part of the line a span is measured against.
		///
		/// A record arrives with its terminator on it, and a pattern ending in
		/// `.` or a character class would happily swallow it and report a span
		/// one byte too long, printing a stray newline in the middle of `-o`
		/// output. `strip_record_terminator` is the one owner of that rule for
		/// both builtins.
		#[test]
		fn a_span_never_covers_the_records_terminator() {
			assert_eq!(strip_record_terminator(b"hit\n", b'\n'), b"hit");
			assert_eq!(strip_record_terminator(b"hit\0", b'\0'), b"hit");
			assert_eq!(
				strip_record_terminator(b"hit\n", b'\0'),
				b"hit\n",
				"under -z a newline is ordinary content"
			);
			assert_eq!(strip_record_terminator(b"hit", b'\n'), b"hit", "an unterminated last line");
			assert_eq!(strip_record_terminator(b"", b'\n'), b"", "an empty record");
		}

		/// End to end, the shape the ledger row was filed for.
		///
		/// `grep -o -E 'hit|hit hit'` over `hit hit hit` prints `hit hit` and
		/// then `hit`, which is GNU grep 3.11's own output for the same
		/// command.
		#[test]
		fn the_alternation_that_filed_the_row_prints_gnus_spans() {
			let root = unique_tree("posix-longest-span");
			std::fs::write(root.join("dup.txt"), "hit hit hit\n").expect("the fixture");

			let (code, stdout, stderr) =
				run_grep_in(&["-o", "-E", "hit|hit hit", "dup.txt"], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "hit hit\nhit\n");
			assert_eq!(stderr, "");
		}
	}
}
