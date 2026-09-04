//! `rg` implemented as an in-process shell builtin on top of the ripgrep
//! libraries, with ripgrep defaults: recursive directory search, ignore/hidden
//! filtering, and binary-file suppression.

use std::{
	ffi::{OsStr, OsString},
	fs::File,
	io::{self, BufWriter, LineWriter, Read, Write},
	path::{Path, PathBuf},
	process::{Command, Stdio},
	sync::OnceLock,
	time::{Duration, Instant},
};

use clap::{ArgAction, CommandFactory, FromArgMatches, Parser, ValueEnum};
use grep_cli::{CommandReader, DecompressionMatcher};
use grep_matcher::{Captures, LineTerminator, Match as Span, Matcher};
use grep_pcre2::{RegexMatcher as PcreMatcher, RegexMatcherBuilder as PcreMatcherBuilder};
use grep_printer::{JSONBuilder, Stats};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{
	BinaryDetection, Encoding, Searcher, Sink, SinkContext, SinkFinish, SinkMatch,
};
use ignore::{
	Match,
	gitignore::{Gitignore, GitignoreBuilder},
	overrides::{Override, OverrideBuilder},
	types::{Types, TypesBuilder},
};
use veyyon_grep_kernel::{
	CompiledMatcher, SearcherSpec, build_searcher as kernel_build_searcher, pcre_matcher_defaults,
};

/// The flags that choose what a run PRINTS, as one mutually exclusive group.
///
/// ripgrep has a single output mode per run, and every flag that sets one
/// overrides every other: the LAST one on the command line wins, and that is
/// true across the whole group rather than within pairs of it. Measured on
/// ripgrep 15.1.0: `rg --json -c hit a.txt` prints `2`, `rg -c --json hit
/// a.txt` prints the JSON stream, `rg --json -l -c` prints `2` and `rg --json
/// -c -l` prints the path. It holds inside a cluster too, where the flags share
/// one argv position: `-cl` lists and `-lc` counts.
///
/// Naming the group here rather than resolving it later is what makes the rule
/// ONE thing. The version this replaced had no group at all: `--json` combined
/// with any of the others was REFUSED with a diagnostic ripgrep does not have
/// (`rg: --json cannot be combined with summary modes`, exit 2), and the rest
/// of the group resolved by a fixed precedence written into `search_options` as
/// a chain of `&& !` guards, so `-l -c` and `-c -l` gave the same answer where
/// ripgrep gives two. `--files` and `--type-list` belong in the group because
/// they are output modes as much as the others are, which is why `rg -l
/// --files` lists files and `rg --files -l` searches.
///
/// `-q`, `-o` and `--vimgrep` are deliberately absent. They are not modes: `-q`
/// asks for the exit code only and still emits a `--json` summary record, while
/// `-o` and `--vimgrep` change how a matching line is written and are ignored
/// outright in JSON mode. All three were measured in both orders against every
/// member of the group before being left out.
const OUTPUT_MODE_FLAGS: [&str; 8] = [
	"json",
	"count",
	"count_matches",
	"files_with_matches",
	"files_without_match",
	"files",
	"type_list",
	"generate",
];

#[derive(Parser, Debug)]
#[command(
	name = "rg",
	version = "15.1.0",
	author = "Andrew Gallant <jamslam@gmail.com>",
	about = "ripgrep recursively searches the current directory for lines matching a regex pattern.",
	args_override_self = true
)]
struct RgCli {
	/// A pattern to search for. May be repeated.
	#[arg(short = 'e', long = "regexp", value_name = "PATTERN", allow_hyphen_values = true)]
	patterns: Vec<String>,

	/// Read patterns from a file, one pattern per line.
	#[arg(short = 'f', long = "file", value_name = "PATTERNFILE", allow_hyphen_values = true)]
	pattern_files: Vec<OsString>,

	/// Search supported compressed files through external decompressors.
	#[arg(short = 'z', long = "search-zip", overrides_with = "no_search_zip")]
	search_zip: bool,

	/// Disable compressed-file searching.
	#[arg(long = "no-search-zip", overrides_with = "search_zip")]
	no_search_zip: bool,

	/// Search the standard output of COMMAND PATH instead of the contents of
	/// PATH.
	///
	/// The value is one program, not a command line: `--pre "cat -A"` looks for
	/// a program called `cat -A`, which is ripgrep's behaviour and the reason
	/// its help tells you to write a wrapper script. An empty value disables
	/// the preprocessor, so `--pre ""` and `--no-pre` say the same thing.
	#[arg(
		long = "pre",
		value_name = "COMMAND",
		overrides_with = "no_pre",
		allow_hyphen_values = true
	)]
	pre: Option<OsString>,

	/// Disable the preprocessor command.
	#[arg(long = "no-pre", overrides_with = "pre")]
	no_pre: bool,

	/// Hand only the files matching GLOB to the preprocessor. May be repeated.
	#[arg(long = "pre-glob", value_name = "GLOB", allow_hyphen_values = true)]
	pre_globs: Vec<String>,

	/// Select the regular expression engine.
	#[arg(
		long = "engine",
		allow_hyphen_values = true,
		value_name = "ENGINE",
		value_parser = parse_regex_engine,
		overrides_with_all = ["pcre2", "no_pcre2"]
	)]
	engine: Option<RegexEngine>,

	/// Use the PCRE2 regular expression engine.
	#[arg(
		short = 'P',
		long = "pcre2",
		overrides_with_all = ["engine", "no_pcre2"]
	)]
	pcre2: bool,

	/// Restore the default regular expression engine.
	#[arg(long = "no-pcre2", overrides_with_all = ["engine", "pcre2"])]
	no_pcre2: bool,

	/// Decode input using ENCODING before searching.
	#[arg(
		short = 'E',
		long = "encoding",
		value_name = "ENCODING",
		overrides_with = "no_encoding",
		allow_hyphen_values = true
	)]
	encoding: Option<String>,

	/// Restore automatic BOM-based encoding detection.
	#[arg(long = "no-encoding", overrides_with = "encoding")]
	no_encoding: bool,

	/// Treat CRLF as a single line terminator.
	#[arg(long = "crlf", overrides_with = "no_crlf")]
	crlf: bool,

	/// Restore LF line terminators.
	#[arg(long = "no-crlf", overrides_with = "crlf")]
	no_crlf: bool,

	/// Disable Unicode regex mode.
	#[arg(long = "no-unicode", overrides_with = "unicode")]
	no_unicode: bool,

	/// Enable Unicode regex mode.
	#[arg(long = "unicode", overrides_with = "no_unicode", hide = true)]
	unicode: bool,

	/// Treat patterns as literals instead of regular expressions.
	#[arg(short = 'F', long = "fixed-strings", overrides_with = "no_fixed_strings")]
	fixed_strings: bool,

	/// Re-enable regex parsing after --fixed-strings.
	#[arg(long = "no-fixed-strings", overrides_with = "fixed_strings")]
	no_fixed_strings: bool,

	/// Search case-insensitively.
	#[arg(short = 'i', long = "ignore-case", overrides_with_all = ["case_sensitive", "smart_case"])]
	ignore_case: bool,

	/// Search case-sensitively.
	#[arg(short = 's', long = "case-sensitive", overrides_with_all = ["ignore_case", "smart_case"])]
	case_sensitive: bool,

	/// Search case-insensitively when the pattern is all lowercase.
	#[arg(short = 'S', long = "smart-case", overrides_with_all = ["ignore_case", "case_sensitive"])]
	smart_case: bool,

	/// Invert matching.
	#[arg(short = 'v', long = "invert-match")]
	invert_match: bool,

	/// Match only whole words.
	///
	/// `-w` and `-x` override each other, so the one written LAST wins. This is
	/// where `rg` and GNU `grep` genuinely disagree and neither can borrow the
	/// other's rule: `grep -x -w` matches whole LINES, because `-x` wins there
	/// regardless of order, while `rg -x -w` matches whole WORDS. The `grep`
	/// builtin keeps its own fixed precedence for exactly this reason.
	#[arg(short = 'w', long = "word-regexp", overrides_with = "line_regexp")]
	word_regexp: bool,

	/// Match only whole lines.
	#[arg(short = 'x', long = "line-regexp", overrides_with = "word_regexp")]
	line_regexp: bool,

	/// Limit matching lines per searched file.
	#[arg(
		short = 'm',
		long = "max-count",
		value_name = "NUM",
		allow_hyphen_values = true,
		value_parser = parse_flag_number::<u64>
	)]
	max_count: Option<u64>,

	/// Enable multiline search.
	#[arg(short = 'U', long = "multiline")]
	multiline: bool,

	/// Make . match line terminators in multiline mode.
	#[arg(long = "multiline-dotall")]
	multiline_dotall: bool,

	/// Search binary files as text.
	#[arg(short = 'a', long = "text")]
	text: bool,

	/// Search binary files.
	#[arg(long = "binary")]
	binary: bool,

	/// Reduce smart filtering. Repeating includes hidden and binary files.
	#[arg(short = 'u', long = "unrestricted", action = ArgAction::Count)]
	unrestricted: u8,

	/// Follow symbolic links.
	#[arg(short = 'L', long = "follow", overrides_with = "no_follow")]
	follow: bool,

	/// Do not follow symbolic links.
	#[arg(long = "no-follow", overrides_with = "follow")]
	no_follow: bool,

	/// Apply -g/--glob patterns case insensitively.
	#[arg(long = "glob-case-insensitive", overrides_with = "no_glob_case_insensitive")]
	glob_case_insensitive: bool,

	/// Restore case-sensitive -g/--glob matching.
	#[arg(long = "no-glob-case-insensitive", overrides_with = "glob_case_insensitive", hide = true)]
	no_glob_case_insensitive: bool,

	/// Include or exclude paths with a gitignore-style glob.
	#[arg(short = 'g', long = "glob", value_name = "GLOB", allow_hyphen_values = true)]
	globs: Vec<String>,

	/// Case-insensitive include/exclude glob.
	#[arg(long = "iglob", value_name = "GLOB", allow_hyphen_values = true)]
	iglobs: Vec<String>,

	/// Search hidden files and directories.
	#[arg(short = '.', long = "hidden", overrides_with = "no_hidden")]
	hidden: bool,

	/// Do not search hidden files and directories.
	#[arg(long = "no-hidden", overrides_with = "hidden")]
	no_hidden: bool,

	/// Ignore .gitignore, .ignore and .rgignore files.
	#[arg(long = "no-ignore", overrides_with = "ignore")]
	no_ignore: bool,

	/// Respect ignore files.
	#[arg(long = "ignore", overrides_with = "no_ignore")]
	ignore: bool,

	/// Apply additional gitignore-formatted rules from PATH.
	#[arg(long = "ignore-file", value_name = "PATH", allow_hyphen_values = true)]
	ignore_files: Vec<OsString>,

	/// Ignore .ignore and .rgignore files.
	#[arg(long = "no-ignore-dot", overrides_with = "ignore_dot")]
	no_ignore_dot: bool,

	/// Respect .ignore and .rgignore files.
	#[arg(long = "ignore-dot", overrides_with = "no_ignore_dot")]
	ignore_dot: bool,

	/// Ignore repository exclude files.
	#[arg(long = "no-ignore-exclude", overrides_with = "ignore_exclude")]
	no_ignore_exclude: bool,

	/// Respect repository exclude files.
	#[arg(long = "ignore-exclude", overrides_with = "no_ignore_exclude")]
	ignore_exclude: bool,

	/// Ignore global gitignore files.
	#[arg(long = "no-ignore-global", overrides_with = "ignore_global")]
	no_ignore_global: bool,

	/// Respect global gitignore files.
	#[arg(long = "ignore-global", overrides_with = "no_ignore_global")]
	ignore_global: bool,

	/// Ignore parent ignore files.
	#[arg(long = "no-ignore-parent", overrides_with = "ignore_parent")]
	no_ignore_parent: bool,

	/// Respect parent ignore files.
	#[arg(long = "ignore-parent", overrides_with = "no_ignore_parent")]
	ignore_parent: bool,

	/// Ignore VCS ignore files.
	#[arg(long = "no-ignore-vcs", overrides_with = "ignore_vcs")]
	no_ignore_vcs: bool,

	/// Respect VCS ignore files.
	#[arg(long = "ignore-vcs", overrides_with = "no_ignore_vcs")]
	ignore_vcs: bool,

	/// Respect VCS ignores even outside a repository.
	#[arg(long = "no-require-git", overrides_with = "require_git")]
	no_require_git: bool,

	/// Require a repository for VCS ignore files.
	#[arg(long = "require-git", overrides_with = "no_require_git", hide = true)]
	require_git: bool,

	/// Do not cross filesystem boundaries while traversing a root.
	#[arg(long = "one-file-system", overrides_with = "no_one_file_system")]
	one_file_system: bool,

	/// Permit traversal across filesystem boundaries.
	#[arg(long = "no-one-file-system", overrides_with = "one_file_system", hide = true)]
	no_one_file_system: bool,

	/// Limit directory traversal depth.
	#[arg(
		short = 'd',
		long = "max-depth",
		alias = "maxdepth",
		value_name = "NUM",
		allow_hyphen_values = true,
		value_parser = parse_flag_number::<usize>
	)]
	max_depth: Option<usize>,

	/// Ignore files larger than this size.
	#[arg(
		long = "max-filesize",
		value_name = "NUM",
		allow_hyphen_values = true,
		value_parser = parse_size
	)]
	max_filesize: Option<u64>,

	/// Search only files matching a type.
	#[arg(short = 't', long = "type", value_name = "TYPE", allow_hyphen_values = true)]
	types: Vec<String>,

	/// Do not search files matching a type.
	#[arg(short = 'T', long = "type-not", value_name = "TYPE", allow_hyphen_values = true)]
	type_nots: Vec<String>,

	/// Add a file type glob.
	#[arg(long = "type-add", value_name = "TYPESPEC", allow_hyphen_values = true)]
	type_adds: Vec<String>,

	/// Clear a file type definition.
	#[arg(long = "type-clear", value_name = "TYPE", allow_hyphen_values = true)]
	type_clears: Vec<String>,

	/// Show NUM lines after each match.
	#[arg(
		short = 'A',
		long = "after-context",
		value_name = "NUM",
		allow_hyphen_values = true,
		value_parser = parse_flag_number::<usize>
	)]
	after_context: Option<usize>,

	/// Show NUM lines before each match.
	#[arg(
		short = 'B',
		long = "before-context",
		value_name = "NUM",
		allow_hyphen_values = true,
		value_parser = parse_flag_number::<usize>
	)]
	before_context: Option<usize>,

	/// Show NUM lines before and after each match.
	#[arg(
		short = 'C',
		long = "context",
		value_name = "NUM",
		allow_hyphen_values = true,
		value_parser = parse_flag_number::<usize>
	)]
	context: Option<usize>,

	/// Show line numbers.
	#[arg(short = 'n', long = "line-number", overrides_with = "no_line_number")]
	line_number: bool,

	/// Suppress line numbers.
	#[arg(short = 'N', long = "no-line-number", overrides_with = "line_number")]
	no_line_number: bool,

	/// Show column numbers.
	#[arg(long = "column")]
	column: bool,

	/// Show the zero-based byte offset for each result.
	#[arg(short = 'b', long = "byte-offset", overrides_with = "no_byte_offset")]
	byte_offset: bool,

	/// Suppress byte offsets.
	#[arg(long = "no-byte-offset", overrides_with = "byte_offset", hide = true)]
	no_byte_offset: bool,

	/// Print file paths with matches.
	#[arg(short = 'H', long = "with-filename")]
	with_filename: bool,

	/// Suppress file paths with matches.
	#[arg(short = 'I', long = "no-filename")]
	no_filename: bool,

	/// Print only files containing matches.
	#[arg(short = 'l', long = "files-with-matches", overrides_with_all = OUTPUT_MODE_FLAGS)]
	files_with_matches: bool,

	/// Print only files containing no matches. Exits 0 when a path is printed
	/// and 1 when none is, so the status reports what was listed rather than
	/// what matched.
	#[arg(long = "files-without-match", overrides_with_all = OUTPUT_MODE_FLAGS)]
	files_without_match: bool,

	/// Print matching-line counts per file.
	#[arg(short = 'c', long = "count", overrides_with_all = OUTPUT_MODE_FLAGS)]
	count: bool,

	/// Print individual match counts per file.
	#[arg(long = "count-matches", overrides_with_all = OUTPUT_MODE_FLAGS)]
	count_matches: bool,

	/// Print only matching spans.
	#[arg(short = 'o', long = "only-matching")]
	only_matching: bool,

	/// Replace each printed match with REPLACEMENT.
	#[arg(short = 'r', long = "replace", value_name = "REPLACEMENT", allow_hyphen_values = true)]
	replacement: Option<OsString>,

	/// Emit ripgrep-compatible JSON Lines messages.
	#[arg(long = "json", overrides_with_all = OUTPUT_MODE_FLAGS)]
	json: bool,

	/// Disable JSON Lines output.
	#[arg(long = "no-json", hide = true)]
	no_json: bool,

	/// Suppress normal output, including context lines, and exit on the first
	/// match.
	#[arg(short = 'q', long = "quiet")]
	quiet: bool,

	/// Print every match in vimgrep format. Context lines keep the plain
	/// path-line-text form.
	#[arg(long = "vimgrep")]
	vimgrep: bool,

	/// Follow a path name with NUL instead of the byte that would follow it: the
	/// `:` of a prefix, or the line terminator when the path is the whole
	/// record.
	#[arg(short = '0', long = "null")]
	null: bool,

	/// Use NUL as the record separator, on input AND output, so the result can
	/// be read by a NUL-splitting consumer such as `xargs -0`.
	#[arg(long = "null-data")]
	null_data: bool,

	/// Flush output after every result record.
	#[arg(long = "line-buffered", overrides_with_all = BUFFER_MODE_FLAGS)]
	line_buffered: bool,

	/// Return output buffering to the default for the destination.
	#[arg(long = "no-line-buffered", overrides_with_all = BUFFER_MODE_FLAGS, hide = true)]
	no_line_buffered: bool,

	/// Hold output in a fixed-size buffer even when writing to a terminal.
	#[arg(long = "block-buffered", overrides_with_all = BUFFER_MODE_FLAGS)]
	block_buffered: bool,

	/// Return output buffering to the default for the destination.
	#[arg(long = "no-block-buffered", overrides_with_all = BUFFER_MODE_FLAGS, hide = true)]
	no_block_buffered: bool,

	/// Print files that would be searched.
	#[arg(long = "files", overrides_with_all = OUTPUT_MODE_FLAGS)]
	files: bool,

	/// Print all supported file types.
	#[arg(long = "type-list", overrides_with_all = OUTPUT_MODE_FLAGS)]
	type_list: bool,

	/// Write a man page or a shell completion script to standard output.
	#[arg(
		long = "generate",
		value_name = "KIND",
		value_parser = parse_generate_kind,
		allow_hyphen_values = true,
		overrides_with_all = OUTPUT_MODE_FLAGS
	)]
	generate: Option<GenerateKind>,

	/// Suppress file-open/read diagnostics.
	#[arg(long = "no-messages", overrides_with = "messages")]
	no_messages: bool,

	/// Re-enable diagnostics.
	#[arg(long = "messages", overrides_with = "no_messages")]
	messages: bool,

	/// Print a count of 0 for files that matched nothing.
	#[arg(long = "include-zero")]
	include_zero: bool,

	/// Byte printed in place of `/` in every path this run prints.
	#[arg(long = "path-separator", value_name = "SEPARATOR", allow_hyphen_values = true)]
	path_separator: Option<String>,

	/// String printed between two non-contiguous groups of context lines.
	#[arg(long = "context-separator", value_name = "SEPARATOR", allow_hyphen_values = true)]
	context_separator: Option<String>,

	/// Print nothing between two non-contiguous groups of context lines.
	#[arg(long = "no-context-separator", overrides_with = "context_separator")]
	no_context_separator: bool,

	/// String printed between the fields of a context line.
	#[arg(long = "field-context-separator", value_name = "SEPARATOR", allow_hyphen_values = true)]
	field_context_separator: Option<String>,

	/// String printed between the fields of a matching line.
	#[arg(long = "field-match-separator", value_name = "SEPARATOR", allow_hyphen_values = true)]
	field_match_separator: Option<String>,

	/// Sort paths before searching: path, modified, accessed, created, none.
	#[arg(
		long = "sort",
		value_name = "SORTBY",
		overrides_with = "sortr",
		allow_hyphen_values = true
	)]
	sort: Option<String>,

	/// Sort paths descending before searching: path, modified, accessed,
	/// created, none.
	#[arg(
		long = "sortr",
		value_name = "SORTBY",
		overrides_with = "sort",
		allow_hyphen_values = true
	)]
	sortr: Option<String>,

	/// Deprecated alias for --sort=path.
	#[arg(long = "sort-files", overrides_with = "no_sort_files")]
	sort_files: bool,

	/// Disable --sort-files.
	#[arg(long = "no-sort-files", overrides_with = "sort_files")]
	no_sort_files: bool,

	/// Print both matching and non-matching lines. Ignored when -A, -B or -C is
	/// given, including -C0: the context request wins.
	#[arg(long = "passthru", alias = "passthrough")]
	passthru: bool,

	/// Trim leading ASCII whitespace from printed lines.
	#[arg(long = "trim", overrides_with = "no_trim")]
	trim: bool,

	/// Disable --trim.
	#[arg(long = "no-trim", overrides_with = "trim")]
	no_trim: bool,

	/// Omit matching lines longer than this many bytes.
	#[arg(
		short = 'M',
		long = "max-columns",
		value_name = "NUM",
		allow_hyphen_values = true,
		value_parser = parse_flag_number::<usize>
	)]
	max_columns: Option<usize>,

	/// Preview lines omitted by --max-columns.
	#[arg(long = "max-columns-preview", overrides_with = "no_max_columns_preview")]
	max_columns_preview: bool,

	/// Disable --max-columns-preview.
	#[arg(long = "no-max-columns-preview", overrides_with = "max_columns_preview")]
	no_max_columns_preview: bool,

	/// Accepted for CLI compatibility; this builtin never emits color.
	#[arg(long = "color", value_name = "WHEN", value_parser = parse_color_choice, allow_hyphen_values = true)]
	_color: Option<String>,

	/// Accepted for CLI compatibility; this builtin never emits color.
	#[arg(long = "colors", value_name = "COLOR_SPEC", allow_hyphen_values = true)]
	_colors: Vec<String>,

	/// Print each file name once above its matches instead of on every line.
	#[arg(long = "heading", overrides_with = "no_heading")]
	heading: bool,

	/// Disable heading mode.
	#[arg(long = "no-heading", overrides_with = "heading")]
	no_heading: bool,

	/// Pretty output alias (accepted; the colors it also implies are not
	/// emitted).
	///
	/// Real `-p` is `--heading --line-number --color=always`. The first two are
	/// implemented, so `-p` is wired to them; the color half is not, and this
	/// builtin writes to a captured buffer rather than a terminal, where color
	/// escapes would be noise in whatever is reading the output.
	#[arg(short = 'p', long = "pretty")]
	pretty: bool,

	/// Print a summary of matches, files and timings after the results.
	#[arg(long = "stats", overrides_with = "no_stats")]
	stats: bool,

	/// Disable aggregate stats.
	#[arg(long = "no-stats", overrides_with = "stats")]
	no_stats: bool,

	/// Arguments: PATTERN followed by PATHs unless -e/-f/--files is used.
	#[arg(value_name = "ARGS")]
	args: Vec<OsString>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum RegexEngine {
	Default,
	Pcre2,
	Auto,
}

/// The four flags that choose how output is buffered.
///
/// One state with three values rather than four independent booleans, and each
/// flag overrides all of them, so the LAST spelling on the command line wins.
/// That is ripgrep's rule and its own help says so from both sides:
/// `--line-buffered` documents `This overrides the --block-buffered flag` and
/// `--block-buffered` documents the reverse. Four booleans cannot express that,
/// which is how `--line-buffered --block-buffered` ends up meaning something
/// other than `--block-buffered` alone.
const BUFFER_MODE_FLAGS: [&str; 4] =
	["line_buffered", "no_line_buffered", "block_buffered", "no_block_buffered"];

/// How output reaches the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Buffering {
	/// Flush at every line terminator, so a pipeline stage downstream sees each
	/// match as it is found.
	Line,
	/// Fill a fixed-size buffer first, which is fewer writes for a large result
	/// set and is what a redirect to a file wants.
	Block,
}

impl Buffering {
	/// The mode for this command line, given whether stdout is a terminal.
	///
	/// The terminal is the DEFAULT and not an override: ripgrep line-buffers to
	/// a tty so a long search shows results while it runs, and block-buffers to
	/// a pipe or a file because that is faster. Either explicit flag wins over
	/// the default, and `--no-line-buffered` / `--no-block-buffered` return the
	/// decision to the destination rather than forcing the other mode, which is
	/// why they are values of this state and not their own booleans.
	fn resolve(cli: &RgCli, stdout_is_terminal: bool) -> Self {
		if cli.line_buffered {
			return Self::Line;
		}
		if cli.block_buffered {
			return Self::Block;
		}
		if stdout_is_terminal {
			Self::Line
		} else {
			Self::Block
		}
	}

	/// Wrap `sink` so it buffers the way this mode says.
	///
	/// `LineWriter` rather than writing straight through: a matching line is
	/// emitted as several writes (path, separator, line number, separator, the
	/// line itself), and an unbuffered sink turns each of those into its own
	/// write syscall, so a line-buffered run cost five where it needs one. It
	/// also means a consumer never reads half a record.
	fn wrap<W: Write>(self, sink: W) -> RgSinkOf<W> {
		match self {
			Self::Line => RgSinkOf::Line(LineWriter::new(sink)),
			Self::Block => RgSinkOf::Block(BufWriter::new(sink)),
		}
	}
}

/// Output writer for either buffering mode.
///
/// Generic over the sink so the buffering behaviour can be tested against a
/// writer that records what reached it and when, rather than only against the
/// real stdout where the timing of a flush is not observable.
enum RgSinkOf<W: Write> {
	Block(BufWriter<W>),
	Line(LineWriter<W>),
}

/// The writer `run` actually uses.
type RgOutput = RgSinkOf<veyyon_uutils_ctx::CtxStdout>;

impl<W: Write> Write for RgSinkOf<W> {
	fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
		match self {
			Self::Block(output) => output.write(bytes),
			Self::Line(output) => output.write(bytes),
		}
	}

	fn flush(&mut self) -> io::Result<()> {
		match self {
			Self::Block(output) => output.flush(),
			Self::Line(output) => output.flush(),
		}
	}
}

struct SearchOptions {
	line_number:         bool,
	column:              bool,
	byte_offset:         bool,
	count:               bool,
	count_matches:       bool,
	files_with_matches:  bool,
	files_without_match: bool,
	only_matching:       bool,
	quiet:               bool,
	vimgrep:             bool,
	before:              usize,
	after:               usize,
	passthru:            bool,
	trim:                bool,
	max_columns:         Option<usize>,
	max_columns_preview: bool,
	null_paths:          bool,
	/// The byte every emitted record ends with: `\n`, or NUL under
	/// `--null-data`.
	///
	/// `--null-data` makes NUL the record separator on the way IN, and ripgrep
	/// uses it on the way out too, so a `--null-data` pipeline can be read back
	/// by `xargs -0`. Writing `\n` after a NUL-terminated record, which is what
	/// this printer used to do, puts a stray newline at the front of every
	/// record but the first once `xargs -0` splits it.
	record_terminator:   u8,
	no_messages:         bool,
	replacement:         Option<Vec<u8>>,
	json:                bool,
	/// `--stats`, which prints a summary block after the results.
	stats:               bool,
	/// `--heading`: the path goes on its own line above each file's lines
	/// instead of prefixing every one of them.
	heading:             bool,
	/// `--path-separator`: the byte every printed path uses in place of `/`.
	///
	/// Validated in `run`, so by the time a search reads it the value is known
	/// to be exactly one byte.
	path_separator:      Option<u8>,
	/// `--include-zero`: a count mode reports `0` for a file that matched
	/// nothing instead of saying nothing about it.
	include_zero:        bool,
	/// What goes between the fields of a MATCHING line, `:` unless
	/// `--field-match-separator` says otherwise.
	///
	/// This is a string and not a byte because ripgrep accepts any string here,
	/// escapes included: `--field-match-separator='\t'` prints a tab.
	match_separator:     Vec<u8>,
	/// What goes between the fields of a CONTEXT line, `-` unless
	/// `--field-context-separator` says otherwise.
	context_separator:   Vec<u8>,
	/// What stands between two non-contiguous groups of context lines, `--`
	/// unless `--context-separator` says otherwise.
	///
	/// `None` is `--no-context-separator`, which prints NOTHING between the
	/// groups. That is different from an EMPTY separator, which still prints its
	/// record terminator and so leaves a blank line: both were measured on
	/// ripgrep 15.1.0.
	group_separator:     Option<Vec<u8>>,
	/// The `--pre` program, resolved once, or `None` when no preprocessor was
	/// asked for. It lives with the other resolved options because it is one
	/// per run and compiling its globs can fail, which has to be reported
	/// before the first file.
	pre:                 Option<Preprocessor>,
}

impl SearchOptions {
	/// The modes that replace per-line output with a per-file summary.
	///
	/// Four places decide whether a line, a context line, a context break or a
	/// JSON stream may be printed, and each had this disjunction written out
	/// again with a slightly different tail. The tails are all deliberate, but
	/// four inline copies is how a fifth mode gets added to three of
	/// them: the shared core lives here and each caller states its own delta
	/// next to a reason.
	fn summary_mode(&self) -> bool {
		self.count || self.count_matches || self.files_with_matches || self.files_without_match
	}

	/// Whether the RUN may stop as soon as one file has matched.
	///
	/// `-q` wants nothing but the exit code, so one match settles it. `--stats`
	/// wants numbers about the whole search, and measured on ripgrep 15.1.0
	/// `--stats -q` over `aa bb aa\ncc\naa\n` reports `3 matches`, `2 matched
	/// lines` and `15 bytes searched`, which is every byte of the input.
	/// Stopping early made the block describe a search that did not happen:
	/// ours reported 2 matches and 9 bytes for the same input.
	fn stops_the_run_at_first_match(&self) -> bool {
		self.quiet && !self.reports_whole_search_numbers()
	}

	/// Whether this run has to report numbers about the WHOLE search.
	///
	/// One owner for the question both early-exit predicates ask, because both
	/// used to ask it as `!self.stats` and `--json` is the second way to ask for
	/// the same numbers. Measured on ripgrep 15.1.0: `rg --json -q hit a.txt`
	/// over a three-line file prints a summary record reading `matches: 2` and
	/// `bytes_searched: 28`, which is every byte of the input, so the search ran
	/// to the end even though `-q` wanted nothing but the exit code. Stopping
	/// early would have made the record describe a search that did not happen,
	/// which is the same defect the `--stats` half of this predicate was written
	/// for.
	fn reports_whole_search_numbers(&self) -> bool {
		self.stats || self.json
	}

	/// Whether a FILE may stop as soon as it has matched.
	///
	/// `-l` prints the path and nothing else, so it needs one match per file,
	/// and `-q` needs one in total. `--stats` again asks for the whole search:
	/// `--stats -l` reports the same three matches and fifteen bytes a plain
	/// run does.
	fn stops_a_file_at_first_match(&self) -> bool {
		(self.quiet || self.files_with_matches) && !self.reports_whole_search_numbers()
	}

	/// Whether context lines and the `--` between context blocks are printed.
	///
	/// A summary mode replaces per-line output entirely, so there is nothing for
	/// a context line to sit beside. `quiet` prints NOTHING, and it belongs here
	/// for a reason worth stating: before-context lines are emitted ahead of the
	/// match that selected them, so a `-q -C1` run that stopped at the first
	/// match had already written the line before it. That is a leak, not a
	/// rounding error, and the sibling `grep` builtin's own predicate has always
	/// included quiet.
	///
	/// `only_matching` and `vimgrep` are deliberately NOT here, though both once
	/// were. They change how a MATCHING line is written, not whether the lines
	/// around it are shown, and real ripgrep prints context lines in full under
	/// both: `rg -o -C1` prints the matched span for the match and the whole
	/// line for its neighbours, and `rg --vimgrep -C1` prints `path-line-text`
	/// context records beside its `path:line:col:text` match records. Verified
	/// against ripgrep 15.1.0 and pinned, with a non-vacuity twin each, by
	/// `only_matching_keeps_whole_context_lines` and
	/// `vimgrep_prints_context_lines_in_the_plain_form` below.
	fn prints_context_lines(&self) -> bool {
		!self.summary_mode() && !self.quiet
	}

	/// Whether this run ASKED for context lines around each match.
	///
	/// Not the same question as `prints_context_lines`, which is about whether
	/// this run's mode prints records at all. A run can print records and want
	/// no context: measured on ripgrep 15.1.0, `-C0` and `--passthru` each
	/// print their records with no separator between one file and the next,
	/// while `-A1` prints `--` there. That separator is the only thing this
	/// predicate decides; see `RgSink::search_separator`.
	fn requests_context(&self) -> bool {
		self.before > 0 || self.after > 0
	}

	/// Whether an input that matched, or did not, is one the run SELECTED.
	///
	/// For every mode but `--files-without-match` these are the same question,
	/// which is how they drifted apart: the per-file search returned "this file
	/// matched" and the exit status treated it as "this file produced output".
	/// `--files-without-match` LISTS the files that did NOT match, so a file
	/// that matched prints nothing and is not selected. Both GNU grep `-L` and
	/// ripgrep exit 1 when nothing is listed; this builtin exited 0, reporting
	/// success for a search whose entire output was empty, which a script reads
	/// as "found it".
	fn selected_input(&self, any_match: bool) -> bool {
		if self.files_without_match {
			!any_match
		} else {
			any_match
		}
	}
}

struct SearchOutcome {
	any_match: bool,
	had_error: bool,
}

/// A writer that remembers how many bytes went through it.
///
/// `--stats` reports `bytes printed`, and the text printer writes from a dozen
/// places. Counting at each of them would be a dozen chances to forget one, and
/// a forgotten one is a quietly wrong number rather than a failure, so the
/// count lives at the single point every byte already passes through.
struct CountingWriter<'a, W: Write> {
	inner:   &'a mut W,
	written: u64,
}

impl<W: Write> Write for CountingWriter<'_, W> {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		let n = self.inner.write(buf)?;
		// The count follows what was ACCEPTED, not what was offered, so a short
		// write does not inflate it.
		self.written += n as u64;
		Ok(n)
	}

	fn flush(&mut self) -> io::Result<()> {
		self.inner.flush()
	}
}

struct RgSink<'a, M: Matcher, W: Write> {
	out:             CountingWriter<'a, W>,
	matcher:         &'a M,
	display:         Option<&'a [u8]>,
	opts:            &'a SearchOptions,
	captures:        M::Captures,
	/// The bytes `-r` builds a replaced line in, reused so a replacement costs
	/// no allocation per line.
	scratch:         Vec<u8>,
	/// Where the matches on the line being printed are, reused for the same
	/// reason. One line's worth, gathered ONCE and then read by the count, the
	/// column, the records and the `--max-columns` wording.
	spans:           Vec<Span>,
	/// Where each `-r` replacement landed in `scratch`, which is what a column
	/// reports under `-r`.
	replaced_spans:  Vec<Span>,
	line_count:      u64,
	match_count:     u64,
	any_match:       bool,
	/// Bytes the searcher read, taken from `SinkFinish` so it is the searcher's
	/// own number rather than a second count of our own.
	bytes_searched:  u64,
	/// Whether another file already printed a group, so this one's heading needs
	/// a blank line above it. Comes from the run, not from this file.
	follows_a_group: bool,
	/// Set once this sink has printed its heading, which is also the answer to
	/// "did this file print anything" for the next file's separator.
	printed_group:   bool,
	/// Where the searcher found a byte that made this input binary, if it did.
	/// Reported once in `finish`, because ripgrep prints it after the file's
	/// records rather than in place of the one it stopped at.
	binary_offset:   Option<u64>,
	/// Whether the searcher this sink ran under STOPS on binary data rather than
	/// converting it, read from the searcher in `finish`.
	///
	/// The two detections mean different things to a summary mode, so the sink
	/// has to know which one it got; see `filtered_as_binary`.
	binary_quit:     bool,
}

impl<M: Matcher, W: Write> RgSink<'_, M, W> {
	/// Write the path, followed by the byte that separates it from what comes
	/// next.
	///
	/// `--null` REPLACES that byte with NUL rather than adding one after it,
	/// which is what makes the output splittable by `xargs -0`: ripgrep prints
	/// `path\0` where it would print `path:` as a prefix, and `path\0` where it
	/// would print `path\n` as a whole record. This printer used to append the
	/// NUL and then write the separator as well, so `-0 -n` emitted
	/// `path\0:1:hit` and `-0 -l` emitted `path\0\n`, neither of which
	/// a NUL-splitting consumer can read.
	fn write_path_with_separator(&mut self, separator: &[u8]) -> io::Result<()> {
		if let Some(name) = self.display {
			self.out.write_all(name)?;
			if self.opts.null_paths {
				self.out.write_all(b"\0")?;
			} else {
				self.out.write_all(separator)?;
			}
		}
		Ok(())
	}

	/// Whether this input reports NOTHING because binary data filtered it out.
	///
	/// `BinaryDetection::quit` is a FILTER, not a truncation: the searcher stops
	/// at the buffer holding the byte, so a count taken from what it did read
	/// would be smaller than the file's real count and a caller comparing two
	/// trees would read the difference as content. ripgrep resolves that by
	/// reporting nothing at all for such a file, and only in its summary
	/// printer.
	///
	/// Measured against ripgrep 15.1.0 over a tree holding `bin \0 hit`: `rg -c
	/// hit .` and `rg -l hit .` leave the file out, `rg -c --include-zero hit .`
	/// prints a `0` line for every text file that missed and STILL no line for
	/// this one, and `rg --files-without-match hit .` leaves it out too, so the
	/// file is absent from both halves of the count. The same file named as an
	/// operand is searched with `convert` instead and counts normally.
	///
	/// A record mode is deliberately NOT filtered: it has already printed the
	/// lines it reached, so it prints the notice after them and keeps its
	/// matched status, which is what ripgrep's standard printer does.
	fn filtered_as_binary(&self) -> bool {
		self.binary_quit && self.binary_offset.is_some() && self.opts.summary_mode()
	}

	/// End a record with the terminator this run is using.
	fn write_terminator(&mut self) -> io::Result<()> {
		self.out.write_all(&[self.opts.record_terminator])
	}

	/// Whether this run prints the path as a heading above each file's lines.
	///
	/// `--vimgrep` IGNORES `--heading`, verified against ripgrep 15.1.0: its
	/// whole contract is one parseable `path:line:col:text` record per match,
	/// and hoisting the path out of the record would break every editor reading
	/// it. The summary modes (`-c`, `-l`, `-L`) never reach here; they print
	/// their own records from `finish`, and real rg leaves those prefixed too.
	fn heading_mode(&self) -> bool {
		self.opts.heading && !self.opts.vimgrep
	}

	/// Print this file's heading, once, before its first line.
	///
	/// The heading is a RECORD, not a prefix, which is the one rule that
	/// explains every form ripgrep prints: it ends with the record terminator,
	/// and `--null` replaces that byte with NUL. So `--heading` gives `path\n`,
	/// `--heading --null` gives `path\0`, and `--heading --null-data` also
	/// gives `path\0` because NUL is the record terminator there. `-l` prints a
	/// path the same way and for the same reason, so both go through
	/// `write_path_with_separator`.
	///
	/// The separator this run prints between one file's output and the next's,
	/// if it prints one at all.
	///
	/// There is ONE mechanism here and three answers, which is how ripgrep does
	/// it too. Under `--heading` the separator is EMPTY, so all that reaches the
	/// output is the record terminator: the blank line between heading groups is
	/// this separator and not a rule of its own. When context lines were asked
	/// for, it is the context separator, so `rg -A1 hit .` prints `--` between
	/// two files exactly as it does between two gaps in one file, and
	/// `--no-context-separator` removes it from both places. Otherwise there is
	/// none.
	///
	/// Measured against ripgrep 15.1.0: `-A1` prints `--` between files, `-A1
	/// --context-separator=XX` prints `XX`, `-A1 --no-context-separator` prints
	/// nothing, `-A1 --heading --context-separator=XX` prints the blank line and
	/// ignores `XX`, and `-C0` and `--passthru` print nothing between files.
	/// This used to print nothing but the heading blank line, so every context
	/// run ran two files' output together with no mark where one ended.
	fn search_separator(&self) -> Option<&[u8]> {
		if self.heading_mode() {
			Some(&[])
		} else if self.opts.requests_context() {
			self.opts.group_separator.as_deref()
		} else {
			None
		}
	}

	/// Everything that belongs before this file's FIRST output, printed once.
	///
	/// Separates this file's output from the previous file's, which is why it
	/// needs to know about the rest of the run, and why it is emitted even when
	/// there is no path to print, under `--no-filename`: it separates the output
	/// of two searches rather than decorating a heading.
	fn begin_search(&mut self) -> io::Result<()> {
		if self.printed_group {
			return Ok(());
		}
		self.printed_group = true;
		if self.follows_a_group
			&& let Some(separator) = self.search_separator()
		{
			// Copied out because writing borrows `self` mutably while the separator is
			// borrowed from it. One record's worth of bytes, once per file.
			let separator = separator.to_vec();
			self.out.write_all(&separator)?;
			self.write_terminator()?;
		}
		Ok(())
	}

	/// The prelude plus this file's heading record, for the modes that print
	/// one.
	fn begin_group(&mut self) -> io::Result<()> {
		if self.printed_group {
			return Ok(());
		}
		self.begin_search()?;
		if self.heading_mode() && self.display.is_some() {
			self.write_path_with_separator(&[self.opts.record_terminator])?;
		}
		Ok(())
	}

	/// Report an input that turned out to hold binary data.
	///
	/// Byte for byte ripgrep 15.1.0, including the `\0` spelling and the word
	/// `around`, which is honest: the offset is where the searcher noticed the
	/// byte and not a promise about the byte's exact place.
	///
	/// It goes on STDOUT, like a record, because that is where ripgrep puts it.
	/// The sibling `grep` builtin puts ITS notice on stderr, and the two are
	/// right for their own reference tools: GNU grep moved the notice to stderr
	/// in 3.5 and ripgrep never did.
	///
	/// The path is written INLINE with `: `, even under `--heading`, where a
	/// record would get a heading record of its own instead. `--null` does not
	/// reach this separator either. Both were measured, and both are why this
	/// does not go through `write_path_with_separator`.
	fn write_binary_notice(&mut self, offset: u64) -> io::Result<()> {
		// The separator between files still belongs here, since this IS the file's
		// output, but the heading record does not: `rg --heading hit bin text` prints
		// the text file's group, a blank line, and then `bin: binary file matches`.
		// Measured on ripgrep 15.1.0, `rg -A1 --binary hit .` prints `--` after the
		// notice too, so the notice separates from the next file exactly as records
		// do; that is why this goes through the shared prelude.
		self.begin_search()?;
		if let Some(name) = self.display {
			self.out.write_all(name)?;
			self.out.write_all(b": ")?;
		}
		write!(self.out, "binary file matches (found \"\\0\" byte around offset {offset})")?;
		self.write_terminator()
	}

	fn write_prefix(
		&mut self,
		line_number: Option<u64>,
		column: Option<usize>,
		byte_offset: u64,
		separator: &[u8],
	) -> io::Result<()> {
		// Every record goes through the prelude, not only a heading one: the
		// separator between two files is printed there, and a run with context lines
		// prints one without printing headings.
		self.begin_group()?;
		if !self.heading_mode() && self.display.is_some() {
			self.write_path_with_separator(separator)?;
		}
		if self.opts.line_number
			&& let Some(number) = line_number
		{
			write!(self.out, "{number}")?;
			self.out.write_all(separator)?;
		}
		// `None` means this record HAS no column, not that nobody computed one, and the
		// field is omitted rather than defaulted. A context line is the case that
		// distinguishes them: it is printed because a match nearby selected it, so
		// there is no match on it to have a column, and ripgrep prints `1-one` for it
		// while still printing `2:3:xxhitxx` for the match. `unwrap_or(1)` here used
		// to turn every context line into `1-1-one`. Every caller that DOES have a
		// column passes it, including the match path, which now resolves its own
		// default.
		if self.opts.column
			&& let Some(column) = column
		{
			write!(self.out, "{column}")?;
			self.out.write_all(separator)?;
		}
		if self.opts.byte_offset {
			write!(self.out, "{byte_offset}")?;
			self.out.write_all(separator)?;
		}
		Ok(())
	}

	/// Write one body and the record terminator: `--trim` first, then
	/// `--max-columns`.
	///
	/// Every body goes through here, a whole line and a lone match alike.
	/// `--trim` applies to both: `rg -o --trim ' aa'` on `  aa` prints `aa`, so
	/// the flag trims what is printed rather than the line it came from.
	///
	/// The terminator is the subtle part. A LINE arrives from the searcher with
	/// its terminator attached, so this adds one only when the input's last
	/// line had none; a match under `-o`, a notice and a preview all carry none
	/// and always get one. Comparing against the RUN's terminator rather than
	/// `\n` is what made `--null-data` emit `hit\0\n`.
	fn write_body(&mut self, bytes: &[u8], kind: BodyKind<'_>) -> io::Result<()> {
		let bytes = if self.opts.trim {
			trim_ascii_start(bytes)
		} else {
			bytes
		};
		if self.exceeds_limit(bytes) {
			self.write_substitute(bytes, kind)?;
			return self.write_terminator();
		}
		self.out.write_all(bytes)?;
		if !bytes.ends_with(&[self.opts.record_terminator]) {
			self.write_terminator()?;
		}
		Ok(())
	}

	/// Whether `--max-columns` rejects this body.
	///
	/// The limit counts BYTES, and for a LINE it counts the terminator among
	/// them, which is ripgrep 15.1.0's rule and not an obvious one: a
	/// nineteen-character line survives `-M 20` and a twenty-character one does
	/// not, because the second is twenty-one bytes once its newline is counted.
	/// A match under `-o` carries no terminator, so `rg -o -M 2 aa` on `aa`
	/// prints the match while `rg -M 2 aa` on the same file prints a notice.
	/// That asymmetry is measured, and it falls out of the rule rather than
	/// being a second rule.
	fn exceeds_limit(&self, bytes: &[u8]) -> bool {
		self
			.opts
			.max_columns
			.is_some_and(|limit| limit > 0 && bytes.len() > limit)
	}

	/// What ripgrep prints instead of a body `--max-columns` rejected.
	///
	/// Four wordings, each measured against ripgrep 15.1.0 rather than guessed,
	/// and the choice turns on whether the run already knows where the matches
	/// are. See `knows_match_positions`.
	///
	/// The two forms do not agree on plurals, which looks like an oversight in
	/// ripgrep and is reproduced deliberately: the preview says `1 more match`
	/// and the notice says `with 1 matches`.
	fn write_substitute(&mut self, bytes: &[u8], kind: BodyKind<'_>) -> io::Result<()> {
		let content = self.strip_terminator(bytes);
		if !self.opts.max_columns_preview {
			return match kind {
				BodyKind::MatchingLine { spans } if self.knows_match_positions() => {
					let total = spans.len();
					write!(self.out, "[Omitted long line with {total} matches]")
				},
				BodyKind::MatchingLine { .. } | BodyKind::MatchText => {
					self.out.write_all(b"[Omitted long matching line]")
				},
				BodyKind::ContextLine => self.out.write_all(b"[Omitted long context line]"),
			};
		}
		// The limit is in bytes and the cut is in characters, so the prefix decides
		// where the tail starts and the count follows from it.
		let limit = self.opts.max_columns.unwrap_or(0);
		let prefix = preview_prefix(content, limit);
		let cut = prefix.len();
		self.out.write_all(prefix)?;
		let remaining = match kind {
			// A record under `-o` holds exactly one match and has just printed it, so
			// ripgrep has nothing left to count and says so even when the line holds
			// more: `rg -o -M 1 --max-columns-preview aa` on `aaaa` prints
			// `a [... 0 more matches]` twice, and the same under `--column` and `-r`.
			BodyKind::MatchText => Some(0),
			BodyKind::MatchingLine { spans } if self.knows_match_positions() => {
				// A match that STRADDLES the cut counts as reached: measured against
				// ripgrep 15.1.0, a line whose only match begins two characters before
				// the cut and ends after it previews as `[... 0 more matches]`.
				Some(spans.iter().filter(|span| span.start() >= cut).count())
			},
			BodyKind::MatchingLine { .. } | BodyKind::ContextLine => None,
		};
		match remaining {
			Some(1) => self.out.write_all(b" [... 1 more match]"),
			Some(count) => write!(self.out, " [... {count} more matches]"),
			None => self.out.write_all(PREVIEW_CUT_MARKER),
		}
	}

	/// Whether this run has already worked out where each match on a line
	/// begins.
	///
	/// ripgrep computes match positions only when a flag needs them, and its
	/// `--max-columns` wording changes when it has them: it counts the matches
	/// it is throwing away instead of saying only that a line was long.
	/// `--column` (which `--vimgrep` turns on) needs a position to print, and
	/// `-r` needs the spans to interpolate into. Both were measured to produce
	/// the counted wording, and a plain `rg -M 20 pattern` was measured not to.
	///
	/// Context lines are exempt whatever this says, because nothing matched on
	/// them, and so is `-o`, whose record is a single match already printed.
	fn knows_match_positions(&self) -> bool {
		self.opts.column || self.opts.replacement.is_some()
	}

	/// `bytes` without the run's record terminator, if it carries one.
	///
	/// The terminator has to come off before a preview so the marker does not
	/// land after a newline, and it is the RUN's terminator rather than `\n`
	/// because `--null-data` makes it a NUL.
	fn strip_terminator<'b>(&self, bytes: &'b [u8]) -> &'b [u8] {
		crate::strip_record_terminator(bytes, self.opts.record_terminator)
	}

	/// One matching line, from its match count to its records.
	///
	/// The line is scanned for matches ONCE, here, and the spans are then read
	/// by everything downstream: the match count, the column, the record loop
	/// and the `--max-columns` wording. Three separate walks used to do that
	/// work, and they disagreed with each other about empty matches. See
	/// `match_spans`.
	fn print_matched_line(
		&mut self,
		line: &[u8],
		line_number: Option<u64>,
		line_offset: u64,
	) -> io::Result<bool> {
		let mut spans = std::mem::take(&mut self.spans);
		let result = self.scan_and_print(line, &mut spans, line_number, line_offset);
		spans.clear();
		self.spans = spans;
		result
	}

	/// The body of `print_matched_line`, which owns the span buffer so the
	/// borrow checker allows the printing to keep reading it.
	fn scan_and_print(
		&mut self,
		line: &[u8],
		spans: &mut Vec<Span>,
		line_number: Option<u64>,
		line_offset: u64,
	) -> io::Result<bool> {
		// The terminator comes OFF before the line is scanned, which is ripgrep's rule
		// and a visible one: with it on, `rg -o 'x*'` over `ab` found a fourth empty
		// match at the newline and `--count-matches` reported 4 where ripgrep reports
		// 3. The spans stay valid offsets into the untrimmed line, since only the tail
		// was removed.
		match_spans(self.matcher, self.strip_terminator(line), spans)?;

		// Always the REAL number of matches on the line, never one per line.
		//
		// This used to add 1 unless `--count-matches` or `-o` was asking, even
		// though the true number was already in hand. Nothing read the field in the
		// other modes, so the lie was invisible; then `--stats` started reading it
		// and reported 2 matches for `aa bb aa` plus `aa`, where ripgrep reports 3.
		// `-c` is unaffected either way, because it prints `line_count`.
		//
		// `.max(1)` keeps a line the searcher selected counted as at least one
		// match, which is what an inverted or multi-line search produces: the
		// searcher matched, but a per-line scan finds nothing to point at.
		let found =
			u64::try_from(spans.len()).map_err(|error| io::Error::other(error.to_string()))?;
		self.match_count += found.max(1);

		// Neither mode prints a RECORD, so both leave here before the printer. What
		// they disagree about is whether to read the rest of the file: normally there
		// is nothing left to learn, but `--stats` counts every match, so it keeps
		// reading and still prints nothing.
		if self.opts.quiet || self.opts.files_with_matches {
			return Ok(!self.opts.stops_a_file_at_first_match());
		}
		if self.opts.files_without_match || self.opts.count || self.opts.count_matches {
			return Ok(true);
		}
		// Once the searcher has reported binary data, this file prints no more
		// RECORDS: the notice in `finish` replaces them. Measured against ripgrep
		// 15.1.0, which prints `1:hit early` for a match it had already reached and
		// then the notice, and prints the notice alone for a small file where the
		// byte was in the same buffer as every match. The line is still counted,
		// because `--stats` is describing the search and not the output.
		if self.binary_offset.is_some() {
			return Ok(true);
		}
		if self.opts.replacement.is_some() {
			// `-r` prints a line it built, and every position it reports is a position
			// in THAT line: measured against ripgrep 15.1.0, `rg --vimgrep -r XYZ aa`
			// on `aa bb aa` prints columns 1 and 8, the replacements' own offsets in
			// `XYZ bb XYZ`, and not the 1 and 7 the original line would give. `-b`
			// shifts with it. So the records are printed from the REPLACED spans.
			let mut body = std::mem::take(&mut self.scratch);
			let mut body_spans = std::mem::take(&mut self.replaced_spans);
			body.clear();
			body_spans.clear();
			let result = self
				.interpolate(line, spans, &mut body, &mut body_spans)
				.and_then(|()| self.print_records(&body, &body_spans, line_number, line_offset));
			body.clear();
			body_spans.clear();
			self.scratch = body;
			self.replaced_spans = body_spans;
			result?;
		} else {
			self.print_records(line, spans, line_number, line_offset)?;
		}
		Ok(true)
	}

	/// Apply `-r` to `line`, appending the result to `out` and recording where
	/// each replacement landed in it.
	///
	/// This exists instead of `Matcher::replace_with_captures` because the
	/// callback that method offers cannot say where in the output it wrote, and
	/// the output offsets are exactly what a column reports under `-r`. Writing
	/// the walk out also puts the whole-line and `-o` paths on ONE
	/// implementation, which is why `rg -o -r X` now reports the replacement's
	/// column rather than the original match's.
	fn interpolate(
		&mut self,
		line: &[u8],
		spans: &[Span],
		out: &mut Vec<u8>,
		out_spans: &mut Vec<Span>,
	) -> io::Result<()> {
		let Some(replacement) = self.opts.replacement.as_deref() else {
			out.extend_from_slice(line);
			out_spans.extend_from_slice(spans);
			return Ok(());
		};
		let mut copied = 0usize;
		for span in spans {
			out.extend_from_slice(&line[copied..span.start()]);
			let begin = out.len();
			// A span the matcher found can still fail to yield captures under PCRE2's
			// lookbehind, in which case ripgrep prints nothing for it. The span is
			// still recorded, so the record keeps its column and simply has no body.
			if self
				.matcher
				.captures_at(line, span.start(), &mut self.captures)
				.map_err(|error| io::Error::other(error.to_string()))?
			{
				self.captures.interpolate(
					|name| self.matcher.capture_index(name),
					line,
					replacement,
					out,
				);
			}
			out_spans.push(Span::new(begin, out.len()));
			copied = span.end();
		}
		out.extend_from_slice(&line[copied..]);
		Ok(())
	}

	/// The records one matching line prints.
	///
	/// `--vimgrep` and `-o` both print one record per match and differ only in
	/// the BODY: vimgrep repeats the whole line, `-o` prints the match alone.
	/// They compose, and `rg --vimgrep -o` prints `file:1:1:<match>`. This used
	/// to be two loops where `--vimgrep` won outright and printed the whole
	/// line under a flag whose entire promise is that it prints only what
	/// matched.
	///
	/// Every other mode prints one record for the line, whatever its match
	/// count.
	fn print_records(
		&mut self,
		body: &[u8],
		spans: &[Span],
		line_number: Option<u64>,
		line_offset: u64,
	) -> io::Result<()> {
		if self.record_spans_lines(body) {
			return self.print_multi_line_records(body, spans, line_number, line_offset);
		}
		if self.opts.only_matching || self.opts.vimgrep {
			for span in spans {
				let offset = line_offset.saturating_add(
					u64::try_from(span.start()).map_err(|error| io::Error::other(error.to_string()))?,
				);
				self.write_prefix(
					line_number,
					Some(span.start() + 1),
					offset,
					&self.opts.match_separator,
				)?;
				if self.opts.only_matching {
					self.write_body(&body[span.start()..span.end()], BodyKind::MatchText)?;
				} else {
					self.write_body(body, BodyKind::MatchingLine { spans })?;
				}
			}
			// A searcher can select a line that a per-line scan finds no match on: an
			// inverted search, or a pattern whose span crosses lines. `--vimgrep` still
			// owes one record and prints it at column 1. `-o` owes nothing, because it
			// has no match text to show.
			if spans.is_empty() && self.opts.vimgrep {
				self.write_prefix(line_number, Some(1), line_offset, &self.opts.match_separator)?;
				self.write_body(body, BodyKind::MatchingLine { spans })?;
			}
			return Ok(());
		}
		// A matching line reports the FIRST match's column when `--column` is on, and
		// falls back to 1 for the same no-findable-span case.
		let column = if self.opts.column {
			Some(spans.first().map_or(1, |span| span.start() + 1))
		} else {
			None
		};
		self.write_prefix(line_number, column, line_offset, &self.opts.match_separator)?;
		self.write_body(body, BodyKind::MatchingLine { spans })
	}

	/// Whether this record covers more than one line.
	///
	/// Only a `--multiline` search produces one: every other mode hands the sink
	/// one line at a time. The trailing terminator is not a second line, so it
	/// comes off before the question is asked.
	fn record_spans_lines(&self, body: &[u8]) -> bool {
		let terminator = self.opts.record_terminator;
		body
			.strip_suffix(&[terminator])
			.unwrap_or(body)
			.contains(&terminator)
	}

	/// The records a match that SPANS lines prints, one set per line it covers.
	///
	/// A multi-line match is still reported line by line, because the prefix is
	/// what makes a result addressable: `rg -U '(?s)hit.gamma' a.txt` prints
	/// `a.txt:3:hit hit` and `a.txt:4:gamma`, and every line carries the path so
	/// a reader piping the output can tell which file the second line came from.
	/// This printer used to write the record's bytes under ONE prefix, so the
	/// second and later lines of a multi-line match arrived bare: measured
	/// against ripgrep 15.1.0, `rg -U '(?s)hit.gamma' hit .` printed
	/// `./a.txt:hit hit` and then a bare `gamma`, which names no file at all.
	///
	/// Three rules were measured rather than guessed, and each is deliberate:
	///
	/// * The LINE NUMBER counts up from the match's first line, so line 4 of the
	///   file reports 4 even though the searcher reported the match at 3.
	/// * The BYTE OFFSET is each line's own, not the match's: `-b` prints 15 and
	///   23 for a match starting at 19.
	/// * The COLUMN is the first match's column in the WHOLE record, repeated:
	///   `--column` prints 5 on both lines here, so the second line reports a
	///   column its own text has no match at. That is ripgrep's behaviour and it
	///   is reproduced rather than corrected, because a column is only
	///   meaningful next to the line number that goes with it.
	fn print_multi_line_records(
		&mut self,
		body: &[u8],
		spans: &[Span],
		line_number: Option<u64>,
		line_offset: u64,
	) -> io::Result<()> {
		let terminator = self.opts.record_terminator;
		if self.opts.vimgrep {
			return self.print_multi_line_vimgrep_records(body, spans, line_number, line_offset);
		}
		// The record's own first column, held across every line; see the doc above.
		let column = if self.opts.column {
			Some(spans.first().map_or(1, |span| span.start() + 1))
		} else {
			None
		};
		// One allocation per multi-line record, reused for each of its lines. The
		// spans a body prints with have to be relative to THAT body, because the
		// `--max-columns` wording counts them and a preview asks which of them begin
		// past the cut.
		let mut on_this_line: Vec<Span> = Vec::new();
		let mut start = 0usize;
		for (index, line) in body.split_inclusive(|byte| *byte == terminator).enumerate() {
			let end = start + line.len();
			let content = line.strip_suffix(&[terminator]).unwrap_or(line).len();
			let index = u64::try_from(index).map_err(|error| io::Error::other(error.to_string()))?;
			let start_offset = line_offset.saturating_add(
				u64::try_from(start).map_err(|error| io::Error::other(error.to_string()))?,
			);
			if self.opts.only_matching {
				// `-o` prints each match's text, and a match that crosses a line boundary
				// prints the part of it that is on THIS line. Its prefix reports the
				// match's own offset and column, which are the same on both pieces:
				// measured on ripgrep 15.1.0, which reports the position of the match and
				// not of the piece.
				for span in spans
					.iter()
					.filter(|span| span.end() > start && span.start() < start + content)
				{
					let piece_start = span.start().max(start);
					let piece_end = span.end().min(start + content);
					let offset = line_offset.saturating_add(
						u64::try_from(span.start())
							.map_err(|error| io::Error::other(error.to_string()))?,
					);
					self.write_prefix(
						line_number.map(|number| number + index),
						Some(span.start() + 1),
						offset,
						&self.opts.match_separator,
					)?;
					self.write_body(&body[piece_start..piece_end], BodyKind::MatchText)?;
				}
			} else {
				on_this_line.clear();
				on_this_line.extend(
					spans
						.iter()
						.filter(|span| span.end() > start && span.start() < end)
						.map(|span| {
							Span::new(span.start().max(start) - start, span.end().min(end) - start)
						}),
				);
				self.write_prefix(
					line_number.map(|number| number + index),
					column,
					start_offset,
					&self.opts.match_separator,
				)?;
				self.write_body(line, BodyKind::MatchingLine { spans: &on_this_line })?;
			}
			start = end;
		}
		Ok(())
	}

	/// A multi-line match under `--vimgrep`: ONE record per match, on the line
	/// the match starts on.
	///
	/// Measured against ripgrep 15.1.0, whose printer says so in as many words:
	/// vimgrep wants one line per match even when the match spans several, so
	/// `rg --vimgrep -U '(?s)hit.gamma' a.txt` prints `a.txt:3:5:hit hit` and
	/// nothing for line 4. The column is the match's column ON THAT LINE, which
	/// is the one place a multi-line record reports a column relative to the
	/// line rather than to the record.
	fn print_multi_line_vimgrep_records(
		&mut self,
		body: &[u8],
		spans: &[Span],
		line_number: Option<u64>,
		line_offset: u64,
	) -> io::Result<()> {
		let terminator = self.opts.record_terminator;
		// The same no-findable-span case the single-line path answers: the searcher
		// selected the record, so vimgrep owes one record, and it prints the first
		// line at column 1.
		if spans.is_empty() {
			let first = first_line(body, terminator);
			self.write_prefix(line_number, Some(1), line_offset, &self.opts.match_separator)?;
			return self.write_body(&body[..first], BodyKind::MatchingLine { spans });
		}
		for span in spans {
			let (index, start, end) = line_holding(body, terminator, span.start());
			let offset = line_offset.saturating_add(
				u64::try_from(start).map_err(|error| io::Error::other(error.to_string()))?,
			);
			self.write_prefix(
				line_number.map(|number| number + index),
				Some(span.start() - start + 1),
				offset,
				&self.opts.match_separator,
			)?;
			self.write_body(&body[start..end], BodyKind::MatchingLine { spans })?;
		}
		Ok(())
	}
}

/// The length of `body` up to and including its first terminator.
fn first_line(body: &[u8], terminator: u8) -> usize {
	body
		.iter()
		.position(|byte| *byte == terminator)
		.map_or(body.len(), |at| at + 1)
}

/// The line of `body` that byte `position` sits on: its index from zero, where
/// it starts, and where it ends after its terminator.
///
/// A position past the last line answers with the last line, which is what a
/// zero-width match at the very end of a record needs.
fn line_holding(body: &[u8], terminator: u8, position: usize) -> (u64, usize, usize) {
	let mut start = 0usize;
	let mut last = (0u64, 0usize, body.len());
	for (index, line) in body.split_inclusive(|byte| *byte == terminator).enumerate() {
		let index = index as u64;
		let end = start + line.len();
		if position < end {
			return (index, start, end);
		}
		last = (index, start, end);
		start = end;
	}
	last
}

impl<M: Matcher, W: Write> Sink for RgSink<'_, M, W> {
	type Error = io::Error;

	fn matched(&mut self, _searcher: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, io::Error> {
		self.any_match = true;
		self.line_count += 1;
		self.print_matched_line(mat.bytes(), mat.line_number(), mat.absolute_byte_offset())
	}

	fn context(&mut self, _searcher: &Searcher, ctx: &SinkContext<'_>) -> Result<bool, io::Error> {
		if !self.opts.prints_context_lines() || self.binary_offset.is_some() {
			return Ok(true);
		}
		self.write_prefix(
			ctx.line_number(),
			None,
			ctx.absolute_byte_offset(),
			&self.opts.context_separator,
		)?;
		self.write_body(ctx.bytes(), BodyKind::ContextLine)?;
		Ok(true)
	}

	/// The searcher found a byte that makes this input binary.
	///
	/// Returning `true` keeps the search going, which is what `--binary` asks
	/// for: under the default detection the searcher stops on its own, and
	/// under `--binary` it converts the byte and reads to the end. Either way
	/// the offset is remembered and reported once, in `finish`.
	///
	/// This hook used to be absent, which made the default a SILENT TRUNCATION:
	/// a file with a NUL was searched up to that byte, everything after it was
	/// dropped, and the run said nothing about it. Recall loss with no notice is
	/// the one failure a search tool must never have.
	fn binary_data(&mut self, _searcher: &Searcher, offset: u64) -> Result<bool, io::Error> {
		self.binary_offset = Some(offset);
		Ok(true)
	}

	fn context_break(&mut self, _searcher: &Searcher) -> Result<bool, io::Error> {
		if self.binary_offset.is_some() {
			return Ok(true);
		}
		// Exactly the condition `context` uses: a `--` stands for the lines between two
		// context blocks, so it is printed by whatever prints those blocks.
		// `--passthru` used to be excluded here, on the theory that passthru leaves
		// no gap to separate. It does not need to be: a context request now turns
		// passthru off in `search_options`, as it does upstream, so the two never
		// reach this method together and there is no gap-free break to suppress.
		if self.opts.prints_context_lines() {
			// `--no-context-separator` prints NOTHING here, not an empty record: an
			// EMPTY separator still ends with the record terminator and so leaves a
			// blank line, and ripgrep 15.1.0 distinguishes the two.
			if let Some(separator) = self.opts.group_separator.as_deref() {
				self.out.write_all(separator)?;
				self.write_terminator()?;
			}
		}
		Ok(true)
	}

	fn finish(&mut self, searcher: &Searcher, finish: &SinkFinish) -> Result<(), io::Error> {
		// Recorded before the early return below, because `--quiet` still SEARCHES
		// the file; it only declines to print. A `--stats -q` run that reported
		// zero bytes searched would be describing a search that happened.
		self.bytes_searched = finish.byte_count();
		self.binary_quit = searcher.binary_detection().quit_byte().is_some();
		if self.opts.quiet {
			return Ok(());
		}
		// Nothing at all for a file the binary filter took, not even the `0` that
		// `--include-zero` asks for; see `filtered_as_binary`. The counts are left
		// standing because `--stats` describes the SEARCH, and ripgrep's own stats
		// are recorded before its printer squashes the count.
		if self.filtered_as_binary() {
			return Ok(());
		}
		// After the file's records and before the next file's group, which is where
		// ripgrep prints it. A summary mode prints no notice at all: measured on
		// ripgrep 15.1.0, `rg -c hit binfile` prints the count alone, because the
		// notice belongs to the printer that would otherwise have printed records.
		if let Some(offset) = self.binary_offset
			&& self.any_match
			&& !self.opts.summary_mode()
		{
			self.write_binary_notice(offset)?;
			return Ok(());
		}
		if self.opts.files_with_matches {
			if self.any_match {
				// The path IS the whole record here, so `--null` terminates it and no
				// separate terminator follows; that is why the separator is passed in.
				self.write_path_with_separator(&[self.opts.record_terminator])?;
			}
		} else if self.opts.files_without_match {
			if !self.any_match {
				self.write_path_with_separator(&[self.opts.record_terminator])?;
			}
		} else if (self.opts.count || self.opts.count_matches)
			&& (self.any_match || self.opts.include_zero)
		{
			// A file that matched nothing says nothing, because a count mode reports what
			// was found. `--include-zero` is the flag that asks for the `0` anyway, which
			// is what a caller comparing two trees file by file needs.
			self.write_path_with_separator(&self.opts.match_separator)?;
			let count = if self.opts.count_matches {
				self.match_count
			} else {
				self.line_count
			};
			write!(self.out, "{count}")?;
			self.write_terminator()?;
		}
		Ok(())
	}
}

/// Which body is being written, which is what decides how `--max-columns`
/// describes one it rejects.
///
/// ripgrep gives each of the three its own wording, and the distinctions are
/// worth carrying: a reader who greps their own output for
/// `Omitted long matching line` and finds it on a line that never matched has
/// been told something false about their own search.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum BodyKind<'a> {
	/// A whole line the pattern selected, with the spans the run reports columns
	/// from: the line's own matches, or under `-r` the replacements in the text
	/// being printed.
	///
	/// The spans are here because the counted wording counts them, and they are
	/// already in hand: `[Omitted long line with 2 matches]` is `spans.len()`,
	/// and a preview's `[... 1 more match]` is how many of them begin past the
	/// cut. A second scan of the line to answer that would also answer it
	/// differently under `-r`, whose printed text the pattern need not match at
	/// all.
	MatchingLine { spans: &'a [Span] },
	/// A line printed only because it sits near one that matched.
	ContextLine,
	/// One match's text alone, under `-o`.
	MatchText,
}

/// What follows a `--max-columns-preview` prefix when the run does not know
/// where the matches are, and so has nothing to count.
///
/// The LEADING SPACE belongs to the marker, verified against ripgrep 15.1.0: a
/// preview whose last kept character is itself a space prints two of them.
const PREVIEW_CUT_MARKER: &[u8] = b" [... omitted end of long line]";

/// The first `columns` CHARACTERS of `bytes`.
///
/// ripgrep counts the `--max-columns` limit in bytes and cuts the preview in
/// characters, which reads like an inconsistency until you see what the other
/// choice does. Measured against ripgrep 15.1.0: a line of thirty two-byte
/// characters under `-M 20 --max-columns-preview` previews twenty of them,
/// sixty bytes, and not the first twenty bytes, which would have split the
/// eleventh character down the middle and put a lone continuation byte on
/// stdout.
///
/// A byte that cannot begin a UTF-8 sequence counts as one character and
/// advances one byte, so a binary line previews rather than looping.
fn preview_prefix(bytes: &[u8], columns: usize) -> &[u8] {
	let mut at = 0usize;
	let mut seen = 0usize;
	while at < bytes.len() && seen < columns {
		at += utf8_sequence_len(bytes[at]).min(bytes.len() - at);
		seen += 1;
	}
	&bytes[..at]
}

/// How many bytes the UTF-8 sequence starting with `byte` occupies, or 1 for a
/// byte that starts none.
fn utf8_sequence_len(byte: u8) -> usize {
	match byte {
		0x00..=0x7f => 1,
		0xc0..=0xdf => 2,
		0xe0..=0xef => 3,
		0xf0..=0xf7 => 4,
		_ => 1,
	}
}

fn trim_ascii_start(bytes: &[u8]) -> &[u8] {
	let start = bytes
		.iter()
		.position(|b| !b.is_ascii_whitespace() || *b == b'\n' || *b == b'\r')
		.unwrap_or(bytes.len());
	&bytes[start..]
}

/// Where every match on `line` is, in the order ripgrep reports them.
///
/// ONE owner for what used to be three hand-written walks over a line: the
/// match count, the `-o` bodies and the `--vimgrep` records. They disagreed
/// about EMPTY matches, and the disagreement was visible: `rg -o 'x*'` on `ab`
/// prints three empty records and ours printed none, because two of the three
/// walks skipped an empty match and the third printed it. Under
/// `--count-matches` ripgrep reports 3 for that pattern and 2 for `b*`, so the
/// count came out wrong too.
///
/// It delegates to the matcher's own iteration rather than looping over
/// `find_at`, which is why the sequence now agrees with ripgrep by
/// construction: both ask the same trait, whose rule is that an empty match
/// adjacent to the previous match's end is not reported.
fn match_spans<M: Matcher>(matcher: &M, line: &[u8], out: &mut Vec<Span>) -> io::Result<()> {
	out.clear();
	matcher
		.find_iter(line, |span| {
			out.push(span);
			true
		})
		.map_err(|error| io::Error::other(error.to_string()))
}

/// What the CLI flags mean to a matcher, derived ONCE and read by both engines.
///
/// WHY THIS EXISTS. The two builders below take the same nine decisions and
/// used to derive every one of them separately from `cli`, in two different
/// spellings: `case_insensitive` against `caseless`, `dot_matches_new_line`
/// against `dotall`. That is nine chances for the pair to disagree, and
/// `--engine auto` makes the disagreement invisible: it tries the Rust engine
/// and silently falls back to PCRE2, so a flag honoured by one and dropped by
/// the other changes what a search RETURNS depending only on whether the
/// pattern happened to compile.
///
/// The struct is DESTRUCTURED WITHOUT `..` in both builders on purpose. Adding
/// a field here is then a compile error in each one, naming the field, so a
/// tenth decision cannot reach one engine and miss the other. That is the whole
/// point; do not "tidy" either destructure into `..`.
struct MatcherFlags {
	case_insensitive:     bool,
	case_smart:           bool,
	word:                 bool,
	whole_line:           bool,
	fixed_strings:        bool,
	dot_matches_new_line: bool,
	crlf:                 bool,
	unicode:              bool,
	/// The byte a line ends at, when the search is line oriented.
	///
	/// `None` under `--multiline`, where a match may span lines and pinning a
	/// terminator would stop it, and `None` under `--crlf`, whose terminator is
	/// two bytes and so cannot be named here at all: `crlf` above owns it. Only
	/// the Rust engine takes this; see the note in the PCRE2 builder for why
	/// that asymmetry is deliberate rather than an oversight.
	line_terminator:      Option<u8>,
}

impl MatcherFlags {
	fn from_cli(cli: &RgCli) -> Self {
		// The `--no-x` / `-i` / `-s` / `-S` families are resolved by CLAP, through
		// `overrides_with`, so the flag written LAST on the command line wins and
		// these are plain reads. See the note on `RgCli` for why that replaced a
		// fixed precedence here.
		Self {
			case_insensitive:     cli.ignore_case,
			case_smart:           cli.smart_case,
			word:                 cli.word_regexp,
			whole_line:           cli.line_regexp,
			fixed_strings:        cli.fixed_strings,
			dot_matches_new_line: cli.multiline && cli.multiline_dotall,
			// `--null-data` is not the negation of `--crlf`; it is a different
			// record separator, and it wins because a NUL-terminated record has no
			// line ending to strip.
			crlf:                 cli.crlf && !cli.null_data,
			unicode:              !cli.no_unicode,
			// `--crlf` yields None because `RegexMatcherBuilder::crlf(true)` SETS the
			// matcher's terminator to CRLF and a later `line_terminator` call
			// OVERWRITES it. Naming LF here left the matcher saying LF while the
			// searcher said CRLF, and grep-searcher refuses that pair, so `rg --crlf
			// hit .` printed `grep config error: mismatched line terminators` for
			// every file it opened and exited 2 having searched nothing.
			line_terminator:      if cli.null_data {
				Some(b'\0')
			} else if cli.multiline || cli.crlf {
				None
			} else {
				Some(b'\n')
			},
		}
	}
}

fn build_rust_matcher(
	patterns: &[String],
	flags: &MatcherFlags,
) -> Result<RegexMatcher, grep_regex::Error> {
	let MatcherFlags {
		case_insensitive,
		case_smart,
		word,
		whole_line,
		fixed_strings,
		dot_matches_new_line,
		crlf,
		unicode,
		line_terminator,
	} = *flags;
	let mut builder = RegexMatcherBuilder::new();
	builder
		.case_insensitive(case_insensitive)
		.case_smart(case_smart)
		.word(word)
		.whole_line(whole_line)
		.fixed_strings(fixed_strings)
		.multi_line(true)
		.dot_matches_new_line(dot_matches_new_line)
		.unicode(unicode)
		.crlf(crlf);
	if let Some(terminator) = line_terminator {
		builder.line_terminator(Some(terminator));
	}
	builder.build_many(patterns)
}

fn build_pcre_matcher(patterns: &[String], flags: &MatcherFlags) -> Result<PcreMatcher, String> {
	let MatcherFlags {
		case_insensitive,
		case_smart,
		word,
		whole_line,
		fixed_strings,
		dot_matches_new_line,
		crlf,
		unicode,
		// PCRE2 has no line-terminator setting to give it. Named rather than
		// swallowed by `..` so that adding a TENTH flag still fails to compile
		// here, which is the property this destructure exists for. Upstream
		// ripgrep has the same asymmetry: the Rust engine uses the terminator to
		// refuse a pattern that could match across a line, PCRE2 does not get the
		// hint and relies on `multi_line` plus `dotall` instead.
		line_terminator: _,
	} = *flags;
	let mut builder = PcreMatcherBuilder::new();
	builder
		.caseless(case_insensitive)
		.case_smart(case_smart)
		.word(word)
		.whole_line(whole_line)
		.fixed_strings(fixed_strings)
		.multi_line(true)
		.dotall(dot_matches_new_line)
		.crlf(crlf);
	pcre_matcher_defaults(&mut builder);
	// `--no-unicode` turns the UTF and UCP halves back off, which is the one
	// place a caller overrides the shared defaults rather than adding to them.
	if !unicode {
		builder.utf(false).ucp(false);
	}
	builder
		.build_many(patterns)
		.map_err(|error| error.to_string())
}

/// The rule that fences the default engine's error off from PCRE2's, 79 tildes
/// wide, which is the width ripgrep 15.1.0 writes.
///
/// The fence is there because the default engine's error is itself several
/// lines with its own indentation and carets, so without it a reader cannot
/// tell where one engine stops complaining and the other starts.
const ENGINE_ERROR_FENCE: &str =
	"~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~";

/// The report for a pattern NEITHER engine can compile, in ripgrep 15.1.0's
/// shape.
///
/// `--engine=auto` tries the default engine and promotes the pattern to PCRE2
/// when it is refused, so a failure there is really two failures, and a caller
/// needs both: the default engine's message is the one that names the
/// construct, and PCRE2's is the one that says whether the promotion was even
/// possible.
fn both_engines_refused(rust: &str, pcre: &str) -> String {
	format!(
		"regex could not be compiled with either the default regex engine or with PCRE2.\n\ndefault \
		 regex engine error:\n{ENGINE_ERROR_FENCE}\n{rust}\n{ENGINE_ERROR_FENCE}\n\nPCRE2 regex \
		 engine error:\n{pcre}"
	)
}

fn build_matcher(patterns: &[String], cli: &RgCli) -> Result<CompiledMatcher, String> {
	let engine = cli.engine.unwrap_or(if cli.pcre2 {
		RegexEngine::Pcre2
	} else {
		RegexEngine::Default
	});
	let flags = MatcherFlags::from_cli(cli);
	match engine {
		RegexEngine::Default => build_rust_matcher(patterns, &flags)
			.map(CompiledMatcher::Rust)
			.map_err(|error| error.to_string()),
		RegexEngine::Pcre2 => build_pcre_matcher(patterns, &flags).map(CompiledMatcher::Pcre),
		// The default engine's error is KEPT, because when PCRE2 refuses the pattern too
		// it is the only one that says what is wrong with it. Discarding it left a caller
		// who wrote `rg --engine=auto \'(\'` reading a PCRE2 message about a pattern they
		// had not asked PCRE2 to compile.
		RegexEngine::Auto => match build_rust_matcher(patterns, &flags) {
			Ok(matcher) => Ok(CompiledMatcher::Rust(matcher)),
			Err(rust) => build_pcre_matcher(patterns, &flags)
				.map(CompiledMatcher::Pcre)
				.map_err(|pcre| both_engines_refused(&rust.to_string(), &pcre)),
		},
	}
}

#[derive(Clone, Copy)]
enum BinaryMode {
	Automatic,
	Explicit,
}

fn binary_detection(cli: &RgCli, mode: BinaryMode) -> BinaryDetection {
	if cli.text || cli.null_data {
		return BinaryDetection::none();
	}
	// A summary mode gets the SAME detection as a record mode, because which one
	// applies is a property of how the file was reached and not of what the run
	// prints. This used to turn detection off for `-c`, `-l`, `--count-matches`
	// and `--files-without-match` on the theory that a count prints no raw bytes
	// and so cannot be harmed by them. The theory was measured on a file named as
	// an OPERAND, which is searched with `convert` and does count its matches, and
	// so it looked right while being wrong for every file reached by traversal:
	// `rg -c hit .` over a tree holding `bin \0 hit` counted that file where
	// ripgrep leaves it out, and `-l` named it. What a summary mode does
	// differently is decline to REPORT a file the quit detection fired on; that
	// lives in `RgSink::filtered_as_binary`, next to the reporting it changes.
	if cli.binary || cli.unrestricted >= 3 || matches!(mode, BinaryMode::Explicit) {
		BinaryDetection::convert(b'\0')
	} else {
		BinaryDetection::quit(b'\0')
	}
}

fn build_searcher(cli: &RgCli, opts: &SearchOptions, mode: BinaryMode) -> Result<Searcher, String> {
	let (encoding, bom_sniffing) = match cli.encoding.as_deref() {
		None | Some("auto") => (None, true),
		Some("none") => (None, false),
		// The `rg: ` prefix is the CALLER's, added once where the message is printed. It
		// used to be added here as well, so a bad `--encoding` value reported
		// `rg: rg: grep config error: unknown encoding: utf-9`.
		Some(label) => (Some(Encoding::new(label).map_err(|error| error.to_string())?), true),
	};
	// `rg -z` makes NUL the record separator; `--crlf` makes a line end at
	// `\r\n` so a Windows checkout does not leave a stray `\r` on every match.
	// They cannot both apply, and NUL wins because it is the stronger claim about
	// what a record is.
	let line_terminator = if cli.null_data {
		Some(LineTerminator::byte(b'\0'))
	} else if cli.crlf {
		Some(LineTerminator::crlf())
	} else {
		None
	};
	Ok(kernel_build_searcher(SearcherSpec {
		// Columns, vimgrep output and JSON all report a line number whether or
		// not `-n` was passed, so the searcher has to compute one for them.
		line_number: opts.line_number || opts.column || opts.vimgrep || opts.json,
		before_context: opts.before,
		after_context: opts.after,
		passthru: opts.passthru,
		invert_match: cli.invert_match,
		multi_line: cli.multiline,
		binary_detection: binary_detection(cli, mode),
		max_matches: cli.max_count,
		line_terminator,
		encoding,
		bom_sniffing,
	}))
}

fn read_pattern_file(path: &OsStr) -> Result<Vec<String>, String> {
	let mut text = String::new();
	if path == OsStr::new("-") {
		veyyon_uutils_ctx::stdin()
			.read_to_string(&mut text)
			.map_err(|err| format!("-: {err}"))?;
	} else {
		let resolved = veyyon_uutils_ctx::resolve(path);
		File::open(&resolved)
			.and_then(|mut file| file.read_to_string(&mut text))
			.map_err(|err| format!("{}: {err}", path.to_string_lossy()))?;
	}
	Ok(text
		.lines()
		.map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
		.collect())
}

fn resolve_patterns(cli: &RgCli) -> Result<(Vec<String>, Vec<OsString>), String> {
	let mut patterns = cli.patterns.clone();
	for pattern_file in &cli.pattern_files {
		patterns.extend(read_pattern_file(pattern_file.as_os_str())?);
	}
	let mut paths = Vec::new();
	if cli.files || cli.type_list || !cli.patterns.is_empty() || !cli.pattern_files.is_empty() {
		paths = cli.args.clone();
	} else {
		let mut rest = cli.args.iter();
		let Some(pattern) = rest.next() else {
			// ripgrep's own sentence, measured: it says this for every mode, including
			// `-c` and `--json`, and never mentions which operand was missing.
			return Err("ripgrep requires at least one pattern to execute a search".to_string());
		};
		patterns.push(pattern.to_string_lossy().into_owned());
		paths.extend(rest.cloned());
	}
	Ok((patterns, paths))
}

/// Whether the caller asked for context at all, as opposed to taking the
/// default of none.
///
/// PRESENCE, not size. `rg --passthru -C0` turns passthru off upstream even
/// though it asks for zero lines of context, because the user named a context
/// mode and that is the mode that wins. Reading `before`/`after` after they
/// collapse to `0` cannot tell the two apart, so the question is asked of the
/// three `Option`s while they still remember whether they were given.
fn context_requested(cli: &RgCli) -> bool {
	cli.context.is_some() || cli.before_context.is_some() || cli.after_context.is_some()
}

fn search_options(cli: &RgCli) -> SearchOptions {
	let context = cli.context.unwrap_or(0);
	let count_matches = cli.count_matches || (cli.count && cli.only_matching);
	// `--column`, `--vimgrep` and `-p` imply line numbers, and `-N` no longer
	// cancels them here: clap has already dropped whichever of `-n`/`-N` came
	// first.
	let line_number = cli.line_number || cli.column || cli.vimgrep || cli.pretty;
	SearchOptions {
		line_number,
		column: cli.column || cli.vimgrep,
		byte_offset: cli.byte_offset,
		count: cli.count && !count_matches,
		count_matches,
		// No `&& !files_without_match` guard: the two are members of
		// `OUTPUT_MODE_FLAGS`, so clap has already dropped whichever came first.
		files_with_matches: cli.files_with_matches,
		files_without_match: cli.files_without_match,
		only_matching: cli.only_matching,
		quiet: cli.quiet,
		vimgrep: cli.vimgrep,
		before: cli.before_context.unwrap_or(context),
		after: cli.after_context.unwrap_or(context),
		// A context request beats `--passthru`, which is what ripgrep does: the two are
		// competing answers to "which lines do you want", and the narrower one wins.
		passthru: cli.passthru && !context_requested(cli),
		trim: cli.trim,
		max_columns: cli.max_columns,
		max_columns_preview: cli.max_columns_preview,
		null_paths: cli.null,
		record_terminator: if cli.null_data { b'\0' } else { b'\n' },
		no_messages: no_messages_for(cli),
		stats: cli.stats,
		heading: cli.heading || cli.pretty,
		replacement: cli
			.replacement
			.as_ref()
			.map(|replacement| replacement.as_encoded_bytes().to_vec()),
		json: cli.json,
		include_zero: cli.include_zero,
		// Validated in `run`, so this cannot fail here.
		path_separator: resolve_path_separator(cli).unwrap_or(None),
		match_separator: cli
			.field_match_separator
			.as_deref()
			.map_or_else(|| b":".to_vec(), unescape_separator),
		context_separator: cli
			.field_context_separator
			.as_deref()
			.map_or_else(|| b"-".to_vec(), unescape_separator),
		group_separator: if cli.no_context_separator {
			None
		} else {
			Some(
				cli.context_separator
					.as_deref()
					.map_or_else(|| b"--".to_vec(), unescape_separator),
			)
		},
		// Resolved by `run`, which is where a bad `--pre-glob` is reported before
		// anything is searched.
		pre: None,
	}
}

/// Whether diagnostics are silenced, which is the ONE place the two flags meet.
///
/// `--messages` is the documented way to undo an earlier `--no-messages`, so
/// the later flag wins and the rule is a conjunction rather than a single
/// field. `list_files` needs the same answer as the search path but has no
/// `SearchOptions`, and deriving it a second time inline is how `--files`
/// came to ignore the flag entirely.
fn no_messages_for(cli: &RgCli) -> bool {
	cli.no_messages
}

/// Parses a NUM flag value that names a size.
///
/// A size is digits with an optional `K`, `M` or `G` suffix and nothing else,
/// so `1K` is a kilobyte and `1k` is a mistake: ripgrep's suffixes are
/// uppercase, and quietly accepting a lowercase one would hide a typo in a
/// filter that decides which files are searched at all. The two refusals are
/// worded exactly as ripgrep words them, because a size is refused while the
/// command line is still being parsed and the wording is part of that contract.
fn parse_size(input: &str) -> Result<u64, String> {
	let malformed = || {
		format!(
			"invalid size: invalid format for size '{input}', which should be a non-empty sequence \
			 of digits followed by an optional 'K', 'M' or 'G' suffix"
		)
	};
	let (digits, multiplier) = match input.as_bytes().last() {
		Some(b'K') => (&input[..input.len() - 1], 1024),
		Some(b'M') => (&input[..input.len() - 1], 1024 * 1024),
		Some(b'G') => (&input[..input.len() - 1], 1024 * 1024 * 1024),
		_ => (input, 1),
	};
	if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
		return Err(malformed());
	}
	let value = digits
		.parse::<u64>()
		.map_err(|err| format!("invalid size: invalid integer found in size '{input}': {err}"))?;
	Ok(value.saturating_mul(multiplier))
}

/// Parses a NUM flag value that names a count.
///
/// Every numeric flag parses its value here, so the one wording ripgrep prints
/// for a value that is not a number has one home. The value is parsed while the
/// command line is parsed, which is what makes `rg -m abc` exit 2 before it
/// opens a file.
fn parse_flag_number<T>(input: &str) -> Result<T, String>
where
	T: std::str::FromStr<Err = std::num::ParseIntError>,
{
	input
		.parse::<T>()
		.map_err(|err| format!("value is not a valid number: {err}"))
}

/// The words ripgrep uses when a flag value is not one of its choices.
///
/// Two flags reach this phrase from different directions. `--color` is checked
/// while the command line is parsed, and `--sort` is checked once the whole
/// command line is known, because its direction lives in a second flag. One
/// home for the phrase keeps the two from drifting apart.
fn unrecognized_choice(value: &str) -> String {
	format!("choice '{value}' is unrecognized")
}

/// Reads the `--engine` value.
///
/// ripgrep names the engine in its refusal rather than listing the choices, so
/// this replaces the derived value-enum parser, whose message would list them.
fn parse_regex_engine(input: &str) -> Result<RegexEngine, String> {
	match input {
		"default" => Ok(RegexEngine::Default),
		"pcre2" => Ok(RegexEngine::Pcre2),
		"auto" => Ok(RegexEngine::Auto),
		other => Err(format!("unrecognized regex engine '{other}'")),
	}
}

/// Reads the `--color` value.
///
/// This builtin never emits color, and it still refuses a value ripgrep would
/// refuse: a caller who writes `--color=alwyas` has made a mistake in the
/// command line, and accepting it would report success for a command ripgrep
/// rejects.
fn parse_color_choice(input: &str) -> Result<String, String> {
	match input {
		"never" | "auto" | "always" | "ansi" => Ok(input.to_string()),
		other => Err(unrecognized_choice(other)),
	}
}

/// What `--generate` can write.
///
/// ripgrep's five kinds, spelled the way it spells them. The names are the
/// kebab-case forms clap derives, so `complete-bash` is the value on the
/// command line and no second spelling table is needed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum GenerateKind {
	/// A roff man page.
	Man,
	/// A bash completion script.
	CompleteBash,
	/// A zsh completion script.
	CompleteZsh,
	/// A fish completion script.
	CompleteFish,
	/// A PowerShell completion script.
	CompletePowershell,
}

/// Read a `--generate` kind, refusing anything else in ripgrep's words.
///
/// Hand-written rather than left to clap's `ValueEnum` parser for the same
/// reason `parse_color_choice` is: `unrecognized_choice` is the one owner of
/// the phrase ripgrep uses for a rejected choice, and clap's own message lists
/// the alternatives where ripgrep does not.
fn parse_generate_kind(input: &str) -> Result<GenerateKind, String> {
	match input {
		"man" => Ok(GenerateKind::Man),
		"complete-bash" => Ok(GenerateKind::CompleteBash),
		"complete-zsh" => Ok(GenerateKind::CompleteZsh),
		"complete-fish" => Ok(GenerateKind::CompleteFish),
		"complete-powershell" => Ok(GenerateKind::CompletePowershell),
		other => Err(unrecognized_choice(other)),
	}
}

/// Write the artifact `--generate` asked for.
///
/// Generated from `uu_app()`, the SAME clap command the parser uses, which is
/// the whole point: a completion script listing a flag this builtin refuses, or
/// omitting one it accepts, is a lie the shell repeats at every tab press. That
/// also makes the artifacts a DELIBERATE divergence from ripgrep's own, which
/// describe ripgrep's larger flag table; reproducing those bytes would mean
/// shipping completions for flags that are not here.
fn write_generated<W: Write>(kind: GenerateKind, out: &mut W) -> io::Result<()> {
	let mut command = uu_app();
	if kind == GenerateKind::Man {
		return clap_mangen::Man::new(command).render(out);
	}
	let shell = match kind {
		GenerateKind::CompleteBash => clap_complete::Shell::Bash,
		GenerateKind::CompleteZsh => clap_complete::Shell::Zsh,
		GenerateKind::CompleteFish => clap_complete::Shell::Fish,
		GenerateKind::CompletePowershell => clap_complete::Shell::PowerShell,
		GenerateKind::Man => unreachable!("the man kind returned above"),
	};
	clap_complete::generate(shell, &mut command, "rg", out);
	Ok(())
}

/// Applies `--type-clear` and `--type-add` to a builder.
///
/// This is the one place a `--type-add` definition is parsed, so it is the one
/// place a malformed definition is refused. `type_builder` reaches it with the
/// default definitions already loaded, and the validation-only path in
/// `build_path_filters` reaches it without them.
fn add_type_definitions(builder: &mut TypesBuilder, cli: &RgCli) -> Result<(), String> {
	for name in &cli.type_clears {
		builder.clear(name);
	}
	for def in &cli.type_adds {
		// ripgrep names neither the flag nor the value here, and the message it does
		// print already says what a well formed definition looks like.
		builder.add_def(def).map_err(|err| err.to_string())?;
	}
	Ok(())
}

fn type_builder(cli: &RgCli) -> Result<TypesBuilder, String> {
	let mut builder = TypesBuilder::new();
	builder.add_defaults();
	add_type_definitions(&mut builder, cli)?;
	for name in &cli.types {
		builder.select(name);
	}
	for name in &cli.type_nots {
		builder.negate(name);
	}
	Ok(builder)
}

fn print_type_list<W: Write>(cli: &RgCli, out: &mut W) -> Result<(), String> {
	let builder = type_builder(cli)?;
	for def in builder.definitions() {
		write!(out, "{}: ", def.name()).map_err(|err| err.to_string())?;
		for (idx, glob) in def.globs().iter().enumerate() {
			if idx > 0 {
				out.write_all(b", ").map_err(|err| err.to_string())?;
			}
			out.write_all(glob.as_bytes())
				.map_err(|err| err.to_string())?;
		}
		out.write_all(b"\n").map_err(|err| err.to_string())?;
	}
	Ok(())
}

struct RgWalk {
	request: veyyon_walker::WalkRequest,
	filters: PathFilters,
}

struct PathFilters {
	overrides:    Option<veyyon_walker::WalkOverrides>,
	explicit:     Option<Gitignore>,
	types:        Option<Types>,
	max_filesize: Option<u64>,
}

impl PathFilters {
	fn includes(&self, path: &Path, file_type: veyyon_walker::FileType, size: Option<f64>) -> bool {
		use veyyon_walker::WalkOverrideVerdict as Verdict;

		let is_dir = file_type == veyyon_walker::FileType::Dir;
		// The same matcher the walk itself consults, so a whitelisted file cannot be
		// admitted by one of the two and dropped by the other.
		let override_verdict = self
			.overrides
			.as_ref()
			.map_or(Verdict::Undecided, |overrides| overrides.verdict(path, is_dir));
		if override_verdict == Verdict::Exclude {
			return false;
		}
		let explicitly_included = override_verdict == Verdict::Include;
		if !explicitly_included
			&& self
				.explicit
				.as_ref()
				.is_some_and(|ignore| matches!(ignore.matched(path, is_dir), Match::Ignore(_)))
		{
			return false;
		}
		if file_type != veyyon_walker::FileType::File {
			return true;
		}
		if !explicitly_included
			&& self
				.types
				.as_ref()
				.is_some_and(|types| matches!(types.matched(path, false), Match::Ignore(_)))
		{
			return false;
		}
		if let Some(limit) = self.max_filesize {
			let size = size.or_else(|| std::fs::metadata(path).ok().map(|meta| meta.len() as f64));
			if size.is_some_and(|size| size > limit as f64) {
				return false;
			}
		}
		true
	}
}

fn build_path_filters(cli: &RgCli) -> Result<PathFilters, String> {
	let cwd = veyyon_uutils_ctx::cwd();
	// `--max-filesize` was parsed with the command line, so a malformed size was
	// refused before any file was opened.
	let max_filesize = cli.max_filesize;
	// `--glob` is case-sensitive unless `--glob-case-insensitive` says otherwise,
	// and `--iglob` never is, so the case rule travels with each pattern. The
	// walker compiles them, because it is the walk that has to honour them: a glob
	// outranks the hidden rule and the ignore files, and only the traversal can
	// decide not to prune a directory.
	let overrides = if cli.globs.is_empty() && cli.iglobs.is_empty() {
		None
	} else {
		let patterns = cli
			.globs
			.iter()
			.map(|glob| veyyon_walker::WalkOverridePattern {
				glob:             glob.clone(),
				case_insensitive: cli.glob_case_insensitive,
			})
			.chain(
				cli.iglobs
					.iter()
					.map(|glob| veyyon_walker::WalkOverridePattern::case_insensitive(glob.clone())),
			);
		Some(veyyon_walker::WalkOverrides::new(&cwd, patterns).map_err(|error| {
			if error.glob.is_empty() {
				error.message.clone()
			} else {
				let flag = if cli.iglobs.contains(&error.glob) {
					"--iglob"
				} else {
					"--glob"
				};
				format!("{flag} {:?}: {}", error.glob, error.message)
			}
		})?)
	};
	let explicit = if cli.ignore_files.is_empty() {
		None
	} else {
		let mut builder = GitignoreBuilder::new(&cwd);
		for path in &cli.ignore_files {
			let resolved = veyyon_uutils_ctx::resolve(path);
			if let Some(error) = builder.add(&resolved) {
				return Err(format!("{}: {error}", path.to_string_lossy()));
			}
		}
		Some(builder.build().map_err(|error| error.to_string())?)
	};
	let types = if cli.types.is_empty() && cli.type_nots.is_empty() {
		// Nothing selects a type, so nothing filters by one and the default
		// definitions are not worth loading. A malformed `--type-add` is still a
		// mistake in the command line, and ripgrep refuses it whether or not this run
		// would have read it, so the definitions are parsed for their errors alone.
		add_type_definitions(&mut TypesBuilder::new(), cli)?;
		None
	} else {
		Some(
			type_builder(cli)?
				.build()
				.map_err(|error| error.to_string())?,
		)
	};
	Ok(PathFilters { overrides, explicit, types, max_filesize })
}

fn build_walk(cli: &RgCli, root: &Path) -> Result<RgWalk, String> {
	let filters = build_path_filters(cli)?;
	let unrestricted_no_ignore = cli.unrestricted >= 1;
	let include_hidden = cli.hidden || cli.unrestricted >= 2;
	let no_ignore = cli.no_ignore || unrestricted_no_ignore;
	// A sorted search collects its files and orders them itself, so asking the walk
	// for path order on top of that would pay for the ordering twice.
	let order = veyyon_walker::WalkOrder::Unordered;
	let request = veyyon_walker::WalkRequest::new(root)
		.hidden(include_hidden)
		.gitignore(!no_ignore)
		// Each `--no-ignore-*` flag turns off ONE source. `--no-ignore-dot` drops
		// `.ignore` and keeps `.gitignore`; `--no-ignore-vcs` does the reverse and
		// takes the repository's exclude file with it, since both are git's;
		// `--no-ignore-exclude` drops only that exclude file; `--no-ignore-global`
		// drops the user's global gitignore; `--no-ignore-parent` stops reading ignore
		// files in directories above the root. All five were parsed and none reached
		// the walk, which had a single switch over all of them.
		.dot_ignore(!cli.no_ignore_dot)
		.vcs_ignore(!cli.no_ignore_vcs)
		.exclude_ignore(!cli.no_ignore_exclude && !cli.no_ignore_vcs)
		.global_ignore(!cli.no_ignore_global)
		.parent_ignore(!cli.no_ignore_parent)
		// `.gitignore` describes what git tracks, so ripgrep reads it only inside a
		// repository: `rg hit .` in a directory with a `.gitignore` and no `.git`
		// searches the "ignored" files. `--no-require-git` asks for them anyway.
		// `.ignore` is not a git file and applies either way.
		.require_git(!cli.no_require_git)
		// ripgrep has no rule about `.git` at all: the directory is skipped only
		// because it is hidden, so `rg --hidden hit .` searches `.git/config` and
		// `rg -uu` does too. Pruning it by name here removed those files from a
		// search that asked for them, and tying the pruning to `--no-ignore` made
		// the omission depend on an unrelated flag.
		.skip_git(false)
		.skip_node_modules(false)
		.follow_links(veyyon_walker::FollowLinks::from(cli.follow))
		.detail(if filters.max_filesize.is_some() {
			veyyon_walker::WalkDetail::Full
		} else {
			veyyon_walker::WalkDetail::Minimal
		})
		.order(order)
		.emit_root(false)
		.depth(1, cli.max_depth.unwrap_or(usize::MAX))
		.visit_order(veyyon_walker::VisitOrder::PreOrder)
		.directory_errors(veyyon_walker::DirectoryErrorMode::Visit)
		.same_file_system(cli.one_file_system)
		.cache(false);
	let request = match filters.overrides.clone() {
		Some(overrides) => request.overrides(overrides),
		None => request,
	};
	Ok(RgWalk { request, filters })
}

/// The path a walked file prints under, given the operand the caller named.
///
/// ripgrep echoes an operand VERBATIM in front of every path from it and
/// normalises nothing: `rg hit .` prints `./a.rs`, `rg hit .//.` prints
/// `.//./a.rs`, and `rg hit sub` prints `sub/deep/d.rs`. `prefix` is `None` for
/// the implicit root, the working directory ripgrep picks when the caller named
/// no path at all, and that form prints the relative path bare.
/// Reads a separator value, turning the escapes ripgrep accepts into bytes.
///
/// ripgrep takes `--field-match-separator='\t'` as a TAB, not as a backslash
/// and a `t`, and the same for the other three separator flags, so a caller can
/// put a control byte between fields from a shell that will not pass one
/// literally. `\xHH` covers everything the named escapes do not, and an unknown
/// escape keeps both of its characters rather than being dropped, because
/// dropping it would silently change the separator the caller asked for.
fn unescape_separator(value: &str) -> Vec<u8> {
	let mut out = Vec::with_capacity(value.len());
	let mut chars = value.chars();
	while let Some(ch) = chars.next() {
		if ch != '\\' {
			let mut buffer = [0_u8; 4];
			out.extend_from_slice(ch.encode_utf8(&mut buffer).as_bytes());
			continue;
		}
		match chars.next() {
			Some('n') => out.push(b'\n'),
			Some('r') => out.push(b'\r'),
			Some('t') => out.push(b'\t'),
			Some('0') => out.push(0),
			Some('\\') => out.push(b'\\'),
			Some('x') => {
				let digits = chars.clone().take(2).collect::<String>();
				match u8::from_str_radix(&digits, 16) {
					Ok(byte) if digits.len() == 2 => {
						out.push(byte);
						chars.next();
						chars.next();
					},
					// Not two hex digits, so this was never an escape: keep what was
					// written rather than inventing a byte for it.
					_ => out.extend_from_slice(b"\\x"),
				}
			},
			Some(other) => {
				out.push(b'\\');
				let mut buffer = [0_u8; 4];
				out.extend_from_slice(other.encode_utf8(&mut buffer).as_bytes());
			},
			// A trailing backslash is itself.
			None => out.push(b'\\'),
		}
	}
	out
}

/// What `--sort`/`--sortr` order the files by.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SortKey {
	/// By path, compared component by component, which is what puts `sub/a.txt`
	/// before `sub.txt`: the first components are `sub` and `sub.txt`. Measured
	/// against ripgrep 15.1.0, and it is exactly Rust's `Path` ordering.
	Path,
	/// By last-modified time, oldest first.
	Modified,
	/// By last-accessed time, oldest first.
	Accessed,
	/// By creation time, oldest first, where the platform records one.
	Created,
}

/// A sort request: a key and a direction.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SortSpec {
	key:     SortKey,
	reverse: bool,
}

/// Reads one `--sort`/`--sortr` value.
///
/// `none` is a real value meaning "do not sort", so this returns `Ok(None)` for
/// it rather than treating it as an error. Anything else unrecognised exits 2
/// with ripgrep's wording, because a sort key the tool ignores would silently
/// answer a different question than the one asked.
fn parse_sort_key(value: &str, flag: &str) -> Result<Option<SortKey>, String> {
	match value {
		"none" => Ok(None),
		"path" => Ok(Some(SortKey::Path)),
		"modified" => Ok(Some(SortKey::Modified)),
		"accessed" => Ok(Some(SortKey::Accessed)),
		"created" => Ok(Some(SortKey::Created)),
		other => Err(format!("error parsing flag {flag}: {}", unrecognized_choice(other))),
	}
}

/// The one place that decides whether, and how, a search sorts its files.
///
/// `--sort` and `--sortr` override each other through clap, so at most one is
/// set and the one written last on the command line wins, which is what ripgrep
/// does. `--sort-files` is the deprecated spelling of `--sort path`.
fn resolve_sort(cli: &RgCli) -> Result<Option<SortSpec>, String> {
	if let Some(value) = &cli.sortr {
		return Ok(parse_sort_key(value, "--sortr")?.map(|key| SortSpec { key, reverse: true }));
	}
	if let Some(value) = &cli.sort {
		return Ok(parse_sort_key(value, "--sort")?.map(|key| SortSpec { key, reverse: false }));
	}
	if cli.sort_files {
		return Ok(Some(SortSpec { key: SortKey::Path, reverse: false }));
	}
	Ok(None)
}

/// Orders collected files in place.
///
/// The time keys stat each file ONCE and sort the recorded times, rather than
/// stat-ing inside the comparator, which would call it O(n log n) times. A file
/// whose time cannot be read sorts after the ones that can, and every
/// comparison falls back to the path, so the order is total and two runs over
/// one tree print the same thing.
fn sort_paths(files: &mut Vec<PathBuf>, spec: SortSpec) {
	match spec.key {
		SortKey::Path => files.sort_unstable(),
		SortKey::Modified => sort_by_time(files, std::fs::Metadata::modified),
		SortKey::Accessed => sort_by_time(files, std::fs::Metadata::accessed),
		SortKey::Created => sort_by_time(files, std::fs::Metadata::created),
	}
	if spec.reverse {
		files.reverse();
	}
}

fn sort_by_time(
	files: &mut Vec<PathBuf>,
	read: fn(&std::fs::Metadata) -> io::Result<std::time::SystemTime>,
) {
	let mut keyed = files
		.drain(..)
		.map(|path| {
			let time = std::fs::metadata(&path)
				.ok()
				.and_then(|meta| read(&meta).ok());
			(time, path)
		})
		.collect::<Vec<_>>();
	keyed.sort_unstable_by(|left, right| match (left.0, right.0) {
		(Some(left_time), Some(right_time)) => left_time
			.cmp(&right_time)
			.then_with(|| left.1.cmp(&right.1)),
		(Some(_), None) => std::cmp::Ordering::Less,
		(None, Some(_)) => std::cmp::Ordering::Greater,
		(None, None) => left.1.cmp(&right.1),
	});
	files.extend(keyed.into_iter().map(|(_, path)| path));
}

/// The bytes a display path prints as, with `--path-separator` applied.
///
/// ripgrep replaces every `/` in a printed path with that byte, the operand
/// prefix included, and it must be exactly ONE byte: `--path-separator XY`
/// exits 2. This is the only place a path becomes output, so it is the only
/// place that substitution can live.
fn display_bytes(path: &Path, separator: Option<u8>) -> Vec<u8> {
	let mut bytes = path.as_os_str().as_encoded_bytes().to_vec();
	if let Some(separator) = separator {
		for byte in &mut bytes {
			if *byte == b'/' {
				*byte = separator;
			}
		}
	}
	bytes
}

/// Reads `--path-separator`, which ripgrep requires to be exactly one byte.
///
/// The wording and the second line of the message are ripgrep 15.1.0's, hint
/// included: on some Windows shells `/` expands on its own, and a caller who
/// hits this needs to know to write `//`.
fn resolve_path_separator(cli: &RgCli) -> Result<Option<u8>, String> {
	let Some(value) = cli.path_separator.as_deref() else {
		return Ok(None);
	};
	let bytes = value.as_bytes();
	if bytes.len() == 1 {
		return Ok(Some(bytes[0]));
	}
	Err(format!(
		"error parsing flag --path-separator: A path separator must be exactly one byte, but the \
		 given separator is {} bytes: {value}\nIn some shells on Windows '/' is automatically \
		 expanded. Use '//' instead.",
		bytes.len()
	))
}

fn display_path(prefix: Option<&OsStr>, root: &Path, path: &Path) -> PathBuf {
	let rel = path.strip_prefix(root).unwrap_or(path);
	if rel.as_os_str().is_empty() {
		return prefix.map_or_else(|| PathBuf::from("."), PathBuf::from);
	}
	prefix.map_or_else(|| rel.to_path_buf(), |operand| Path::new(operand).join(rel))
}

fn process_reader<M: Matcher, R: Read, W: Write>(
	matcher: &M,
	searcher: &mut Searcher,
	reader: R,
	display: Option<&[u8]>,
	opts: &SearchOptions,
	run: &mut RunState,
	out: &mut W,
) -> io::Result<bool> {
	// `!opts.quiet`, because `rg --json -q` prints the summary record and NOTHING
	// else, with `bytes_printed: 0` in it. Measured on ripgrep 15.1.0. Routing a
	// quiet run through the normal sink instead of the JSON printer is what gets
	// both halves right: that sink already withholds every line and still counts
	// the whole search, and the summary is written once at the end either way.
	if opts.json && !opts.quiet {
		let mut builder = JSONBuilder::new();
		builder.replacement(opts.replacement.clone());
		let mut printer = builder.build(out);
		if let Some(display) = display {
			let path = PathBuf::from(String::from_utf8_lossy(display).into_owned());
			let mut sink = printer.sink_with_path(matcher, &path);
			searcher.search_reader(matcher, reader, &mut sink)?;
			let matched = sink.has_match();
			run.stats += sink.stats();
			return Ok(matched);
		}
		let mut sink = printer.sink(matcher);
		searcher.search_reader(matcher, reader, &mut sink)?;
		let matched = sink.has_match();
		run.stats += sink.stats();
		return Ok(matched);
	}

	let captures = matcher
		.new_captures()
		.map_err(|error| io::Error::other(error.to_string()))?;
	let mut sink = RgSink {
		out: CountingWriter { inner: out, written: 0 },
		matcher,
		display,
		opts,
		captures,
		scratch: Vec::new(),
		spans: Vec::new(),
		replaced_spans: Vec::new(),
		line_count: 0,
		match_count: 0,
		any_match: false,
		bytes_searched: 0,
		follows_a_group: run.printed_group,
		printed_group: false,
		binary_offset: None,
		binary_quit: false,
	};
	let started = Instant::now();
	let outcome = searcher.search_reader(matcher, reader, &mut sink);
	let elapsed = started.elapsed();
	// Accounted even when the search FAILED partway, because the bytes really
	// were read and the file really was searched. Reporting nothing for a file
	// that errored would make `files searched` disagree with the diagnostics on
	// stderr.
	accumulate_text_stats(&mut run.stats, &sink, elapsed);
	run.printed_group |= sink.printed_group;
	outcome?;
	// A file the binary filter took is not selected either way round: it prints no
	// path under `--files-without-match`, so reporting it as selected would leave
	// the exit status claiming a listing that is not on stdout. See
	// `RgSink::filtered_as_binary`.
	if sink.filtered_as_binary() {
		return Ok(false);
	}
	Ok(opts.selected_input(sink.any_match))
}

/// State that belongs to the RUN rather than to one file.
///
/// Both fields used to be, or would have been, a separate `&mut` parameter on
/// five functions that already carry
/// `#[allow(clippy::too_many_arguments)]`. They travel together because they
/// have the same lifetime and the same reason to exist: a per-file search
/// cannot know the run's totals or whether another file has printed yet.
struct RunState {
	/// Totals for `--stats` and the JSON summary event.
	stats:         Stats,
	/// Whether any file has printed a group of lines yet.
	///
	/// `--heading` puts a blank line BETWEEN groups and not before the first, so
	/// a sink has to know whether it is the first to print. The sink is rebuilt
	/// per file, so this cannot live there.
	printed_group: bool,
}

/// Fold one text-path search into the run's totals.
///
/// The JSON printer keeps its own `Stats` and is added to directly, so this is
/// the other half of the same bookkeeping rather than a second scheme: both end
/// up in the one `Stats` that `--stats` and the JSON summary read.
///
/// `matched_lines` and `matches` come from the sink's own counters, which are
/// the numbers `-c` and `--count-matches` already print, so the block cannot
/// disagree with the counts in the output above it.
fn accumulate_text_stats<M: Matcher, W: Write>(
	stats: &mut Stats,
	sink: &RgSink<'_, M, W>,
	elapsed: Duration,
) {
	stats.add_elapsed(elapsed);
	stats.add_searches(1);
	if sink.any_match {
		stats.add_searches_with_match(1);
	}
	stats.add_bytes_searched(sink.bytes_searched);
	// `bytes printed` describes the RECORDS a run printed, and a summary mode
	// prints none: measured on ripgrep 15.1.0, `--stats -c`, `-l`,
	// `--count-matches`, `--files-without-match` and `-q` all report `0 bytes
	// printed` while their own output is on stdout, because those modes come from
	// a printer that does not keep the number. Counting our summary lines here
	// made the field disagree with ripgrep for every count run, and the field is
	// the one a caller uses to size the output it is about to read, which a count
	// line is not part of.
	if !sink.opts.summary_mode() && !sink.opts.quiet {
		stats.add_bytes_printed(sink.out.written);
	}
	stats.add_matched_lines(sink.line_count);
	stats.add_matches(sink.match_count);
}

/// The preprocessor a run puts in front of its files, resolved once.
///
/// `--pre` names ONE program, and every file it handles is searched through
/// that program's standard output instead of its own contents. `--pre-glob`
/// narrows which files that is, because the flag spawns a process per file and
/// a caller searching a tree of source with one `.pdf` in it should not pay for
/// the other thousand.
struct Preprocessor {
	/// The program, exactly as the caller wrote it. Not split on spaces: ripgrep
	/// looks up the whole value as one program name and its help tells you to
	/// write a wrapper script, so `--pre "cat -A"` is a program called `cat
	/// -A`.
	command: OsString,
	/// `None` when no `--pre-glob` was given, which means every file.
	globs:   Option<Override>,
}

impl Preprocessor {
	/// `None` when nothing asked for a preprocessor, which is the common case.
	///
	/// `--no-pre` and an EMPTY `--pre` both mean no preprocessor, and ripgrep
	/// says so in its help: "Either an empty string COMMAND or the --no-pre
	/// flag will disable this behavior". The globs are still compiled when a
	/// command is present, so a bad glob is reported before any file is
	/// searched rather than per file.
	fn resolve(cli: &RgCli) -> Result<Option<Self>, String> {
		let Some(command) = cli.pre.as_ref().filter(|command| !command.is_empty()) else {
			return Ok(None);
		};
		if cli.no_pre {
			return Ok(None);
		}
		let globs = if cli.pre_globs.is_empty() {
			None
		} else {
			let mut builder = OverrideBuilder::new(veyyon_uutils_ctx::cwd());
			for glob in &cli.pre_globs {
				builder
					.add(glob)
					.map_err(|error| format!("--pre-glob {glob:?}: {error}"))?;
			}
			Some(builder.build().map_err(|error| error.to_string())?)
		};
		Ok(Some(Self { command: command.clone(), globs }))
	}

	/// Whether this file goes through the preprocessor.
	///
	/// With no globs, every file does. With globs, only the ones they select,
	/// and a file they leave out is searched as itself, which is what makes the
	/// flag a narrowing and not a filter on the search.
	fn handles(&self, path: &Path) -> bool {
		self
			.globs
			.as_ref()
			.is_none_or(|globs| globs.matched(path, false).is_whitelist())
	}

	/// Start the program on this file.
	///
	/// The file is given to it TWICE, as its one argument and on its standard
	/// input, because ripgrep does: "Each COMMAND also has its standard input
	/// connected to PATH for convenience", which is what lets a wrapper `exec
	/// cat` with no arguments.
	fn open(&self, path: &Path) -> io::Result<CommandReader> {
		let stdin = File::open(path)?;
		let args = [path.as_os_str().to_os_string()];
		spawn_reader(&self.command, &args, Some(stdin)).map_err(|error| {
			io::Error::other(format!(
				"preprocessor command could not start: '{}': {error}",
				command_line(&self.command, path)
			))
		})
	}
}

/// The decompression rules, compiled once for the whole process.
///
/// The table is fixed (a glob set mapping `*.gz` to `gzip -d -c` and so on),
/// and it used to be rebuilt for EVERY file a `-z` run touched, which is a
/// glob-set compile per file for a table that never changes.
fn decompression_matcher() -> &'static DecompressionMatcher {
	static MATCHER: OnceLock<DecompressionMatcher> = OnceLock::new();
	MATCHER.get_or_init(DecompressionMatcher::new)
}

/// The command line as it appears in a report: the program and each argument in
/// double quotes, space separated.
///
/// `Command`'s own `Debug` writes this shape, but it also writes every
/// environment variable set on the command, and we set the shell's whole
/// exported environment, so the report is built here instead of borrowed from
/// it.
fn command_line(program: &OsStr, path: &Path) -> String {
	format!("{:?} {:?}", program.to_string_lossy(), path.to_string_lossy())
}

/// The one place this builtin starts a child process.
///
/// Both `-z` and `--pre` run one, and both have to run it the way the SHELL
/// would: the program looked up on the shell's `PATH` rather than the host
/// process's, in the shell's working directory, with the shell's exported
/// environment. A program that cannot be found is an ERROR here and never a
/// quiet skip, because the file it was going to read would otherwise be
/// searched as though the caller had asked for its raw bytes.
fn spawn_reader(
	program: &OsStr,
	args: &[OsString],
	stdin: Option<File>,
) -> io::Result<CommandReader> {
	let resolved = veyyon_uutils_ctx::resolve_program(program).ok_or_else(|| {
		io::Error::new(
			io::ErrorKind::NotFound,
			format!("{}: no such program on the shell's PATH", program.to_string_lossy()),
		)
	})?;
	let mut command = Command::new(resolved);
	command
		.args(args)
		.current_dir(veyyon_uutils_ctx::cwd())
		.env_clear()
		.envs(veyyon_uutils_ctx::env_snapshot());
	if let Some(file) = stdin {
		command.stdin(Stdio::from(file));
	}
	CommandReader::new(&mut command).map_err(io::Error::from)
}

/// Where one file's bytes come from.
///
/// A file is normally read as itself. `--pre` and `-z` put a child process in
/// front of it, and the searcher does not care which, so the two cases meet
/// here and every caller has ONE reader type to hand to `process_reader`.
enum FileInput {
	Direct(File),
	Child(CommandReader),
}

impl Read for FileInput {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		match self {
			Self::Direct(file) => file.read(buf),
			Self::Child(reader) => reader.read(buf),
		}
	}
}

/// Open one file the way the flags ask for.
///
/// The order is ripgrep's, and its help states it: `--pre` "overrides the
/// -z/--search-zip flag". A file the preprocessor's globs leave out still
/// reaches `-z`, so the two flags compose rather than exclude each other.
///
/// A `-z` file whose decompressor cannot START is an ERROR here, which is a
/// deliberate divergence from ripgrep: `grep_cli`'s decompression reader logs
/// the failure at debug level and then reads the file as-is, so `rg -z hit
/// x.br` on a machine without `brotli` searches the compressed bytes, finds
/// nothing, and exits 1 as though the file simply held no match. Measured on
/// ripgrep 15.1.0, which prints `plain hit` for a `.br` file that is not brotli
/// at all. A search that silently reads the wrong bytes is worse than one that
/// stops, so this reports the file and keeps searching the rest of the tree.
fn open_file_input(cli: &RgCli, opts: &SearchOptions, path: &Path) -> io::Result<FileInput> {
	if let Some(pre) = opts.pre.as_ref().filter(|pre| pre.handles(path)) {
		return pre.open(path).map(FileInput::Child);
	}
	if cli.search_zip
		&& let Some(command) = decompression_matcher().command(path)
	{
		// The program and its arguments come from `grep_cli`'s rule table (`*.gz` means
		// `gzip -d -c`), and the path is appended the way that crate appends it. They
		// are read back off the `Command` it built rather than spawned from it,
		// because the spawn has to go through the one owner that applies the shell's
		// PATH, directory and environment.
		let mut args: Vec<OsString> = command.get_args().map(OsStr::to_os_string).collect();
		args.push(path.as_os_str().to_os_string());
		return spawn_reader(command.get_program(), &args, None)
			.map(FileInput::Child)
			.map_err(|error| {
				io::Error::other(format!(
					"the decompressor for this file could not start: {error}. Install it, or search \
					 without -z"
				))
			});
	}

	File::open(path).map(FileInput::Direct)
}

#[allow(
	clippy::too_many_arguments,
	reason = "file processing needs the matcher, searcher, output state, and path metadata"
)]
/// Search one file.
///
/// `display` is the prefix its RECORDS carry, which is `None` when the run
/// prints bare lines. `reported` is the name a DIAGNOSTIC uses, and it is
/// always there, because a report has to name the file whatever the output
/// shape is: with one operand and no prefixes, an error used to fall back to
/// the absolute path this builtin resolved internally, so `rg hit a.txt`
/// reported `rg: /tmp/xyz/a.txt: ...` for a path the caller never wrote.
/// ripgrep names the operand as typed.
fn process_file<M: Matcher, W: Write>(
	cli: &RgCli,
	matcher: &M,
	searcher: &mut Searcher,
	path: &Path,
	display: Option<&[u8]>,
	reported: &[u8],
	opts: &SearchOptions,
	run: &mut RunState,
	out: &mut W,
) -> SearchOutcome {
	let result = open_file_input(cli, opts, path)
		.and_then(|reader| process_reader(matcher, searcher, reader, display, opts, run, out));
	match result {
		Ok(any_match) => SearchOutcome { any_match, had_error: false },
		Err(error) => SearchOutcome {
			any_match: false,
			had_error: report_path_error(Some(reported), path, error, opts),
		},
	}
}

fn report_path_error(
	display: Option<&[u8]>,
	fallback: &Path,
	err: io::Error,
	opts: &SearchOptions,
) -> bool {
	if !opts.no_messages {
		let name = display
			.map(|bytes| String::from_utf8_lossy(bytes).into_owned())
			.unwrap_or_else(|| fallback.display().to_string());
		let _ = writeln!(veyyon_uutils_ctx::stderr(), "rg: {name}: {err}");
	}
	true
}

#[allow(
	clippy::too_many_arguments,
	reason = "required by standard walk/configure interfaces and search parameters"
)]
fn search_collected_files<M: Matcher, W: Write>(
	cli: &RgCli,
	matcher: &M,
	searcher: &mut Searcher,
	prefix: Option<&OsStr>,
	root: &Path,
	show_names: bool,
	opts: &SearchOptions,
	run: &mut RunState,
	out: &mut W,
) -> SearchOutcome {
	let mut files = match collect_filtered_files(cli, root) {
		Ok(files) => files,
		Err(_) if veyyon_uutils_ctx::is_cancelled() => {
			return SearchOutcome { any_match: false, had_error: true };
		},
		Err(err) => {
			if !opts.no_messages {
				let _ = writeln!(veyyon_uutils_ctx::stderr(), "rg: {err}");
			}
			return SearchOutcome { any_match: false, had_error: true };
		},
	};
	// The key was validated in `run`, so this cannot fail here. Only a sorted
	// search reaches this function, so a missing spec would mean the caller routed
	// here by mistake, and path order is the only defensible answer for a search
	// that promised an order.
	let spec = resolve_sort(cli)
		.ok()
		.flatten()
		.unwrap_or(SortSpec { key: SortKey::Path, reverse: false });
	sort_paths(&mut files, spec);
	let mut any_match = false;
	let mut had_error = false;
	let mut processed_file = false;
	for path in files {
		if opts.stops_the_run_at_first_match() && any_match {
			break;
		}
		if processed_file && veyyon_uutils_ctx::is_cancelled() {
			had_error = true;
			break;
		}
		processed_file = true;
		let display_path = display_path(prefix, root, &path);
		let display_bytes = display_bytes(&display_path, opts.path_separator);
		let display = (show_names || opts.json).then_some(display_bytes.as_slice());
		let outcome =
			process_file(cli, matcher, searcher, &path, display, &display_bytes, opts, run, out);
		any_match |= outcome.any_match;
		had_error |= outcome.had_error;
		if veyyon_uutils_ctx::is_cancelled() {
			had_error = true;
			break;
		}
	}
	SearchOutcome { any_match, had_error }
}

#[allow(
	clippy::too_many_arguments,
	reason = "required by standard walk/configure interfaces and search parameters"
)]
fn search_dir<M: Matcher, W: Write>(
	cli: &RgCli,
	matcher: &M,
	searcher: &mut Searcher,
	prefix: Option<&OsStr>,
	root: &Path,
	show_names: bool,
	opts: &SearchOptions,
	run: &mut RunState,
	out: &mut W,
) -> SearchOutcome {
	// Any sort key at all means the files have to be collected before the first one
	// is searched, because an order cannot be promised while streaming.
	if resolve_sort(cli).ok().flatten().is_some() {
		return search_collected_files(
			cli, matcher, searcher, prefix, root, show_names, opts, run, out,
		);
	}
	let walk = match build_walk(cli, root) {
		Ok(walk) => walk,
		Err(err) => {
			if !opts.no_messages {
				let _ = writeln!(veyyon_uutils_ctx::stderr(), "rg: {err}");
			}
			return SearchOutcome { any_match: false, had_error: true };
		},
	};
	let any_match = std::cell::Cell::new(false);
	let had_error = std::cell::Cell::new(false);
	let walked = walk.request.for_each_entry_with_heartbeat(
		crate::walk_end::cancellation_heartbeat(),
		|entry| {
			if opts.stops_the_run_at_first_match() && any_match.get() {
				return Ok(veyyon_walker::WalkDecision::Stop);
			}
			let path = entry.absolute_path.as_ref();
			if !walk.filters.includes(path, entry.file_type, entry.size) {
				return Ok(if entry.file_type == veyyon_walker::FileType::Dir {
					veyyon_walker::WalkDecision::SkipDescend
				} else {
					veyyon_walker::WalkDecision::Skip
				});
			}
			if entry.file_type != veyyon_walker::FileType::File {
				return Ok(veyyon_walker::WalkDecision::Skip);
			}
			let display_path = display_path(prefix, root, path);
			let display_bytes = display_bytes(&display_path, opts.path_separator);
			let display = (show_names || opts.json).then_some(display_bytes.as_slice());
			let outcome =
				process_file(cli, matcher, searcher, path, display, &display_bytes, opts, run, out);
			any_match.set(any_match.get() || outcome.any_match);
			had_error.set(had_error.get() || outcome.had_error);
			Ok(if opts.stops_the_run_at_first_match() && any_match.get() {
				veyyon_walker::WalkDecision::Stop
			} else {
				veyyon_walker::WalkDecision::Include
			})
		},
		|error| {
			had_error.set(true);
			if !opts.no_messages {
				let _ = writeln!(
					veyyon_uutils_ctx::stderr(),
					"rg: {}: {}",
					error.path.display(),
					error.error
				);
			}
			Ok(veyyon_walker::WalkDecision::Include)
		},
	);
	// Every arm below produces an outcome, so this function always answers from
	// the streaming walk. It used to wrap the answer in an `Option` and fall back
	// to `search_collected_files` when it was `None`, which no arm ever
	// produced: a second whole search hidden behind an unreachable branch. The
	// sorted path still routes to the collected search, at the top of this
	// function, where the condition that selects it is visible.
	match crate::walk_end::classify_walk_end("rg", walked, Path::to_path_buf) {
		crate::walk_end::WalkEnd::Finished => {
			SearchOutcome { any_match: any_match.get(), had_error: had_error.get() }
		},
		// Harness cancellation; the shell wrapper overrides the exit code and
		// stays silent on stderr, so no spurious "interrupted" diagnostic.
		crate::walk_end::WalkEnd::Cancelled => {
			SearchOutcome { any_match: any_match.get(), had_error: true }
		},
		crate::walk_end::WalkEnd::Failed(message) => {
			if !opts.no_messages {
				let _ = writeln!(veyyon_uutils_ctx::stderr(), "{message}");
			}
			SearchOutcome { any_match: any_match.get(), had_error: true }
		},
	}
}

fn collect_filtered_files(cli: &RgCli, root: &Path) -> Result<Vec<PathBuf>, String> {
	let walk = build_walk(cli, root)?;
	let outcome = match walk
		.request
		.collect_with_heartbeat(crate::walk_end::cancellation_heartbeat())
	{
		Ok(outcome) => outcome,
		// The classifier decides the wording, so a collected walk and a streamed
		// walk report the same failure the same way. Cancellation still returns an
		// error here, because there is no partial list to hand back, but the
		// message is one every caller drops on its cancellation check.
		Err(err) => {
			return Err(match crate::walk_end::classify_walk_error("rg", err, Path::to_path_buf) {
				crate::walk_end::WalkFailure::Cancelled => String::from("rg: cancelled"),
				crate::walk_end::WalkFailure::Failed(message) => message,
			});
		},
	};
	let mut files = Vec::new();
	for entry in outcome.entries {
		if entry.file_type != veyyon_walker::FileType::File {
			continue;
		}
		let path = entry.absolute_path(root);
		if walk.filters.includes(&path, entry.file_type, entry.size) {
			files.push(path);
		}
	}
	Ok(files)
}

fn list_files<W: Write>(
	cli: &RgCli,
	paths: &[OsString],
	implicit_root: bool,
	out: &mut W,
) -> SearchOutcome {
	let mut any = false;
	let mut had_error = false;
	let mut processed_operand = false;
	// `--files` is still a search as far as `--no-messages` is concerned. Real rg
	// 15.1.0 prints `rg: nosuchdir: IO error ...` for `rg --files nosuchdir` and
	// prints NOTHING for `rg --files --no-messages nosuchdir`, exiting 2 either
	// way. Both diagnostics below used to print unconditionally, so the one flag
	// whose entire job is silencing them did not reach this mode.
	let no_messages = no_messages_for(cli);
	// Validated in `run`, so this cannot fail here.
	let separator = resolve_path_separator(cli).unwrap_or(None);
	for operand in paths {
		if processed_operand && veyyon_uutils_ctx::is_cancelled() {
			had_error = true;
			break;
		}
		processed_operand = true;
		let prefix = (!implicit_root).then_some(operand.as_os_str());
		let resolved = veyyon_uutils_ctx::resolve(operand);
		match std::fs::metadata(&resolved) {
			Ok(meta) if meta.is_dir() => {
				let mut files = match collect_filtered_files(cli, &resolved) {
					Ok(files) => files,
					Err(_) if veyyon_uutils_ctx::is_cancelled() => {
						had_error = true;
						break;
					},
					Err(err) => {
						if !no_messages {
							let _ = writeln!(veyyon_uutils_ctx::stderr(), "rg: {err}");
						}
						had_error = true;
						continue;
					},
				};
				if let Some(spec) = resolve_sort(cli).ok().flatten() {
					sort_paths(&mut files, spec);
				}
				for path in files {
					let display = display_path(prefix, &resolved, &path);
					let _ = out.write_all(&display_bytes(&display, separator));
					let _ = out.write_all(if cli.null { b"\0" } else { b"\n" });
					any = true;
				}
			},
			Ok(meta) if meta.is_file() => {
				let _ = out.write_all(&display_bytes(Path::new(operand), separator));
				let _ = out.write_all(if cli.null { b"\0" } else { b"\n" });
				any = true;
			},
			Ok(_) => {},
			Err(err) => {
				if !no_messages {
					let _ =
						writeln!(veyyon_uutils_ctx::stderr(), "rg: {}: {err}", operand.to_string_lossy());
				}
				had_error = true;
			},
		}
		if veyyon_uutils_ctx::is_cancelled() {
			had_error = true;
			break;
		}
	}
	SearchOutcome { any_match: any, had_error }
}

/// Fills in the path to search when the caller named none, and reports whether
/// the working directory was the one filled in.
///
/// That answer decides how paths PRINT: an operand is echoed verbatim in front
/// of every path from it, so `rg hit .` prints `./a.rs`, while the implicit
/// root prints `a.rs` bare. Overloading the operand `"."` for both cases is
/// what made the two indistinguishable, and it lost the prefix ripgrep prints.
fn default_paths(paths: &mut Vec<OsString>, use_implicit_stdin: bool) -> bool {
	if !paths.is_empty() {
		return false;
	}
	if use_implicit_stdin {
		paths.push(OsString::from("-"));
		return false;
	}
	paths.push(OsString::from("."));
	true
}

fn show_names_for(paths: &[OsString], recursive: bool, cli: &RgCli, opts: &SearchOptions) -> bool {
	if cli.no_filename {
		false
	} else if cli.with_filename || opts.files_with_matches || opts.files_without_match || cli.vimgrep
	{
		true
	} else {
		recursive || paths.len() > 1
	}
}

/// A duration in the three-field shape every ripgrep JSON record uses.
///
/// `human` is the same six-decimal seconds rendering the `--stats` text block
/// prints, which is what ripgrep 15.1.0 emits here: 14197 nanoseconds is
/// `"0.000014s"`. It is NOT Rust's `Debug` for a `Duration`, which the first
/// version of this function used and which renders the same value as
/// `"14.197\u{b5}s"`, a string no consumer expecting ripgrep's schema can read.
fn json_duration(elapsed: Duration) -> serde_json::Value {
	// Alphabetical, for the reason `write_json_summary` states.
	serde_json::json!({
		"human": format!("{:.6}s", elapsed.as_secs_f64()),
		"nanos": elapsed.subsec_nanos(),
		"secs": elapsed.as_secs(),
	})
}

/// Write the `summary` record that closes a `--json` stream.
///
/// PROBED AGAINST RIPGREP 15.1.0, including the parts that look like slips:
///
/// - It carries TWO durations. `stats.elapsed` is time inside the searcher and
///   `elapsed_total` is wall time for the whole run, the same pair the
///   `--stats` text block prints as "seconds spent searching" and "seconds
///   total". `elapsed_total` was missing here entirely, so a consumer asking
///   how long the run took read `undefined`.
/// - The KEY ORDER is not the order the other records use. `begin`, `match` and
///   `end` print `type` first and their stats fields in declaration order,
///   while `summary` prints `data` before `type` and every field inside it
///   alphabetically, down to `human`, `nanos`, `secs`. That is ripgrep
///   serializing this one record through a map instead of a struct. Every field
///   below is therefore written in ALPHABETICAL order, which is the one order
///   that is correct however `serde_json` is built: with the `preserve_order`
///   feature its map keeps insertion order, without it the map sorts, and
///   alphabetical insertion satisfies both. Writing them in reading order
///   instead made this record's bytes depend on which crates were in the build,
///   because a `-p veyyon_uu_grep` build sorted them while a `--workspace`
///   build, where another crate turns `preserve_order` on, did not. The bytes
///   are what a consumer diffs, so the order is part of the contract.
/// - It is written even when NOTHING matched, and it is then the whole output,
///   with the exit code still 1.
fn write_json_summary<W: Write>(out: &mut W, stats: &Stats, total: Duration) -> io::Result<()> {
	let summary = serde_json::json!({
		"data": {
			"elapsed_total": json_duration(total),
			"stats": {
				"bytes_printed": stats.bytes_printed(),
				"bytes_searched": stats.bytes_searched(),
				"elapsed": json_duration(stats.elapsed()),
				"matched_lines": stats.matched_lines(),
				"matches": stats.matches(),
				"searches": stats.searches(),
				"searches_with_match": stats.searches_with_match(),
			}
		},
		"type": "summary"
	});
	serde_json::to_writer(&mut *out, &summary).map_err(io::Error::other)?;
	out.write_all(b"\n")
}

/// Write the `--stats` block, in ripgrep's own format.
///
/// PROBED AGAINST RIPGREP 15.1.0 rather than invented. Every detail below is a
/// deliberate copy of what it prints, including the parts that read like bugs:
///
/// - A BLANK LINE comes first, always, even when nothing matched and the block
///   is the entire output.
/// - Nothing is singularized. One match prints `1 matches` and one file prints
///   `1 files searched`. Pluralizing correctly would be a divergence.
/// - The two durations are printed with SIX decimal places, and they are
///   different quantities: time inside the searcher, then wall time for the
///   whole run.
/// - The block goes to STDOUT, after the results, so a pipeline that reads
///   matches sees it. That is why `--stats` is not on by default.
fn write_stats_summary<W: Write>(out: &mut W, stats: &Stats, total: Duration) -> io::Result<()> {
	let searching = stats.elapsed();
	write!(
		out,
		"\n{} matches\n{} matched lines\n{} files contained matches\n{} files searched\n{} bytes \
		 printed\n{} bytes searched\n{:.6} seconds spent searching\n{:.6} seconds total\n",
		stats.matches(),
		stats.matched_lines(),
		stats.searches_with_match(),
		stats.searches(),
		stats.bytes_printed(),
		stats.bytes_searched(),
		searching.as_secs_f64(),
		total.as_secs_f64(),
	)
}

fn execute_search<M: Matcher, W: Write>(
	cli: &RgCli,
	matcher: &M,
	paths: &[OsString],
	implicit_root: bool,
	opts: &SearchOptions,
	out: &mut W,
) -> i32 {
	let started = Instant::now();
	let mut auto_searcher = match build_searcher(cli, opts, BinaryMode::Automatic) {
		Ok(searcher) => searcher,
		Err(error) => {
			let _ = writeln!(veyyon_uutils_ctx::stderr(), "rg: {error}");
			return 2;
		},
	};
	let mut explicit_searcher = match build_searcher(cli, opts, BinaryMode::Explicit) {
		Ok(searcher) => searcher,
		Err(error) => {
			let _ = writeln!(veyyon_uutils_ctx::stderr(), "rg: {error}");
			return 2;
		},
	};
	let recursive = paths.iter().any(|path| {
		path.as_os_str() != OsStr::new("-")
			&& std::fs::metadata(veyyon_uutils_ctx::resolve(path)).is_ok_and(|meta| meta.is_dir())
	});
	let show_names = show_names_for(paths, recursive, cli, opts);
	let mut run = RunState { stats: Stats::new(), printed_group: false };
	let mut any_match = false;
	let mut had_error = false;
	let mut processed_operand = false;
	for operand in paths {
		if opts.stops_the_run_at_first_match() && any_match {
			break;
		}
		if processed_operand && veyyon_uutils_ctx::is_cancelled() {
			had_error = true;
			break;
		}
		processed_operand = true;
		if operand.as_os_str() == OsStr::new("-") {
			let display = show_names.then_some(b"<stdin>".as_slice());
			match process_reader(
				matcher,
				&mut explicit_searcher,
				veyyon_uutils_ctx::stdin(),
				display,
				opts,
				&mut run,
				out,
			) {
				Ok(matched) => any_match |= matched,
				Err(error) => {
					had_error = true;
					if !opts.no_messages {
						let _ = writeln!(veyyon_uutils_ctx::stderr(), "rg: <stdin>: {error}");
					}
				},
			}
			if veyyon_uutils_ctx::is_cancelled() {
				had_error = true;
				break;
			}
			continue;
		}
		let resolved = veyyon_uutils_ctx::resolve(operand);
		match std::fs::metadata(&resolved) {
			Ok(meta) if meta.is_dir() => {
				let outcome = search_dir(
					cli,
					matcher,
					&mut auto_searcher,
					(!implicit_root).then_some(operand.as_os_str()),
					&resolved,
					show_names,
					opts,
					&mut run,
					out,
				);
				any_match |= outcome.any_match;
				had_error |= outcome.had_error;
			},
			Ok(meta) if meta.is_file() => {
				let operand_bytes = display_bytes(Path::new(operand), opts.path_separator);
				let display = (show_names || opts.json).then_some(operand_bytes.as_slice());
				let outcome = process_file(
					cli,
					matcher,
					&mut explicit_searcher,
					&resolved,
					display,
					&operand_bytes,
					opts,
					&mut run,
					out,
				);
				any_match |= outcome.any_match;
				had_error |= outcome.had_error;
			},
			Ok(_) => {},
			Err(error) => {
				had_error = true;
				if !opts.no_messages {
					let _ = writeln!(
						veyyon_uutils_ctx::stderr(),
						"rg: {}: {error}",
						operand.to_string_lossy()
					);
				}
			},
		}
		if veyyon_uutils_ctx::is_cancelled() {
			had_error = true;
			break;
		}
	}
	if opts.json {
		let _ = write_json_summary(out, &run.stats, started.elapsed());
	} else if opts.stats {
		// JSON already carries every one of these fields in its summary event, so
		// printing the text block as well would be the same numbers twice, in a
		// shape no JSON reader can parse.
		let _ = write_stats_summary(out, &run.stats, started.elapsed());
	}
	let _ = out.flush();
	if opts.quiet {
		if any_match {
			0
		} else if had_error {
			2
		} else {
			1
		}
	} else if had_error {
		2
	} else if any_match {
		0
	} else {
		1
	}
}

/// Runs the ripgrep-compatible builtin and returns a process-style exit code.
/// The clap command backing `rg`, before any argument has been read.
#[must_use]
pub fn uu_app() -> clap::Command {
	RgCli::command()
}

/// Parse `argv` and discard the result, reporting only whether it was accepted.
///
/// The deciding half of [`run`] with the acting half removed, for the same
/// reason the `grep` side has one: `run` searches the filesystem, so it is the
/// wrong thing to hand generated input to, while this touches nothing but the
/// `argv` it is given. `rg` has by far the larger flag table of the two, which
/// is exactly why its parsing is worth exercising directly.
///
/// # Errors
///
/// Returns the `clap` error for an argv the command rejects, including the
/// not-really-errors clap uses for `--help` and `--version`.
pub fn try_parse_argv(argv: Vec<OsString>) -> Result<(), clap::Error> {
	RgCli::try_parse_from(argv).map(|_| ())
}

/// The spelling of a flag as this command line wrote it.
///
/// clap reports the argument by its declaration, `--max-count <NUM>`, while
/// ripgrep echoes what you typed: `rg -m abc` names `-m` and `rg --max-count
/// abc` names `--max-count`. The last spelling on the line wins, because that
/// is the one whose value was parsed, and a short cluster names the flag when
/// it holds the letter, so `-imabc` names `-m`. The spellings come from the
/// parser itself, so they cannot drift away from the flags.
fn typed_spelling(argv: &[OsString], declared_long: &str) -> String {
	let name = declared_long.trim_start_matches('-');
	let command = RgCli::command();
	let Some(arg) = command
		.get_arguments()
		.find(|arg| arg.get_long() == Some(name))
	else {
		return declared_long.to_string();
	};
	let longs: Vec<&str> = std::iter::once(name)
		.chain(arg.get_all_aliases().unwrap_or_default())
		.collect();
	let short = arg.get_short();
	let mut spelling = None;
	for token in argv.iter().skip(1) {
		let Some(text) = token.to_str() else { continue };
		if text == "--" {
			break;
		}
		if let Some(rest) = text.strip_prefix("--") {
			let written = rest.split('=').next().unwrap_or(rest);
			if longs.contains(&written) {
				spelling = Some(format!("--{written}"));
			}
			continue;
		}
		if let (Some(short), Some(cluster)) = (short, text.strip_prefix('-'))
			&& cluster.contains(short)
		{
			spelling = Some(format!("-{short}"));
		}
	}
	spelling.unwrap_or_else(|| format!("--{name}"))
}

/// Renders a command-line failure in ripgrep's words.
///
/// ripgrep has three shapes and no usage block: `error parsing flag <flag>:
/// <reason>` for a value it cannot read, `missing value for flag <flag>: ...`
/// for a flag whose value was left off, and `unrecognized flag <flag>` for a
/// flag it does not know. clap words all three differently, adds a "tip" and a
/// usage block, and points at `--help`, so its three kinds are translated here.
/// Returns `None` for everything else, which is help and version output: those
/// ask for clap's own rendering, and the caller prints it unchanged.
fn argv_diagnostic(argv: &[OsString], error: &clap::Error) -> Option<String> {
	use clap::error::{ContextKind, ContextValue, ErrorKind};
	let text = |kind: ContextKind| match error.get(kind) {
		Some(ContextValue::String(value)) => Some(value.clone()),
		_ => None,
	};
	let declared = text(ContextKind::InvalidArg)?;
	let long = declared.split(' ').next().unwrap_or(&declared);
	// A positional argument is declared as `[ARGS]...`, and ripgrep has no wording
	// for one, so it keeps clap's.
	if !long.starts_with('-') {
		return None;
	}
	match error.kind() {
		// clap echoes the unknown flag as it was written, which is what ripgrep
		// prints, so there is no spelling to recover here.
		ErrorKind::UnknownArgument => Some(format!("unrecognized flag {long}")),
		ErrorKind::ValueValidation => {
			let reason = std::error::Error::source(error)?.to_string();
			Some(format!("error parsing flag {}: {reason}", typed_spelling(argv, long)))
		},
		ErrorKind::InvalidValue => {
			let value = text(ContextKind::InvalidValue)?;
			// clap reports an absent value as an empty one with no valid choices to
			// offer, and a flag with choices always has some, so that pair is how a
			// missing value is told apart from a rejected one.
			let no_choices = matches!(
				error.get(ContextKind::ValidValue),
				Some(ContextValue::Strings(choices)) if choices.is_empty()
			);
			if value.is_empty() && no_choices {
				return Some(format!(
					"missing value for flag {long}: missing argument for option '{long}'"
				));
			}
			Some(format!(
				"error parsing flag {}: {}",
				typed_spelling(argv, long),
				unrecognized_choice(&value)
			))
		},
		_ => None,
	}
}

/// Whether a `--no-json` cancels the `--json` that chose the output mode.
///
/// `--no-json` is NOT a member of [`OUTPUT_MODE_FLAGS`], and the reason is a
/// measured asymmetry rather than an oversight. On ripgrep 15.1.0 it switches
/// the mode back to the standard one only when the mode is currently JSON, so
/// it cancels a `--json` that came before it and does nothing at all to any
/// other mode:
///
/// - `rg -c --json --no-json` prints matching LINES: `--json` beat `-c`, then
///   `--no-json` cancelled it and the standard mode is what is left.
/// - `rg --json -c --no-json` prints `2`: `-c` had already beaten `--json`, so
///   there was no JSON mode left for `--no-json` to cancel.
///
/// A plain group membership gets the second case wrong, because it would leave
/// `--no-json` as the winner and print lines. The rule is therefore one
/// comparison: the cancel counts when it comes AFTER the `--json` that won.
/// `rg --json --no-json --json` is JSON again for the same reason.
fn json_is_cancelled(cli: &RgCli, matches: &clap::ArgMatches) -> bool {
	if !cli.json || !cli.no_json {
		return false;
	}
	// Both flags are present, so both indices exist. An absent flag still reports
	// an index in clap, which is why presence is read off the parsed struct and
	// only the ORDER is read off the matches.
	let json = matches.index_of("json").unwrap_or(0);
	let cancel = matches.index_of("no_json").unwrap_or(0);
	cancel > json
}

pub fn run(argv: Vec<OsString>) -> i32 {
	// Parsed through `ArgMatches` rather than `try_parse_from`, because the
	// `--no-json` rule above needs the argv POSITION of two flags and the derived
	// struct does not carry it.
	let cli = match RgCli::command().try_get_matches_from(&argv) {
		Ok(matches) => {
			let mut cli = RgCli::from_arg_matches(&matches)
				.expect("an argv clap accepted should build the struct clap derived");
			if json_is_cancelled(&cli, &matches) {
				cli.json = false;
			}
			cli
		},
		Err(error) => {
			if let Some(diagnostic) = argv_diagnostic(&argv, &error) {
				let _ = writeln!(veyyon_uutils_ctx::stderr(), "rg: {diagnostic}");
				return 2;
			}
			let rendered = error.to_string();
			if error.use_stderr() {
				let _ = write!(veyyon_uutils_ctx::stderr(), "{rendered}");
				return 2;
			}
			let _ = write!(veyyon_uutils_ctx::stdout(), "{rendered}");
			return 0;
		},
	};

	let mut opts = search_options(&cli);
	match Preprocessor::resolve(&cli) {
		Ok(pre) => opts.pre = pre,
		Err(error) => {
			let _ = writeln!(veyyon_uutils_ctx::stderr(), "rg: {error}");
			return 2;
		},
	}
	// The sort key is validated once, here, so the search paths that ask for it
	// again cannot be handed a value they would have to ignore. A sort key the tool
	// ignores answers a different question than the one the caller asked.
	if let Err(error) = resolve_sort(&cli) {
		let _ = writeln!(veyyon_uutils_ctx::stderr(), "rg: {error}");
		return 2;
	}
	if let Err(error) = resolve_path_separator(&cli) {
		let _ = writeln!(veyyon_uutils_ctx::stderr(), "rg: {error}");
		return 2;
	}
	let mut out: RgOutput = Buffering::resolve(&cli, veyyon_uutils_ctx::stdout_is_terminal())
		.wrap(veyyon_uutils_ctx::stdout());
	// Before the operands are read, because `--generate` looks at none of them:
	// `rg --generate man hit a.txt` writes the man page and ignores both, which is
	// what ripgrep does.
	if let Some(kind) = cli.generate {
		if let Err(error) = write_generated(kind, &mut out) {
			let _ = writeln!(veyyon_uutils_ctx::stderr(), "rg: {error}");
			return 2;
		}
		let _ = out.flush();
		return 0;
	}
	let (patterns, mut paths) = match resolve_patterns(&cli) {
		Ok(resolved) => resolved,
		Err(error) => {
			let _ = writeln!(veyyon_uutils_ctx::stderr(), "rg: {error}");
			return 2;
		},
	};
	if cli.type_list {
		return match print_type_list(&cli, &mut out) {
			Ok(()) => 0,
			Err(error) => {
				let _ = writeln!(veyyon_uutils_ctx::stderr(), "rg: {error}");
				2
			},
		};
	}
	let pattern_stdin_consumed = cli.pattern_files.iter().any(|file| file == OsStr::new("-"));
	let implicit_root = default_paths(
		&mut paths,
		!cli.files && !pattern_stdin_consumed && veyyon_uutils_ctx::stdin_is_search_input(),
	);
	if cli.files {
		let outcome = list_files(&cli, &paths, implicit_root, &mut out);
		let _ = out.flush();
		return if outcome.had_error {
			2
		} else if outcome.any_match {
			0
		} else {
			1
		};
	}
	if patterns.is_empty() {
		return 1;
	}
	let matcher = match build_matcher(&patterns, &cli) {
		Ok(matcher) => matcher,
		Err(error) => {
			let _ = writeln!(veyyon_uutils_ctx::stderr(), "rg: {error}");
			return 2;
		},
	};
	match &matcher {
		CompiledMatcher::Rust(matcher) => {
			execute_search(&cli, matcher, &paths, implicit_root, &opts, &mut out)
		},
		CompiledMatcher::Pcre(matcher) => {
			execute_search(&cli, matcher, &paths, implicit_root, &opts, &mut out)
		},
	}
}

#[cfg(test)]
mod tests {
	use std::{
		collections::HashMap,
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

	/// Parse an argv the way `run` does, so a test can ask what the flags
	/// resolved to without running a search.
	///
	/// One helper for the whole test module: the flag suites all need it, and
	/// two copies would be two places where a change to how argv[0] is passed
	/// has to be made.
	fn parse(args: &[&str]) -> RgCli {
		let argv: Vec<OsString> = ["rg"]
			.into_iter()
			.chain(args.iter().copied())
			.map(OsString::from)
			.collect();
		RgCli::try_parse_from(argv).expect("the argv should parse")
	}

	/// The scope environment a run sees.
	///
	/// `PATH` and nothing else. A real shell always exports one, and the builtin
	/// needs it: `-z` and `--pre` look their program up on the SHELL's `PATH`,
	/// not the host process's, so a scope with no `PATH` cannot find `gzip`.
	/// Everything else is left out on purpose, so a test cannot pick up the
	/// machine's locale, `HOME` or ignore configuration by accident.
	fn scope_env() -> HashMap<String, String> {
		std::env::var("PATH")
			.ok()
			.map(|path| ("PATH".to_string(), path))
			.into_iter()
			.collect()
	}

	fn run_rg(args: &[&str], stdin: &str) -> (i32, String, String) {
		run_rg_in(args, stdin, &std::env::temp_dir())
	}

	fn run_rg_in(args: &[&str], stdin: &str, cwd: &Path) -> (i32, String, String) {
		let out = Arc::new(Mutex::new(Vec::new()));
		let err = Arc::new(Mutex::new(Vec::new()));
		let io = ScopeIo {
			stdin:                 Box::new(io::Cursor::new(stdin.as_bytes().to_vec())),
			stdin_fd:              None,
			stdin_is_search_input: true,
			stdout:                Box::new(SharedBuf(Arc::clone(&out))),
			stdout_is_terminal:    false,
			stderr:                Box::new(SharedBuf(Arc::clone(&err))),
			cwd:                   cwd.to_path_buf(),
			env:                   scope_env(),
			cancel:                Arc::new(AtomicBool::new(false)),
		};
		let argv: Vec<OsString> = std::iter::once("rg")
			.chain(args.iter().copied())
			.map(OsString::from)
			.collect();
		let code = scope(io, || run(argv));
		let stdout = String::from_utf8(out.lock().clone()).expect("utf8 stdout");
		let stderr = String::from_utf8(err.lock().clone()).expect("utf8 stderr");
		(code, stdout, stderr)
	}

	#[test]
	fn max_count_accepts_an_attached_value() {
		let (code, stdout, stderr) = run_rg(&["-m1", "hit"], "hit\nmiss\nhit\n");
		assert_eq!(code, 0, "{stderr}");
		assert_eq!(stdout, "hit\n");
	}

	#[test]
	fn pcre2_matches_lookbehind_patterns() {
		let (code, stdout, stderr) = run_rg(&["--pcre2", "(?<=foo)bar"], "foobar\nbar\n");
		assert_eq!(code, 0, "{stderr}");
		assert_eq!(stdout, "foobar\n");
	}

	#[test]
	fn replacement_expands_capture_groups() {
		let (code, stdout, stderr) =
			run_rg(&["-o", "--replace=${word}-x", "(?P<word>foo)"], "foo bar\n");
		assert_eq!(code, 0, "{stderr}");
		assert_eq!(stdout, "foo-x\n");
	}

	#[test]
	fn byte_offset_reports_the_absolute_match_position() {
		let (code, stdout, stderr) = run_rg(&["--byte-offset", "hit"], "zero\nhit\n");
		assert_eq!(code, 0, "{stderr}");
		assert_eq!(stdout, "5:hit\n");
	}

	#[test]
	fn json_emits_structured_search_events() {
		let (code, stdout, stderr) = run_rg(&["--json", "hit"], "miss\nhit\n");
		assert_eq!(code, 0, "{stderr}");
		let events: Vec<serde_json::Value> = stdout
			.lines()
			.map(|line| serde_json::from_str(line).expect("each output line should be JSON"))
			.collect();
		let kinds: Vec<&str> = events
			.iter()
			.map(|event| event["type"].as_str().expect("event type"))
			.collect();
		assert_eq!(kinds, ["begin", "match", "end", "summary"]);
		assert_eq!(events[1]["data"]["lines"]["text"], "hit\n");
		assert_eq!(events[3]["data"]["stats"]["searches"], 1);
		assert_eq!(events[3]["data"]["stats"]["searches_with_match"], 1);
		assert_eq!(events[3]["data"]["stats"]["matched_lines"], 1);
		assert_eq!(events[3]["data"]["stats"]["matches"], 1);
	}

	#[test]
	fn explicit_encoding_transcodes_input_before_matching() {
		let tree = unique_tree("encoding");
		std::fs::write(tree.join("utf16.txt"), b"h\0i\0t\0\n\0")
			.expect("UTF-16 fixture should be written");
		let (code, stdout, stderr) =
			run_rg_in(&["--encoding=utf-16le", "hit", "utf16.txt"], "", &tree);
		assert_eq!(code, 0, "{stderr}");
		assert_eq!(stdout, "hit\n");
		let _ = std::fs::remove_dir_all(tree);
	}

	#[test]
	fn explicit_ignore_file_filters_recursive_search() {
		let tree = unique_tree("ignore-file");
		std::fs::write(tree.join("keep.txt"), "hit\n").expect("included fixture should be written");
		std::fs::write(tree.join("skip.txt"), "hit\n").expect("ignored fixture should be written");
		std::fs::write(tree.join("rules.ignore"), "skip.txt\n")
			.expect("ignore rules should be written");
		let (code, stdout, stderr) =
			run_rg_in(&["--ignore-file=rules.ignore", "hit", "."], "", &tree);
		assert_eq!(code, 0, "{stderr}");
		assert!(stdout.contains("keep.txt:hit\n"), "{stdout:?}");
		assert!(!stdout.contains("skip.txt"), "{stdout:?}");
		let _ = std::fs::remove_dir_all(tree);
	}

	#[test]
	fn glob_case_insensitive_applies_to_regular_globs() {
		let tree = unique_tree("glob-case");
		std::fs::write(tree.join("UPPER.TXT"), "hit\n").expect("fixture should be written");
		let (code, stdout, stderr) =
			run_rg_in(&["--glob-case-insensitive", "--glob=*.txt", "hit", "."], "", &tree);
		assert_eq!(code, 0, "{stderr}");
		assert_eq!(stdout, "./UPPER.TXT:hit\n", "the `.` operand prints in front of the path");
		let _ = std::fs::remove_dir_all(tree);
	}

	#[test]
	fn search_zip_decompresses_supported_files() {
		let tree = unique_tree("search-zip");
		let gzip = [
			31, 139, 8, 0, 0, 0, 0, 0, 2, 255, 203, 205, 44, 46, 230, 202, 200, 44, 225, 2, 0, 26, 30,
			21, 140, 9, 0, 0, 0,
		];
		std::fs::write(tree.join("sample.gz"), gzip).expect("gzip fixture should be written");
		let (code, stdout, stderr) = run_rg_in(&["--search-zip", "hit", "sample.gz"], "", &tree);
		assert_eq!(code, 0, "{stderr}");
		assert_eq!(stdout, "hit\n");
		let _ = std::fs::remove_dir_all(tree);
	}

	/// Run `rg` with stdin marked as NOT search input, the way a terminal
	/// session looks. Without an operand that is the only way to reach the
	/// implicit root, which prints paths differently from an explicit `.`
	/// operand.
	fn run_rg_no_stdin(args: &[&str], cwd: &Path) -> (i32, String, String) {
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
			env:                   scope_env(),
			cancel:                Arc::new(AtomicBool::new(false)),
		};
		let argv: Vec<OsString> = std::iter::once("rg")
			.chain(args.iter().copied())
			.map(OsString::from)
			.collect();
		let code = scope(io, || run(argv));
		let stdout = String::from_utf8(out.lock().clone()).expect("utf8 stdout");
		let stderr = String::from_utf8(err.lock().clone()).expect("utf8 stderr");
		(code, stdout, stderr)
	}

	/// Run `rg` with an explicit scope environment.
	///
	/// The one thing that needs it is `PATH`: `-z` and `--pre` look their
	/// program up on the SHELL's `PATH`, so a test that wants to see what
	/// happens when the program cannot be found sets a `PATH` with nothing on
	/// it rather than hoping the machine is missing a tool.
	fn run_rg_with_env(args: &[&str], cwd: &Path, env: &[(&str, &str)]) -> (i32, String, String) {
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
			env:                   env
				.iter()
				.map(|(key, value)| ((*key).to_string(), (*value).to_string()))
				.collect(),
			cancel:                Arc::new(AtomicBool::new(false)),
		};
		let argv: Vec<OsString> = std::iter::once("rg")
			.chain(args.iter().copied())
			.map(OsString::from)
			.collect();
		let code = scope(io, || run(argv));
		let stdout = String::from_utf8(out.lock().clone()).expect("utf8 stdout");
		let stderr = String::from_utf8(err.lock().clone()).expect("utf8 stderr");
		(code, stdout, stderr)
	}

	/// Run `rg` with the cancel flag pre-set, mirroring the shell wrapper's
	/// behavior when `abort`/`timeout` fires mid-walk.
	fn run_rg_cancelled(args: &[&str], cwd: &Path) -> (i32, String, String) {
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
			env:                   scope_env(),
			cancel:                Arc::new(AtomicBool::new(true)),
		};
		let argv: Vec<OsString> = std::iter::once("rg")
			.chain(args.iter().copied())
			.map(OsString::from)
			.collect();
		let code = scope(io, || run(argv));
		let stdout = String::from_utf8(out.lock().clone()).expect("utf8 stdout");
		let stderr = String::from_utf8(err.lock().clone()).expect("utf8 stderr");
		(code, stdout, stderr)
	}

	use crate::test_temp::{TempTree, unique_tree as shared_unique_tree};

	/// A scratch tree for an `rg` test, kept distinguishable by name from the
	/// ones `lib.rs` makes. The cleanup lives with the guard in `test_temp`,
	/// one owner for the whole crate.
	fn unique_tree(label: &str) -> TempTree {
		shared_unique_tree(&format!("rg-{label}"))
	}

	#[test]
	fn recursive_search_observes_scope_cancellation() {
		// Regression for #3933: rg's recursive walker used to pass a no-op
		// heartbeat to veyyon_walker, so cancellation was not observed during
		// directory traversal even after the uutils ctx cancel flag was set.
		let tree = unique_tree("search");
		let walk_root = tree.join("walk-root");
		std::fs::create_dir_all(&walk_root).expect("walk root should be created");
		std::fs::write(walk_root.join("haystack.txt"), "match-me\n").expect("walked file written");
		let later_file = tree.join("later.txt");
		std::fs::write(&later_file, "match-me\n").expect("later file written");

		let (code, stdout, stderr) = run_rg_cancelled(
			&[
				"match-me",
				walk_root.to_str().expect("utf8 path"),
				later_file.to_str().expect("utf8 path"),
			],
			&tree,
		);

		assert!(stdout.is_empty(), "cancelled walk should not output matches: {stdout:?}");
		assert!(
			stderr.is_empty(),
			"cancelled walk should stay silent — diagnostic is the shell's job: {stderr:?}"
		);
		assert_eq!(code, 2, "interrupted directory walk should report had_error (exit 2)");

		let _ = std::fs::remove_dir_all(&tree);
	}

	#[test]
	fn files_mode_observes_scope_cancellation() {
		// Regression for #3933: `rg --files <dir>` routes through
		// `collect_filtered_files`, whose heartbeat was likewise a no-op.
		let tree = unique_tree("files");
		let walk_root = tree.join("walk-root");
		std::fs::create_dir_all(&walk_root).expect("walk root should be created");
		std::fs::write(walk_root.join("alpha.txt"), "alpha\n").expect("walked file written");
		let later_file = tree.join("later.txt");
		std::fs::write(&later_file, "later\n").expect("later file written");

		let (code, stdout, stderr) = run_rg_cancelled(
			&[
				"--files",
				walk_root.to_str().expect("utf8 path"),
				later_file.to_str().expect("utf8 path"),
			],
			&tree,
		);

		assert!(stdout.is_empty(), "cancelled --files walk should not enumerate paths: {stdout:?}");
		assert!(stderr.is_empty(), "cancelled --files walk should stay silent: {stderr:?}");
		// Cancellation is an error for standalone utility status; the shell
		// wrapper rewrites it to the user-visible cancelled status (130).
		assert_eq!(code, 2, "cancelled --files walk should stop before later operands");

		let _ = std::fs::remove_dir_all(&tree);
	}

	/// Which modes print ordinary lines, and which own their output instead.
	///
	/// WHY THIS SUITE EXISTS. Four places in this file decided whether a
	/// matching line, a context line, a context break or a JSON stream may be
	/// printed, and each spelled the disjunction out again: `count ||
	/// count_matches || files_with_matches || files_without_match || ...`, with
	/// a different tail each time. The tails are deliberate, but four inline
	/// copies of a five-term predicate is how a fifth mode gets added to three
	/// of them, and the failure would be silent. `rg -c -C2` printing context
	/// lines is not an error; it is the wrong output, and only somebody
	/// comparing against real ripgrep would notice.
	///
	/// The predicate now has one owner, `SearchOptions::summary_mode`, with
	/// `prints_context_lines` layered on it for the two sink methods, and each
	/// caller states its own delta next to a reason. These cases pin the deltas
	/// as OUTPUT, so a future edit to the predicate has to keep the observable
	/// contract rather than merely keep compiling.
	///
	/// Every negative case here is paired with the same input under plain `-C1`,
	/// because "prints no context lines" is also what a broken search that
	/// finds nothing prints.
	mod summary_modes_own_their_output {
		use super::*;

		/// Two matches with a gap between them, which is what makes a context
		/// break possible.
		const HAYSTACK: &str = "one\nhit\ntwo\nthree\nfour\nhit\nfive\n";

		/// THE CONTROL every case below is measured against: ordinary `-C1`
		/// prints context lines, and prints the `--` separator between the two
		/// blocks.
		#[test]
		fn context_mode_prints_context_lines_and_a_separator() {
			let (code, stdout, stderr) = run_rg(&["-C1", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "one\nhit\ntwo\n--\nfour\nhit\nfive\n");
		}

		/// A context request BEATS `--passthru`, byte for byte identical to the
		/// control above.
		///
		/// This builtin used to let passthru win and print the whole file with no
		/// separator, which is a real divergence from ripgrep and the reason this
		/// case is written as an equality against the control rather than as a
		/// looser check. The two flags are competing answers to "which lines do
		/// you want", and the narrower one wins: a reader who asked for one line
		/// of context asked to see LESS than everything, and honouring passthru
		/// silently gives them more.
		#[test]
		fn a_context_request_beats_passthru() {
			let (code, stdout, stderr) = run_rg(&["--passthru", "-C1", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "one\nhit\ntwo\n--\nfour\nhit\nfive\n");
			assert_ne!(stdout, HAYSTACK, "passthru must not survive a context request");
		}

		/// `-C0` asks for ZERO context lines and still beats passthru, which is
		/// what makes this a fact about the REQUEST rather than about the number.
		///
		/// Reading `before`/`after` after they collapse to `0` cannot tell
		/// `--passthru -C0` from `--passthru`, so a fix written that way would
		/// pass every other case in this module and fail only here. Verified
		/// against ripgrep 15.1.0, which prints exactly the two matching lines.
		#[test]
		fn zero_context_still_beats_passthru() {
			let (code, stdout, stderr) = run_rg(&["--passthru", "-C0", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "hit\nhit\n");
		}

		/// THE NON-VACUITY TWIN of the two cases above: with no context request,
		/// `--passthru` still prints every line of the file. Without this, a fix
		/// that simply deleted passthru would satisfy both cases above.
		#[test]
		fn passthru_alone_prints_every_line() {
			let (code, stdout, stderr) = run_rg(&["--passthru", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, HAYSTACK);
		}

		/// `-c` reports one number per file, so a context request cannot add
		/// lines to it.
		#[test]
		fn count_ignores_a_context_request() {
			let (code, stdout, stderr) = run_rg(&["-c", "-C1", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2\n");
		}

		/// `--count-matches` counts matches rather than lines, and is the term
		/// most recently added to the predicate, which is exactly the kind that
		/// gets added to three sites out of four.
		#[test]
		fn count_matches_ignores_a_context_request() {
			let (code, stdout, stderr) = run_rg(&["--count-matches", "-C1", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2\n");
		}

		/// `-o` changes how a MATCHING line is written, not whether its
		/// neighbours are shown: the match contributes its span, the context
		/// lines around it are printed whole.
		///
		/// The haystack here is deliberately NOT the shared one. In `HAYSTACK`
		/// the pattern is the entire line, so "printed the span" and "printed the
		/// line" produce identical bytes and the case would prove nothing. With
		/// `xxhitxx` the two are distinguishable, and the expected output is the
		/// mixture: `hit` for the match, `one` and `two` in full around it.
		/// Verified against ripgrep 15.1.0.
		#[test]
		fn only_matching_keeps_whole_context_lines() {
			const SUBSTRING: &str = "one\nxxhitxx\ntwo\nthree\nfour\nxxhitxx\nfive\n";

			let (code, stdout, stderr) = run_rg(&["-o", "-C1", "hit"], SUBSTRING);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "one\nhit\ntwo\n--\nfour\nhit\nfive\n");
		}

		/// THE NON-VACUITY TWIN: with no context request `-o` prints the spans
		/// alone, so the whole lines above really are the context and not `-o`
		/// having quietly stopped truncating.
		#[test]
		fn only_matching_alone_prints_spans() {
			const SUBSTRING: &str = "one\nxxhitxx\ntwo\nthree\nfour\nxxhitxx\nfive\n";

			let (code, stdout, stderr) = run_rg(&["-o", "hit"], SUBSTRING);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "hit\nhit\n");
		}

		/// `--vimgrep` emits one `path:line:column:text` record per match AND the
		/// context lines around them, in the plain `path-line-text` form with a
		/// dash separator and no column.
		///
		/// This builtin used to drop the context lines entirely, a second
		/// divergence from ripgrep found while pinning the suppression predicate.
		/// An editor reading vimgrep output asks for context because it wants to
		/// show the surrounding lines; silently omitting them makes `-C` look
		/// like it did nothing. The filename prefix is on for every record here,
		/// context included, because vimgrep output is parsed by an editor that
		/// needs the file even when the search read stdin. Verified against
		/// ripgrep 15.1.0.
		/// The expectation is a JOINED ARRAY rather than one long literal, and
		/// that is not a style choice. This workspace sets `format_strings =
		/// true`, and rustfmt's line splitting is escape-unaware: written as a
		/// single literal this expectation exceeded `max_width`, and the
		/// formatter put its line continuation BETWEEN the `\` and the `n` of
		/// an escape, turning one `\n` into a backslash, a newline, four tabs
		/// and the letter `n`. The test then failed against correct output,
		/// having passed before the formatter ran. One short literal per record
		/// stays under the limit, so there is nothing for the formatter to
		/// split. See RUSTFMT-SPLITS-ESCAPES in the backlog.
		#[test]
		fn vimgrep_prints_context_lines_in_the_plain_form() {
			let (code, stdout, stderr) = run_rg(&["--vimgrep", "-C1", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout,
				[
					"<stdin>-1-one",
					"<stdin>:2:1:hit",
					"<stdin>-3-two",
					"--",
					"<stdin>-5-four",
					"<stdin>:6:1:hit",
					"<stdin>-7-five",
					"",
				]
				.join("\n")
			);
		}

		/// THE NON-VACUITY TWIN: with no context request `--vimgrep` prints the
		/// two match records alone, so the dashed lines above are context and not
		/// a change in how matches are formatted.
		#[test]
		fn vimgrep_alone_prints_only_match_records() {
			let (code, stdout, stderr) = run_rg(&["--vimgrep", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>:2:1:hit\n<stdin>:6:1:hit\n");
		}

		/// `-l` names the file, once, whatever the context request says.
		#[test]
		fn files_with_matches_ignores_a_context_request() {
			let (code, stdout, stderr) = run_rg(&["-l", "-C1", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>\n");
		}

		/// `--files-without-match` on a haystack that DOES match prints nothing
		/// and exits 1, which is the mode's whole contract and the one place a
		/// stray context line would be obvious.
		#[test]
		fn files_without_match_prints_nothing_when_the_file_matches() {
			let (code, stdout, stderr) = run_rg(&["--files-without-match", "-C1", "hit"], HAYSTACK);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "");
		}

		/// THE OTHER HALF of `--files-without-match`, and the non-vacuity twin of
		/// the case above: a file with no match IS listed, and the run exits 0.
		/// Without this, "prints nothing and exits 1" would also be satisfied
		/// by a mode that never lists anything at all.
		#[test]
		fn files_without_match_lists_a_file_that_does_not_match() {
			let (code, stdout, stderr) =
				run_rg(&["--files-without-match", "-C1", "hit"], "one\ntwo\n");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>\n");
		}

		/// `-l` is the mirror mode and its exit status is NOT inverted, which is
		/// what makes the inversion above a per-mode fact rather than a global
		/// one. A file that matches is listed and the run exits 0; the same
		/// file under `-L` exits 1.
		#[test]
		fn files_with_matches_keeps_the_ordinary_exit_status() {
			let (listed, stdout, stderr) = run_rg(&["-l", "hit"], HAYSTACK);
			assert_eq!(listed, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>\n");

			let (empty, stdout, stderr) = run_rg(&["-l", "absent"], HAYSTACK);
			assert_eq!(empty, 1, "{stderr}");
			assert_eq!(stdout, "");
		}

		/// `-q` prints nothing and reports the answer in the exit code alone.
		///
		/// THE CASE THAT FOUND A REAL LEAK. Before-context lines are written
		/// BEFORE the match that selected them, and `-q` stopped the search at
		/// the first match without ever suppressing the writer, so `rg -q -C1`
		/// printed one line and then went quiet. A mode whose entire
		/// contract is "print nothing" printing something is not a formatting
		/// slip: `-q` is what a script uses when it only wants the exit code,
		/// and stray bytes on stdout land in whatever the script was capturing.
		#[test]
		fn quiet_prints_nothing_at_all() {
			let (code, stdout, stderr) = run_rg(&["-q", "-C1", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "");
		}

		/// And `-q` still reports a miss as 1, so the fix suppressed output
		/// rather than the search.
		#[test]
		fn quiet_still_reports_a_miss_in_the_exit_code() {
			let (code, stdout, stderr) = run_rg(&["-q", "-C1", "absent"], HAYSTACK);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "");
		}
	}

	/// Every record ends with the terminator the run is actually using.
	///
	/// WHY THIS SUITE EXISTS. `--null-data` makes NUL the record separator, and
	/// the point of the flag is that the output can be read back by a
	/// NUL-splitting consumer such as `xargs -0`. This printer wrote `\n` after
	/// every record regardless, so `--null-data` emitted `hit\0\n`: split on
	/// NUL and every record after the first arrives with a leading newline.
	/// Nothing failed, no test covered it, and the flag's only purpose was
	/// defeated.
	///
	/// `--null` had the mirror bug from the other direction. It is documented as
	/// REPLACING the byte that follows a path, and this printer appended a NUL
	/// and then wrote the separator as well, so `-0 -n` produced `path\0:1:hit`
	/// and `-0 -l` produced `path\0\n`. Again splittable output that does not
	/// split.
	///
	/// Every expectation below was captured from ripgrep 15.1.0 on this machine
	/// before anything was changed, and every one is asserted as exact bytes,
	/// because that is the entire contract of a machine-readable mode.
	mod every_record_ends_with_the_terminator_the_run_uses {
		use super::*;

		/// NUL-separated input with two matches and a gap between them, so the
		/// context separator has somewhere to go.
		const NUL_HAYSTACK: &str = "a\0hit\0b\0c\0d\0hit\0e\0";

		/// The same records separated by newlines, for the control cases.
		const LF_HAYSTACK: &str = "a\nhit\nb\nc\nd\nhit\ne\n";

		/// THE BUG, in its simplest form: two matching records, each ending with
		/// one NUL and nothing else.
		#[test]
		fn matching_records_end_with_nul() {
			let (code, stdout, stderr) = run_rg(&["--null-data", "hit"], NUL_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "hit\0hit\0");
		}

		/// THE CONTROL, so a failure above is about the terminator rather than
		/// about the search: the same query over newline-separated input is
		/// unchanged.
		#[test]
		fn newline_separated_input_is_unchanged() {
			let (code, stdout, stderr) = run_rg(&["hit"], LF_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "hit\nhit\n");
		}

		/// Context lines AND the `--` separator take the terminator too. The
		/// separator is the case a fix limited to the match writer would miss.
		#[test]
		fn context_lines_and_the_separator_end_with_nul() {
			let (code, stdout, stderr) = run_rg(&["--null-data", "-C1", "hit"], NUL_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a\0hit\0b\0--\0d\0hit\0e\0");
		}

		/// A summary mode's record is a number, and it ends the same way. `-c`
		/// writes through a different path from the line writer, which is why it
		/// is pinned separately.
		#[test]
		fn a_count_ends_with_nul() {
			let (code, stdout, stderr) = run_rg(&["--null-data", "-c", "hit"], NUL_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2\0");
		}

		/// `-o` writes the matched span through its own writer, so it needs its
		/// own case.
		#[test]
		fn only_matching_spans_end_with_nul() {
			let (code, stdout, stderr) = run_rg(&["--null-data", "-o", "hit"], NUL_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "hit\0hit\0");
		}

		/// A prefix does not change the terminator: the line number is still
		/// followed by `:` and the record still ends with NUL.
		///
		/// The NULs here are spelled `\x00` rather than `\0` because the next
		/// character is a digit, and `\06` reads as an octal escape to anyone
		/// skimming it. `\x00` cannot be misread, so the expectation stays
		/// legible as the two bytes it is.
		#[test]
		fn a_line_number_prefix_keeps_the_nul_terminator() {
			let (code, stdout, stderr) = run_rg(&["--null-data", "-n", "hit"], NUL_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2:hit\x006:hit\x00");
		}

		/// A listed path is a record, so `-l` ends it with NUL under
		/// `--null-data`.
		#[test]
		fn a_listed_path_ends_with_nul() {
			let (code, stdout, stderr) = run_rg(&["--null-data", "-l", "hit"], NUL_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>\0");
		}

		/// `--null` REPLACES the colon after a path prefix rather than adding a
		/// NUL before it. `path\0:1:hit` is what this printer used to emit, and
		/// it is unsplittable: the field after the NUL starts with a colon.
		#[test]
		fn the_null_flag_replaces_the_colon_after_a_path() {
			let (code, stdout, stderr) = run_rg(&["-0", "-H", "-n", "hit"], LF_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>\x002:hit\n<stdin>\x006:hit\n");
		}

		/// And in a LIST mode the path's NUL is the whole record terminator, with
		/// no newline after it. `path\0\n` was the other unsplittable form.
		#[test]
		fn the_null_flag_terminates_a_listed_path_by_itself() {
			let (code, stdout, stderr) = run_rg(&["-0", "-l", "hit"], LF_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>\0");
		}

		/// `--null` does NOT change the line terminator, which is the boundary
		/// between the two flags: the path separator becomes NUL, the record
		/// still ends with a newline.
		#[test]
		fn the_null_flag_leaves_the_line_terminator_alone() {
			let (code, stdout, stderr) = run_rg(&["-0", "-H", "-c", "hit"], LF_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>\x002\n");
		}

		/// THE NON-VACUITY TWIN for the two `-0` cases: without `-0` the path is
		/// followed by the ordinary separator, so the NULs above are the flag
		/// working rather than the path writer having stopped writing anything.
		#[test]
		fn without_the_null_flag_a_path_keeps_its_ordinary_separator() {
			let (prefixed, stdout, stderr) = run_rg(&["-H", "-n", "hit"], LF_HAYSTACK);
			assert_eq!(prefixed, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>:2:hit\n<stdin>:6:hit\n");

			let (listed, stdout, stderr) = run_rg(&["-l", "hit"], LF_HAYSTACK);
			assert_eq!(listed, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>\n");
		}

		/// BOTH FLAGS AT ONCE, which is the combination a NUL pipeline actually
		/// uses: NUL-separated input, NUL-terminated paths, and no newline
		/// anywhere in the output.
		#[test]
		fn the_two_null_flags_compose() {
			let (code, stdout, stderr) =
				run_rg(&["--null-data", "-0", "-H", "-n", "hit"], NUL_HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>\x002:hit\x00<stdin>\x006:hit\x00");
			assert!(!stdout.contains('\n'), "a NUL pipeline must emit no newlines: {stdout:?}");
		}

		/// The long-line notice is a record too. It is written by the branch that
		/// replaces the line entirely, so a terminator fix that only touched the
		/// normal path would leave this one emitting a newline into a NUL stream.
		#[test]
		fn the_omitted_line_notice_ends_with_nul() {
			let (code, stdout, stderr) = run_rg(&["--null-data", "-M", "2", "hit"], "hit\0");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "[Omitted long matching line]\0");
		}
	}

	/// A DECOMPRESSOR THAT CANNOT RUN IS AN ERROR, NOT A SILENT PLAIN-TEXT READ.
	///
	/// `grep_cli`'s decompression reader logs a failed spawn at debug level and
	/// then reads the file as-is, so ripgrep 15.1.0 on a machine without
	/// `brotli` prints `plain hit` for a `.br` file, having searched bytes
	/// nobody asked it to search, and exits 0. When the file really is
	/// compressed the same path finds nothing and exits 1, which is
	/// indistinguishable from a file that held no match. This builtin
	/// reports the file instead and keeps searching the rest, which is a
	/// deliberate divergence: a search that quietly reads the wrong bytes is
	/// worse than one that says it could not read them.
	mod a_decompressor_that_cannot_run_is_reported {
		use super::*;

		/// `hit\n` as a gzip member, so the file really is compressed and a
		/// plain-text read of it would find nothing.
		const GZIPPED: &[u8] =
			&[31, 139, 8, 0, 0, 0, 0, 0, 2, 3, 203, 200, 44, 225, 2, 0, 179, 165, 86, 51, 4, 0, 0, 0];

		/// A `PATH` with one directory on it that holds no programs at all, which
		/// is how a missing decompressor is produced without depending on the
		/// machine.
		fn empty_path(root: &Path) -> String {
			root.join("no-tools").to_string_lossy().into_owned()
		}

		/// The headline: the file is REPORTED and the run exits 2, where ripgrep
		/// would have searched the compressed bytes and exited 1.
		#[test]
		fn a_missing_decompressor_is_reported_instead_of_read_as_text() {
			let tree = unique_tree("zip-missing");
			std::fs::write(tree.join("c.gz"), GZIPPED).expect("gzip fixture should be written");

			let (code, stdout, stderr) =
				run_rg_with_env(&["-z", "hit", "c.gz"], &tree, &[("PATH", &empty_path(&tree))]);

			assert_eq!(code, 2, "an unusable decompressor is an error");
			assert_eq!(stdout, "", "and nothing was searched");
			assert!(
				stderr.starts_with("rg: c.gz: the decompressor for this file could not start: "),
				"{stderr:?}"
			);
			assert!(stderr.contains("Install it, or search without -z"), "with the fix: {stderr:?}");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// The same file with a usable `PATH` decompresses, so the case above is
		/// about the missing program and not about the fixture.
		#[test]
		fn the_same_file_decompresses_when_the_program_is_reachable() {
			let tree = unique_tree("zip-present");
			std::fs::write(tree.join("c.gz"), GZIPPED).expect("gzip fixture should be written");

			let (code, stdout, stderr) = run_rg_no_stdin(&["-z", "hit", "c.gz"], &tree);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "hit\n");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// A file no decompression rule matches is read as itself, which is the
		/// case the loud failure must NOT swallow: `-z` over a tree of source
		/// files still searches them, with no diagnostics.
		#[test]
		fn a_file_no_rule_matches_is_still_read_as_itself() {
			let tree = unique_tree("zip-plain");
			std::fs::write(tree.join("a.txt"), "plain hit\n").expect("fixture should be written");

			let (code, stdout, stderr) =
				run_rg_with_env(&["-z", "hit", "a.txt"], &tree, &[("PATH", &empty_path(&tree))]);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "plain hit\n", "no rule, no program, no error");
			assert_eq!(stderr, "");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// One unusable file does not end the run: the readable files around it
		/// are still searched, their matches still print, and the exit code
		/// still reports the failure. Failing the whole run would be as
		/// unhelpful as swallowing it.
		#[test]
		fn the_rest_of_the_tree_is_still_searched() {
			let tree = unique_tree("zip-mixed");
			std::fs::write(tree.join("c.gz"), GZIPPED).expect("gzip fixture should be written");
			std::fs::write(tree.join("a.txt"), "plain hit\n").expect("fixture should be written");

			let (code, stdout, stderr) =
				run_rg_with_env(&["-z", "hit", "."], &tree, &[("PATH", &empty_path(&tree))]);

			assert_eq!(code, 2, "the failure is reported through the status");
			assert_eq!(stdout, "./a.txt:plain hit\n", "the readable file was searched");
			assert!(stderr.contains("c.gz"), "and the other one was reported: {stderr:?}");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// `-s/--no-messages` hides the report and keeps the status, the way it
		/// does for every other file-level failure in this builtin.
		#[test]
		fn no_messages_hides_the_report_and_keeps_the_status() {
			let tree = unique_tree("zip-quiet");
			std::fs::write(tree.join("c.gz"), GZIPPED).expect("gzip fixture should be written");

			let (code, stdout, stderr) = run_rg_with_env(
				&["-z", "--no-messages", "hit", "c.gz"],
				&tree,
				&[("PATH", &empty_path(&tree))],
			);

			assert_eq!(code, 2, "the status still says it went wrong");
			assert_eq!(stdout, "");
			assert_eq!(stderr, "", "and the sentence is hidden");

			let _ = std::fs::remove_dir_all(tree);
		}
	}

	/// `--pre` PUTS A PROGRAM IN FRONT OF EVERY FILE IT HANDLES.
	///
	/// WHY THIS SUITE EXISTS. The flag did not exist at all: `rg --pre pdftotext
	/// hit .` was a clap error, so the one way ripgrep offers to search a
	/// format it cannot read was missing, and so was `--pre-glob`, which is
	/// what keeps the flag from spawning a process per file in a tree that
	/// mostly does not need one.
	///
	/// PROBED AGAINST RIPGREP 15.1.0 for every rule here, including the three
	/// that are not guessable: the file is handed to the program TWICE, as its
	/// one argument and on its standard input; the value is ONE program name
	/// and never a command line, so `--pre "cat -A"` looks for a program with a
	/// space in its name; and `--pre` beats `-z` while a file its globs leave
	/// out still reaches `-z`.
	mod a_preprocessor_stands_in_front_of_the_file {
		use super::*;

		/// A tree with a script that reports what it was given, plus two files.
		///
		/// The script writes `ARG=<path>` and `STDIN=<bytes>`, which is how the
		/// two ways ripgrep hands over the file are told apart in the output.
		fn tree(label: &str) -> TempTree {
			let root = unique_tree(label);
			std::fs::write(root.join("a.txt"), "plain hit\n").expect("fixture should be written");
			std::fs::write(root.join("b.log"), "other hit\n").expect("fixture should be written");
			let script = root.join("show.sh");
			std::fs::write(&script, "#!/bin/sh\necho \"ARG=$1\"\necho \"STDIN=$(cat)\"\n")
				.expect("script should be written");
			executable(&script);
			root
		}

		/// Mark a file executable, which a preprocessor has to be.
		fn executable(path: &Path) {
			#[cfg(unix)]
			{
				use std::os::unix::fs::PermissionsExt;

				std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
					.expect("script should be executable");
			}
		}

		/// The file reaches the program BOTH ways, as its argument and on its
		/// standard input, so a wrapper can either read `$1` or `exec cat`.
		/// Asserting only one of the two would let the other quietly go
		/// missing.
		#[test]
		fn the_file_is_handed_over_as_an_argument_and_on_standard_input() {
			let root = tree("pre-both");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--pre", "./show.sh", "hit", "a.txt"], &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "STDIN=plain hit\n", "the searched text is the program's output");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--pre", "./show.sh", "ARG=", "a.txt"], &root);
			assert_eq!(code, 0, "{stderr}");
			assert!(stdout.starts_with("ARG=") && stdout.contains("a.txt"), "argument: {stdout:?}");
		}

		/// The program's output replaces the file's CONTENTS, so a pattern that
		/// matches the file and not the output finds nothing. This is the whole
		/// point of the flag and the case a wiring mistake would pass by
		/// accident.
		#[test]
		fn the_programs_output_replaces_the_file_contents() {
			let root = tree("pre-replaces");
			let script = root.join("nothing.sh");
			std::fs::write(&script, "#!/bin/sh\necho other\n").expect("script should be written");
			executable(&script);

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--pre", "./nothing.sh", "hit", "a.txt"], &root);

			assert_eq!(code, 1, "the output holds no match: {stderr}");
			assert_eq!(stdout, "");
		}

		/// `--pre-glob` narrows the flag to the files it names, and the others
		/// are searched as themselves rather than skipped. Skipping them would
		/// turn a performance flag into a filter on the search.
		#[test]
		fn pre_glob_narrows_which_files_are_handed_over() {
			let root = tree("pre-glob");

			let (code, stdout, stderr) = run_rg_no_stdin(
				&["--pre", "./show.sh", "--pre-glob", "*.txt", "hit", "a.txt", "b.log"],
				&root,
			);

			assert_eq!(code, 0, "{stderr}");
			let mut lines: Vec<&str> = stdout.lines().collect();
			lines.sort_unstable();
			assert_eq!(
				lines,
				vec!["a.txt:STDIN=plain hit", "b.log:other hit"],
				"one preprocessed, one read as itself: {stdout:?}"
			);
		}

		/// An EMPTY `--pre` and `--no-pre` both mean no preprocessor, which
		/// ripgrep's help states outright, and a caller composing a command
		/// from a variable depends on: `--pre "$PRE"` with `PRE` unset has to
		/// search the files.
		#[test]
		fn an_empty_command_and_no_pre_both_disable_it() {
			let root = tree("pre-disabled");

			for args in [
				&["--pre", "", "hit", "a.txt"][..],
				&["--pre", "./show.sh", "--no-pre", "hit", "a.txt"][..],
			] {
				let (code, stdout, stderr) = run_rg_no_stdin(args, &root);

				assert_eq!(code, 0, "{args:?}: {stderr}");
				assert_eq!(stdout, "plain hit\n", "{args:?}: the file itself");
			}
		}

		/// The value is ONE program name, never a command line: ripgrep looks up
		/// the whole string, which is why its help tells you to write a wrapper
		/// script. Splitting it on spaces would silently run something the
		/// caller did not name.
		#[test]
		fn the_command_is_one_program_and_not_a_command_line() {
			let root = tree("pre-not-a-line");

			let (code, stdout, stderr) = run_rg_no_stdin(&["--pre", "cat -A", "hit", "a.txt"], &root);

			assert_eq!(code, 2, "there is no program called `cat -A`");
			assert_eq!(stdout, "");
			assert!(
				stderr.contains("preprocessor command could not start")
					&& stderr.contains("\"cat -A\""),
				"the report names the program as written: {stderr:?}"
			);
		}

		/// A program that cannot start is REPORTED, per file, and the run exits 2
		/// while the files that could be preprocessed are still searched. A
		/// quiet skip would look exactly like a file that held no match.
		#[test]
		fn a_program_that_cannot_start_is_reported_and_the_rest_is_searched() {
			let root = tree("pre-missing");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--pre", "./nope.sh", "hit", "a.txt"], &root);

			assert_eq!(code, 2, "an unreachable preprocessor is an error");
			assert_eq!(stdout, "");
			assert!(
				stderr.starts_with("rg: a.txt: preprocessor command could not start: "),
				"{stderr:?}"
			);
			// The operand is named as the caller wrote it, and the command line inside the
			// report shows the RESOLVED path, because that is the argument the child would
			// have been given: a builtin's working directory is the shell's, so a child can
			// only be handed a path it can open on its own.
			assert!(stderr.contains("\"./nope.sh\""), "the report names it: {stderr:?}");
			assert!(
				stderr
					.trim_end()
					.ends_with("no such program on the shell's PATH"),
				"and says why: {stderr:?}"
			);
		}

		/// A program that FAILS after writing something keeps what it wrote and
		/// still reports, which is ripgrep's behaviour: `partial hit` is
		/// printed and the exit code is 2. Throwing the partial output away
		/// would hide a match the caller's own program found.
		#[test]
		fn a_program_that_fails_keeps_what_it_wrote_and_still_reports() {
			let root = tree("pre-fails");
			let script = root.join("fail.sh");
			std::fs::write(&script, "#!/bin/sh\necho \"partial hit\"\necho boom >&2\nexit 3\n")
				.expect("script should be written");
			executable(&script);

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--pre", "./fail.sh", "hit", "a.txt"], &root);

			assert_eq!(code, 2, "the program failed: {stderr}");
			assert_eq!(stdout, "partial hit\n", "what it did write is searched");
			assert!(stderr.contains("boom"), "the program's own stderr is carried: {stderr:?}");
		}

		/// STANDARD INPUT IS NEVER PREPROCESSED, which ripgrep's help says in as
		/// many words. There is no path to hand the program, and a caller
		/// piping into `rg` has already chosen what the bytes are.
		#[test]
		fn standard_input_is_never_preprocessed() {
			let (code, stdout, stderr) = run_rg(&["--pre", "./show.sh", "hit"], "plain hit\n");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "plain hit\n", "the piped bytes, unchanged");
		}

		/// A bad glob is reported before anything is searched, so a caller does
		/// not read half a search and then an error.
		#[test]
		fn a_bad_pre_glob_is_reported_before_the_search() {
			let root = tree("pre-bad-glob");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--pre", "./show.sh", "--pre-glob", "[", "hit", "a.txt"], &root);

			assert_eq!(code, 2, "the glob does not compile");
			assert_eq!(stdout, "", "and nothing was searched");
			assert!(stderr.starts_with("rg: --pre-glob \"[\": "), "{stderr:?}");
		}

		/// `--pre-glob` alone does nothing. ripgrep ignores it without a `--pre`,
		/// and matching that keeps a script that sets both from failing when
		/// one is dropped.
		#[test]
		fn pre_glob_alone_changes_nothing() {
			let root = tree("pre-glob-alone");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--pre-glob", "*.txt", "hit", "a.txt"], &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "plain hit\n");
		}

		/// `--pre` BEATS `-z`, and a file the globs leave out still reaches `-z`,
		/// so the two flags compose. ripgrep's help says the preprocessor
		/// "overrides the -z/--search-zip flag", and the composition is what
		/// makes `--pre-glob '*.pdf' -z` a sensible thing to write.
		#[test]
		fn the_preprocessor_beats_search_zip_and_leaves_the_rest_to_it() {
			let root = tree("pre-over-zip");
			let gzipped = root.join("c.gz");
			// `hit\n` as a gzip member, written as bytes so the test does not need a gzip
			// binary to build its own input. Verified by the decompression case below.
			std::fs::write(&gzipped, [
				31, 139, 8, 0, 0, 0, 0, 0, 2, 3, 203, 200, 44, 225, 2, 0, 179, 165, 86, 51, 4, 0, 0, 0,
			])
			.expect("gzip fixture should be written");

			// The pattern is `ARG=` and not `STDIN=`, because under the preprocessor the
			// second line holds the gzip member's raw bytes: what matters is that the
			// PREPROCESSOR ran, which its own `ARG=` line proves.
			let (code, stdout, stderr) =
				run_rg_no_stdin(&["-z", "--pre", "./show.sh", "ARG=", "c.gz"], &root);
			assert_eq!(code, 0, "the preprocessor ran, not gzip: {stderr}");
			assert!(stdout.starts_with("ARG="), "its output was searched: {stdout:?}");
			assert!(stdout.contains("c.gz"), "for that file: {stdout:?}");

			let (code, stdout, stderr) = run_rg_no_stdin(
				&["-z", "--pre", "./show.sh", "--pre-glob", "*.txt", "hit", "c.gz"],
				&root,
			);
			assert_eq!(code, 0, "the glob left the gzip to -z: {stderr}");
			assert_eq!(stdout, "hit\n", "so it was decompressed");
		}
	}

	/// WHICH ENGINE REFUSED A PATTERN, AND WHY, HAS TO REACH THE CALLER.
	///
	/// `--engine=auto` compiles with the default engine and PROMOTES the pattern
	/// to PCRE2 when the default engine refuses it, which is how `(?<=foo)bar`
	/// works without `--pcre2`. The promotion is silent by design, and the
	/// failure must not be: a pattern neither engine accepts has two errors,
	/// and the default engine's is the one that names the construct. Ours threw
	/// it away with `Err(_)` and printed PCRE2's alone, so `rg --engine=auto
	/// '('` complained about a pattern the caller had never asked PCRE2 to
	/// compile and said nothing about the real mistake.
	///
	/// The shape is ripgrep 15.1.0's, measured: one sentence, then each engine's
	/// error under its own heading, the default engine's fenced by 79 tildes
	/// because it is itself several lines with carets in it.
	mod a_refused_pattern_names_the_engine_that_refused_it {
		use super::*;

		/// The promotion itself: a look-behind is not something the default
		/// engine can compile, and `--engine=auto` searches with it anyway.
		#[test]
		fn auto_promotes_a_pattern_that_needs_pcre2() {
			let (code, stdout, stderr) = run_rg(&["--engine=auto", "(?<=foo)bar"], "foobar\nbar\n");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "foobar\n");
		}

		/// A pattern BOTH engines refuse reports both, in ripgrep's shape. The
		/// default engine's text is taken from a `--engine=default` run of the
		/// same pattern rather than written out here, so the assertion pins
		/// that the real error was carried through instead of pinning one regex
		/// crate's wording.
		#[test]
		fn a_pattern_neither_engine_accepts_reports_both_errors() {
			let (default_code, _, default_error) = run_rg(&["--engine=default", "("], "x\n");
			assert_eq!(default_code, 2, "an unclosed group is an error");
			let default_error = default_error
				.strip_prefix("rg: ")
				.expect("the report is prefixed once")
				.trim_end()
				.to_string();

			let (code, stdout, stderr) = run_rg(&["--engine=auto", "("], "x\n");

			assert_eq!(code, 2, "neither engine could compile it");
			assert_eq!(stdout, "", "nothing was searched");
			let fence = "~".repeat(79);
			let heading = "rg: regex could not be compiled with either the default regex engine or \
			               with PCRE2.\n\ndefault regex engine error:\n";
			assert!(stderr.starts_with(heading), "the sentence and the heading: {stderr:?}");
			assert!(
				stderr.contains(&format!("{fence}\n{default_error}\n{fence}")),
				"the default engine's own error, fenced: {stderr:?}"
			);
			assert!(
				stderr.contains("\n\nPCRE2 regex engine error:\n"),
				"and PCRE2's under its own heading: {stderr:?}"
			);
			assert_eq!(stderr.matches(&fence).count(), 2, "one fence each side: {stderr:?}");
		}

		/// A single-engine run reports that engine ALONE, with no fence and no
		/// second heading, so the combined report cannot leak into the common
		/// case.
		#[test]
		fn a_single_engine_run_reports_only_its_own_error() {
			for engine in ["default", "pcre2"] {
				let (code, _, stderr) = run_rg(&[&format!("--engine={engine}"), "("], "x\n");

				assert_eq!(code, 2, "{engine}: an unclosed group is an error");
				assert!(stderr.starts_with("rg: "), "{engine}: one prefix: {stderr:?}");
				assert!(!stderr.contains('~'), "{engine}: no fence: {stderr:?}");
				assert!(
					!stderr.contains("either the default regex engine"),
					"{engine}: not the combined report: {stderr:?}"
				);
			}
		}

		/// `--pcre2` is the short way to say `--engine=pcre2`, so it reports the
		/// same single error, and it is NOT auto: a pattern PCRE2 refuses is an
		/// error even when the default engine would have taken it.
		#[test]
		fn pcre2_is_not_auto() {
			let (code, stdout, stderr) = run_rg(&["--pcre2", "foo"], "foo\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "foo\n", "PCRE2 searches the ordinary patterns too");

			let (code, _, stderr) = run_rg(&["--pcre2", "("], "x\n");
			assert_eq!(code, 2, "and reports its own refusal");
			assert!(!stderr.contains("either the default regex engine"), "alone: {stderr:?}");
		}
	}

	/// Both regex engines read ONE set of flags.
	///
	/// WHY THIS SUITE EXISTS. `build_rust_matcher` and `build_pcre_matcher` take
	/// the same nine decisions, and each used to derive every one of them
	/// separately from the CLI, in two spellings: `case_insensitive` against
	/// `caseless`, `dot_matches_new_line` against `dotall`. Nine chances to
	/// disagree, and `--engine auto` hides the disagreement completely: it
	/// tries the Rust engine and silently falls back to PCRE2, so a flag
	/// honoured by one and dropped by the other changes what a search RETURNS
	/// depending only on whether the pattern happened to compile. Nothing
	/// fails; the answer is just wrong.
	///
	/// The derivation now happens once, in `MatcherFlags::from_cli`, and both
	/// builders destructure the struct WITHOUT `..`, so a tenth flag is a
	/// compile error in each of them by name. That is the structural half.
	/// These cases are the behavioural half: the same query is run on BOTH
	/// engines and the output is compared byte for byte, which is the only
	/// thing that would catch a flag wired to the wrong setter rather than to
	/// no setter at all.
	mod both_engines_read_one_set_of_flags {
		use super::*;

		/// Run one query on each engine and return the two `(code, stdout)`
		/// pairs.
		///
		/// `--engine default` and `--engine pcre2` are spelled explicitly rather
		/// than relying on `auto`, because `auto` would answer with whichever
		/// engine accepted the pattern and could therefore compare a run against
		/// itself.
		fn on_both_engines(args: &[&str], stdin: &str) -> ((i32, String), (i32, String)) {
			let mut rust: Vec<&str> = vec!["--engine", "default"];
			rust.extend_from_slice(args);
			let mut pcre: Vec<&str> = vec!["--engine", "pcre2"];
			pcre.extend_from_slice(args);

			let (rust_code, rust_out, rust_err) = run_rg(&rust, stdin);
			let (pcre_code, pcre_out, pcre_err) = run_rg(&pcre, stdin);

			assert!(rust_code < 2, "the Rust engine refused {args:?}: {rust_err}");
			assert!(pcre_code < 2, "PCRE2 refused {args:?}: {pcre_err}");
			((rust_code, rust_out), (pcre_code, pcre_out))
		}

		/// Assert the two engines answered identically, which is the invariant.
		fn agree(args: &[&str], stdin: &str) {
			let (rust, pcre) = on_both_engines(args, stdin);

			assert_eq!(rust, pcre, "the engines disagree on {args:?}");
		}

		/// THE CONTROL. Without a case flag the two engines must already agree,
		/// so a failure in any case below is about the flag rather than about
		/// the engines differing on the pattern itself.
		#[test]
		fn a_plain_search_agrees() {
			agree(&["hello"], "hello world\nnothing\n");
		}

		/// `-i`, and the precedence that goes with it: `--case-sensitive` beats
		/// it on both engines. The precedence is derived once now, so a reader
		/// cannot find one engine honouring `-s` and the other not.
		#[test]
		fn case_flags_agree() {
			agree(&["-i", "HELLO"], "hello world\n");
			agree(&["-i", "-s", "HELLO"], "hello world\n");
			agree(&["-S", "hello"], "HELLO world\n");
			agree(&["-S", "HELLO"], "hello world\n");
		}

		/// `-w` in both directions, since "matches nothing" is also what a broken
		/// pattern does.
		#[test]
		fn word_boundaries_agree() {
			agree(&["-w", "ell"], "hello\n");
			agree(&["-w", "ell"], "ell here\n");
		}

		/// `-x`, likewise paired: the whole line must match, and a line that only
		/// contains the pattern must not.
		#[test]
		fn whole_line_agrees() {
			agree(&["-x", "hello"], "hello there\n");
			agree(&["-x", "hello"], "hello\n");
		}

		/// `-F`, which is the flag whose absence is silent and dangerous: dropped
		/// on one engine, `a.b` becomes a regex and matches `axb`.
		#[test]
		fn fixed_strings_agree() {
			agree(&["-F", "a.b"], "axb\n");
			agree(&["-F", "a.b"], "a.b\n");
		}

		/// `--no-unicode`, the flag with two spellings on the PCRE2 side: one
		/// setter on the Rust builder, the `utf`/`ucp` pair on PCRE2, undoing the
		/// shared defaults. `\w` against `é` is exactly the case it changes.
		#[test]
		fn unicode_agrees() {
			agree(&["\\w"], "é\n");
			agree(&["--no-unicode", "\\w"], "é\n");
		}

		/// And the non-vacuity case for the one above: `--no-unicode` really does
		/// change the answer, on BOTH engines. Without this, two engines that
		/// both ignored the flag would agree perfectly and pass.
		#[test]
		fn no_unicode_changes_the_answer_on_both_engines() {
			let ((with_unicode_code, _), (with_unicode_pcre, _)) = on_both_engines(&["\\w"], "é\n");
			let ((without_code, _), (without_pcre, _)) =
				on_both_engines(&["--no-unicode", "\\w"], "é\n");

			assert_eq!(with_unicode_code, 0, "`\\w` matches é when unicode is on");
			assert_eq!(with_unicode_pcre, 0, "and on PCRE2 too");
			assert_eq!(without_code, 1, "`\\w` must not match é with --no-unicode");
			assert_eq!(without_pcre, 1, "and PCRE2 must agree, which is the utf/ucp pair");
		}

		/// `--multiline` with `--multiline-dotall`, the other two-spelling flag
		/// (`dot_matches_new_line` against `dotall`).
		#[test]
		fn multiline_dotall_agrees() {
			agree(&["--multiline", "--multiline-dotall", "a.b"], "a\nb\n");
			agree(&["--multiline", "a.b"], "a\nb\n");
		}

		/// Several flags at once, because a struct read field by field can still
		/// be applied in an order that loses one. This is the combination an
		/// agent actually sends: case-insensitive whole-word literal search.
		#[test]
		fn flags_combine_the_same_way_on_both_engines() {
			agree(&["-i", "-w", "-F", "A.B"], "x a.b y\nxa.by\nA.B\n");
		}

		/// THE FLAG THE ENGINES DO NOT SHARE, pinned so the asymmetry is a
		/// decision rather than a discovery. `--null-data` sets the Rust
		/// engine's line terminator to NUL; PCRE2 has no terminator setting, so
		/// its output can legitimately differ here and `MatcherFlags` names the
		/// field `_` in that builder instead of hiding it behind `..`.
		#[test]
		fn the_line_terminator_reaches_only_the_rust_engine() {
			let (code, stdout, stderr) =
				run_rg(&["--engine", "default", "--null-data", "hit"], "a\0hit\0b\0");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "hit\0");
		}
	}

	/// A context line carries only the prefix fields it actually has.
	///
	/// WHY THIS SUITE EXISTS. `write_prefix` takes the column as an `Option` and
	/// then wrote `column.unwrap_or(1)`, which quietly erased the difference
	/// between "this record has no column" and "nobody computed one". Only a
	/// context line can tell the two apart: it is printed because a match NEARBY
	/// selected it, so there is no match on it and no column to report, while
	/// the match line beside it reports a real one. The result was `1-1-one`
	/// where ripgrep prints `1-one`, on every context line of every `--column`
	/// or `--vimgrep` run. Nothing failed, the output was simply wrong in a way
	/// that an editor parsing `path-line-text` reads as a text field starting
	/// with a digit and a dash.
	///
	/// The line number and byte offset are pinned in the same cases, because
	/// they are the fields that DO apply to a context line and the fix must not
	/// take them with it. Every expectation was verified against ripgrep
	/// 15.1.0.
	mod context_lines_carry_only_the_fields_they_have {
		use super::*;

		/// A match in the middle of a line, so a real column exists to be
		/// reported and cannot be confused with the default of 1.
		const HAYSTACK: &str = "one\nxxhitxx\ntwo\n";

		/// `--column` prints a column on the match and NONE on either neighbour.
		#[test]
		fn column_is_omitted_from_context_lines() {
			let (code, stdout, stderr) = run_rg(&["--column", "-n", "-C1", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1-one\n2:3:xxhitxx\n3-two\n");
		}

		/// THE FIELD THAT DOES APPLY: `-b` reports a byte offset on context lines
		/// too, so the fix cannot be "context lines get no numeric fields". The
		/// offsets are the real ones, 0 and 12, not placeholders.
		#[test]
		fn byte_offset_is_kept_on_context_lines() {
			let (code, stdout, stderr) = run_rg(&["-b", "-C1", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "0-one\n4:xxhitxx\n12-two\n");
		}

		/// All three fields together, which is the ordering the prefix writer has
		/// to keep: path, line, column, byte offset. The context lines skip the
		/// column and keep their place in the sequence.
		#[test]
		fn column_and_byte_offset_together_keep_their_order() {
			let (code, stdout, stderr) = run_rg(&["--column", "-n", "-b", "-C1", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1-0-one\n2:3:4:xxhitxx\n3-12-two\n");
		}

		/// THE NON-VACUITY TWIN: with no context request the match line still
		/// carries its column, so the cases above prove the column was dropped
		/// from CONTEXT lines rather than dropped everywhere.
		#[test]
		fn the_match_line_still_reports_its_column() {
			let (code, stdout, stderr) = run_rg(&["--column", "-n", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2:3:xxhitxx\n");
		}
	}

	/// A JSON stream with every duration removed, so two runs can be compared.
	///
	/// Both the `end` and the `summary` record carry a clock, so the same search
	/// run twice never produces the same bytes. Dropping the two duration fields
	/// and keeping everything else is what makes a comparison between two flag
	/// spellings meaningful: the counts, the paths, the line numbers, the
	/// offsets and the submatch spans all survive.
	fn without_clocks(stdout: &str) -> Vec<serde_json::Value> {
		fn strip(value: &mut serde_json::Value) {
			if let Some(map) = value.as_object_mut() {
				map.remove("elapsed");
				map.remove("elapsed_total");
				for field in map.values_mut() {
					strip(field);
				}
			}
		}
		stdout
			.lines()
			.map(|line| {
				let mut value: serde_json::Value =
					serde_json::from_str(line).expect("every record should be JSON");
				strip(&mut value);
				value
			})
			.collect()
	}

	/// The output mode is one mutually exclusive group, and the last flag wins.
	///
	/// WHY THIS SUITE EXISTS. `--json` combined with any other output-selecting
	/// flag used to be REFUSED here, with `rg: --json cannot be combined with
	/// summary modes` and exit 2. ripgrep has no such diagnostic and no such
	/// refusal: it treats every one of these flags as a choice of output mode
	/// and lets the LAST one on the command line win. A script that ran `rg
	/// --json -c` got a hard failure from this builtin where ripgrep prints a
	/// count. The rest of the group was no better: it resolved by a fixed
	/// precedence written into `search_options` as a chain of `&& !` guards, so
	/// `-c -l` and `-l -c` gave the same answer where ripgrep gives two
	/// different ones.
	///
	/// Every expectation below was measured against ripgrep 15.1.0 on the same
	/// three-line fixture, in BOTH orders, before it was written down.
	mod the_last_output_mode_flag_on_the_command_line_wins {
		use super::*;

		/// A tree with one matching file and one that matches nothing.
		///
		/// Two files, because `--files-without-match` and the `searches` count in
		/// the summary record are only interesting when some file fails to match.
		fn fixture() -> TempTree {
			let root = unique_tree("rg-output-mode");
			std::fs::write(root.join("a.txt"), "alpha hit\nmiss\nhit two\nbeta\n")
				.expect("the matching fixture should be written");
			std::fs::write(root.join("b.txt"), "nothing here\n")
				.expect("the non-matching fixture should be written");
			root
		}

		/// Whether a run printed a JSON stream, judged on the first byte.
		///
		/// Every JSON record is an object and no other mode's first byte is `{`,
		/// so this tells the two apart without reparsing.
		fn is_json(stdout: &str) -> bool {
			stdout.starts_with('{')
		}

		/// `--json` first, then a mode: the mode wins and the output is its own.
		///
		/// The exact bytes, not just "not JSON", because the point is that the
		/// caller gets the answer the LAST flag asked for.
		#[test]
		fn a_mode_named_after_json_replaces_it_entirely() {
			let root = fixture();
			for (flag, expected) in [("-c", "2\n"), ("--count-matches", "2\n"), ("-l", "a.txt\n")] {
				let (code, stdout, stderr) = run_rg_in(&["--json", flag, "hit", "a.txt"], "", &root);

				assert_eq!(code, 0, "--json {flag}: {stderr}");
				assert_eq!(stdout, expected, "--json {flag} should print {expected:?}");
				assert_eq!(stderr, "", "--json {flag} should print no diagnostic");
			}
		}

		/// `--files-without-match` after `--json` lists the file that missed.
		///
		/// Separate from the loop above because it needs the second operand and
		/// because its exit code is the one that reports what was LISTED.
		#[test]
		fn files_without_match_named_after_json_lists_the_file_that_missed() {
			let root = fixture();

			let (code, stdout, stderr) =
				run_rg_in(&["--json", "--files-without-match", "hit", "a.txt", "b.txt"], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "b.txt\n");
			assert_eq!(stderr, "");
		}

		/// `--files` wins as a mode, and the proof is what it does to the
		/// operands.
		///
		/// `--files` takes no pattern, so once it has won, the word that would
		/// have been the pattern is a PATH. `rg --json --files hit a.txt`
		/// therefore reports `hit` as missing and still lists `a.txt`, exiting
		/// 2. That is a stronger signal than "the output is not JSON": it can
		/// only happen if the mode really changed. Measured on ripgrep 15.1.0,
		/// both halves.
		#[test]
		fn files_named_after_json_takes_the_pattern_as_a_path() {
			let root = fixture();

			let (code, stdout, stderr) = run_rg_in(&["--json", "--files", "hit", "a.txt"], "", &root);
			assert_eq!(code, 2, "the missing operand is an error");
			assert_eq!(stdout, "a.txt\n", "the operand that does exist is still listed");
			assert_eq!(stderr, "rg: hit: No such file or directory (os error 2)\n");

			let (code, stdout, stderr) = run_rg_in(&["--json", "--files", "a.txt"], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a.txt\n");
			assert_eq!(stderr, "");
		}

		/// `--json` last beats every one of them.
		///
		/// The other half of the rule, and the half a fixed precedence table gets
		/// wrong: it is not that JSON always loses, it is that order decides.
		#[test]
		fn json_named_last_beats_every_other_mode() {
			let root = fixture();
			for flag in ["-c", "--count-matches", "-l", "--files-without-match", "--files"] {
				let (code, stdout, stderr) = run_rg_in(&[flag, "--json", "hit", "a.txt"], "", &root);

				assert_eq!(code, 0, "{flag} --json: {stderr}");
				assert!(is_json(&stdout), "{flag} --json should print JSON: {stdout:?}");
				assert!(
					stdout.contains("\"type\":\"match\""),
					"{flag} --json should carry match records: {stdout:?}"
				);
			}
		}

		/// `--type-list` and `--json` override each other too.
		///
		/// `--type-list` never searches, which is exactly why it was in the
		/// refusal set rather than in the group. It is in the group in ripgrep:
		/// `rg -c --type-list` prints the type list and `rg --type-list -c` runs
		/// a search, and with no pattern to run it that search fails with
		/// ripgrep's own missing-pattern sentence.
		#[test]
		fn type_list_is_a_mode_like_the_others() {
			let root = fixture();

			let (code, stdout, stderr) = run_rg_in(&["-c", "--type-list"], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert!(
				stdout.starts_with("ada: *.adb, *.ads\n"),
				"--type-list last should print the list: {:?}",
				&stdout[..stdout.len().min(60)]
			);

			let (code, stdout, stderr) = run_rg_in(&["--type-list", "-c"], "", &root);
			assert_eq!(code, 2, "a count with no pattern cannot run");
			assert_eq!(stdout, "");
			assert_eq!(stderr, "rg: ripgrep requires at least one pattern to execute a search\n");

			let (code, stdout, stderr) = run_rg_in(&["--json", "--type-list"], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert!(!is_json(&stdout), "--type-list last is not a JSON stream: {stdout:?}");
		}

		/// The modes override EACH OTHER, not only `--json`.
		///
		/// Four ordered pairs, each with both answers spelled out, because the
		/// fixed-precedence version this replaced returned the same answer for
		/// both members of every pair.
		#[test]
		fn every_ordered_pair_of_modes_answers_with_its_last_member() {
			let root = fixture();
			// Two operands, so the count lines carry their path: `-c` over more than
			// one file prints `a.txt:2` and not `2`, and asserting the bare number
			// here would be asserting a shape ripgrep does not print.
			for (first, second, expected) in [
				("-c", "-l", "a.txt\n"),
				("-l", "-c", "a.txt:2\n"),
				("-l", "--files-without-match", "b.txt\n"),
				("--files-without-match", "-l", "a.txt\n"),
				("-c", "--count-matches", "a.txt:2\n"),
			] {
				let (code, stdout, stderr) =
					run_rg_in(&[first, second, "hit", "a.txt", "b.txt"], "", &root);

				assert_eq!(code, 0, "{first} {second}: {stderr}");
				assert_eq!(stdout, expected, "{first} {second} should print {expected:?}");
			}
		}

		/// Inside a CLUSTER the rightmost letter wins.
		///
		/// The two flags share one argv position, so a rule implemented by
		/// comparing argv indices alone would tie here and pick by luck. clap
		/// resolves a cluster left to right, which is what ripgrep does:
		/// measured, `-cl` lists and `-lc` counts.
		#[test]
		fn the_rightmost_letter_of_a_cluster_wins() {
			let root = fixture();

			let (code, stdout, stderr) = run_rg_in(&["-cl", "hit", "a.txt"], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a.txt\n", "-cl ends in -l, so it lists");

			let (code, stdout, stderr) = run_rg_in(&["-lc", "hit", "a.txt"], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2\n", "-lc ends in -c, so it counts");
		}

		/// Repeating a mode flag is not an error.
		///
		/// It cannot be, once the group exists: the group is what makes a repeat
		/// override its own earlier self rather than collide with it.
		#[test]
		fn a_repeated_mode_flag_is_accepted() {
			let root = fixture();

			let (code, stdout, stderr) = run_rg_in(&["--json", "--json", "hit", "a.txt"], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert!(is_json(&stdout), "two --json flags still mean JSON: {stdout:?}");

			let (code, stdout, stderr) = run_rg_in(&["-c", "-c", "hit", "a.txt"], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2\n");
		}

		/// `-q`, `-o` and `--vimgrep` are NOT modes and never win.
		///
		/// This is the boundary of the group, and it is the part that is easy to
		/// get wrong in the other direction: all three were in the refusal set,
		/// so a reading that turned the refusal set into the group would put
		/// them in it. Measured, ripgrep prints the SAME JSON bytes for
		/// `--json`, `--json -o` and `--json --vimgrep`, because in JSON mode
		/// both formatting flags are ignored outright.
		#[test]
		fn the_formatting_flags_are_not_modes_and_are_ignored_in_json_mode() {
			let root = fixture();
			let plain = run_rg_in(&["--json", "hit", "a.txt"], "", &root).1;
			let plain_records = without_clocks(&plain);
			assert_eq!(plain_records.len(), 5, "begin, two matches, end, summary");

			for flag in ["-o", "--vimgrep"] {
				let (code, stdout, stderr) = run_rg_in(&["--json", flag, "hit", "a.txt"], "", &root);

				assert_eq!(code, 0, "--json {flag}: {stderr}");
				assert_eq!(
					without_clocks(&stdout),
					plain_records,
					"--json {flag} should print the same records as --json alone"
				);
			}
		}
	}

	/// `--no-json` cancels a `--json` that came before it, and nothing else.
	///
	/// WHY THIS SUITE EXISTS. `--no-json` was declared as a plain clap override
	/// pair with `--json`, which makes it unconditional: whichever came last
	/// won. ripgrep's rule is narrower and measurably different, because
	/// `--no-json` switches the mode back to the standard one only when the
	/// mode is CURRENTLY JSON. So `rg -c --json --no-json` prints lines and `rg
	/// --json -c --no-json` prints a count, and an unconditional override
	/// prints lines for both.
	mod no_json_only_cancels_the_json_that_won {
		use super::*;

		fn fixture() -> TempTree {
			let root = unique_tree("rg-no-json");
			std::fs::write(root.join("a.txt"), "alpha hit\nmiss\nhit two\nbeta\n")
				.expect("the fixture should be written");
			root
		}

		/// The four orderings that decide the rule, with their measured answers.
		#[test]
		fn the_cancel_counts_only_when_it_follows_the_winning_json() {
			let root = fixture();
			for (args, expected, why) in [
				(
					vec!["--json", "--no-json", "hit", "a.txt"],
					"alpha hit\nhit two\n",
					"the cancel follows the --json it cancels",
				),
				(
					vec!["-c", "--json", "--no-json", "hit", "a.txt"],
					"alpha hit\nhit two\n",
					"--json had beaten -c, so cancelling it leaves the standard mode",
				),
				(
					vec!["--json", "-c", "--no-json", "hit", "a.txt"],
					"2\n",
					"-c had already beaten --json, so there was no JSON left to cancel",
				),
				(
					vec!["--json", "--no-json", "-c", "hit", "a.txt"],
					"2\n",
					"-c is named after both and wins outright",
				),
			] {
				let (code, stdout, stderr) = run_rg_in(&args, "", &root);

				assert_eq!(code, 0, "{args:?}: {stderr}");
				assert_eq!(stdout, expected, "{args:?}: {why}");
			}
		}

		/// A `--json` after the cancel is JSON again.
		///
		/// The rule is a comparison against the LAST `--json`, not against the
		/// first one, so a third flag has to be able to win the mode back.
		#[test]
		fn a_later_json_wins_the_mode_back() {
			let root = fixture();
			for args in [
				vec!["--json", "--no-json", "--json", "hit", "a.txt"],
				vec!["-c", "--json", "--no-json", "--json", "hit", "a.txt"],
				vec!["--no-json", "--json", "hit", "a.txt"],
			] {
				let (code, stdout, stderr) = run_rg_in(&args, "", &root);

				assert_eq!(code, 0, "{args:?}: {stderr}");
				assert!(stdout.starts_with('{'), "{args:?} should print JSON: {stdout:?}");
			}
		}

		/// `--no-json` on its own changes nothing.
		///
		/// NON-VACUITY for the whole suite: the flag is a no-op without a
		/// `--json` to cancel, so none of the cases above pass by accident of
		/// `--no-json` breaking the run.
		#[test]
		fn the_cancel_alone_is_a_no_op() {
			let root = fixture();
			let plain = run_rg_in(&["hit", "a.txt"], "", &root);
			let cancelled = run_rg_in(&["--no-json", "hit", "a.txt"], "", &root);

			assert_eq!(cancelled.0, plain.0);
			assert_eq!(cancelled.1, plain.1);
			assert_eq!(cancelled.1, "alpha hit\nhit two\n");
		}
	}

	/// The `summary` record that closes a `--json` stream, field by field.
	///
	/// WHY THIS SUITE EXISTS. The record was hand-rolled here rather than taken
	/// from `grep-printer` like the other four, and it had drifted from
	/// ripgrep's in two ways a consumer sees immediately: `elapsed_total` was
	/// MISSING, so the question "how long did the run take" read `undefined`,
	/// and every `human` string was Rust's `Debug` for a `Duration`
	/// (`14.197\u{b5}s`) where ripgrep prints six decimal seconds
	/// (`0.000014s`).
	mod the_json_summary_record_matches_ripgreps_own {
		use super::*;

		fn fixture() -> TempTree {
			let root = unique_tree("rg-json-summary");
			std::fs::write(root.join("a.txt"), "alpha hit\nmiss\nhit two\nbeta\n")
				.expect("the matching fixture should be written");
			std::fs::write(root.join("b.txt"), "nothing here\n")
				.expect("the non-matching fixture should be written");
			root
		}

		/// The whole record, byte for byte, with only the two timings read back
		/// out of it.
		///
		/// Rebuilding the expected line from the record's OWN durations is what
		/// makes this a byte assertion rather than a field-by-field one: it pins
		/// every key name, the order of every key, and the absence of any extra
		/// key, while letting the clock be whatever it was. The order is part of
		/// the contract and it is not the order the other records use: `summary`
		/// prints `data` before `type` and sorts every field inside it, down to
		/// `human`, `nanos`, `secs`, because ripgrep serializes this one record
		/// through a map instead of a struct.
		#[test]
		fn the_record_is_byte_for_byte_ripgreps_shape() {
			let root = fixture();
			let (code, stdout, stderr) = run_rg_in(&["--json", "hit", "a.txt", "b.txt"], "", &root);
			assert_eq!(code, 0, "{stderr}");

			let line = stdout
				.lines()
				.last()
				.expect("the stream ends with a record");
			let value: serde_json::Value =
				serde_json::from_str(line).expect("the summary record should be JSON");
			let total = &value["data"]["elapsed_total"];
			let searching = &value["data"]["stats"]["elapsed"];
			// The shape as ripgrep prints it, as separate literals so no reflow can
			// break an escape, with the seven volatile numbers left as placeholders.
			// Everything else is asserted verbatim, key names and key ORDER included.
			let shape = concat!(
				"{\"data\":{\"elapsed_total\":{\"human\":\"{H1}\",\"nanos\":{N1},\"secs\":{S1}},",
				"\"stats\":{\"bytes_printed\":{BP},\"bytes_searched\":41,",
				"\"elapsed\":{\"human\":\"{H2}\",\"nanos\":{N2},\"secs\":{S2}},",
				"\"matched_lines\":2,\"matches\":2,\"searches\":2,\"searches_with_match\":1}},",
				"\"type\":\"summary\"}"
			);
			let expected = shape
				.replace("{H1}", total["human"].as_str().expect("a human string"))
				.replace("{N1}", &total["nanos"].to_string())
				.replace("{S1}", &total["secs"].to_string())
				.replace("{BP}", &value["data"]["stats"]["bytes_printed"].to_string())
				.replace("{H2}", searching["human"].as_str().expect("a human string"))
				.replace("{N2}", &searching["nanos"].to_string())
				.replace("{S2}", &searching["secs"].to_string());

			assert_eq!(line, expected);
		}

		/// `human` is the six-decimal seconds rendering of `secs`/`nanos`.
		///
		/// Derived from the record's own numbers, so the two halves cannot drift
		/// apart: this is the assertion the `Debug` rendering failed.
		#[test]
		fn human_is_six_decimal_seconds_of_the_same_duration() {
			let root = fixture();
			let (_, stdout, _) = run_rg_in(&["--json", "hit", "a.txt"], "", &root);
			let line = stdout.lines().last().expect("a summary record");
			let value: serde_json::Value = serde_json::from_str(line).expect("JSON");

			for field in ["elapsed_total", "stats"] {
				let duration = if field == "stats" {
					&value["data"]["stats"]["elapsed"]
				} else {
					&value["data"]["elapsed_total"]
				};
				let secs = duration["secs"].as_u64().expect("secs");
				let nanos = duration["nanos"].as_u64().expect("nanos");
				let human = duration["human"].as_str().expect("human");
				let expected = format!("{:.6}s", secs as f64 + nanos as f64 / 1e9);

				assert_eq!(human, expected, "{field} human should be {expected}");
				assert!(nanos < 1_000_000_000, "{field} nanos is the sub-second part");
			}
		}

		/// A run that matched nothing still ends with the record, and exits 1.
		///
		/// The record is then the ENTIRE output, which is the case where a
		/// consumer waiting for it would hang if it were withheld.
		#[test]
		fn a_run_with_no_match_is_the_summary_record_alone() {
			let root = fixture();

			let (code, stdout, stderr) = run_rg_in(&["--json", "zzz", "a.txt"], "", &root);

			assert_eq!(code, 1, "nothing matched");
			assert_eq!(stderr, "");
			assert_eq!(stdout.lines().count(), 1, "one record only: {stdout:?}");
			let value: serde_json::Value = serde_json::from_str(stdout.trim_end()).expect("JSON");
			assert_eq!(value["type"], "summary");
			assert_eq!(value["data"]["stats"]["matches"], 0);
			assert_eq!(value["data"]["stats"]["searches"], 1);
			assert_eq!(value["data"]["stats"]["searches_with_match"], 0);
			assert_eq!(value["data"]["stats"]["bytes_searched"], 28);
			assert_eq!(value["data"]["stats"]["bytes_printed"], 0);
		}

		/// A file that matched nothing gets NO `begin` or `end` record.
		///
		/// So the record sequence is not one pair per operand, and a consumer
		/// counting pairs to learn how many files were searched has to read
		/// `searches` in the summary instead. That number is what this asserts.
		#[test]
		fn only_a_matching_file_gets_a_begin_and_end_pair() {
			let root = fixture();
			let (code, stdout, stderr) = run_rg_in(&["--json", "hit", "a.txt", "b.txt"], "", &root);
			assert_eq!(code, 0, "{stderr}");

			let kinds: Vec<String> = stdout
				.lines()
				.map(|line| {
					serde_json::from_str::<serde_json::Value>(line).expect("JSON")["type"]
						.as_str()
						.expect("a type")
						.to_string()
				})
				.collect();

			assert_eq!(kinds, ["begin", "match", "match", "end", "summary"]);
			let value: serde_json::Value =
				serde_json::from_str(stdout.lines().last().expect("a record")).expect("JSON");
			assert_eq!(value["data"]["stats"]["searches"], 2, "both files were searched");
			assert_eq!(value["data"]["stats"]["searches_with_match"], 1);
		}

		/// `-q` in JSON mode prints the summary record and nothing else, and the
		/// numbers still describe the WHOLE search.
		///
		/// Two rules in one case, and both were wrong. The records were printed,
		/// because `-q` was handled by a sink the JSON path never reaches; and
		/// the search stopped at the first match, because the early-exit
		/// predicate asked `!stats` when the question is whether the run has to
		/// report numbers at all. Measured on ripgrep 15.1.0: the record reads
		/// `matches: 2`, `searches: 2` and `bytes_searched: 41`, which is every
		/// byte of both files, with `bytes_printed: 0` because nothing was
		/// written.
		#[test]
		fn quiet_prints_the_summary_alone_and_still_searches_everything() {
			let root = fixture();

			let (code, stdout, stderr) =
				run_rg_in(&["--json", "-q", "hit", "a.txt", "b.txt"], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stderr, "");
			assert_eq!(stdout.lines().count(), 1, "the summary record alone: {stdout:?}");
			let value: serde_json::Value = serde_json::from_str(stdout.trim_end()).expect("JSON");
			assert_eq!(value["type"], "summary");
			assert_eq!(value["data"]["stats"]["matches"], 2, "both matches were found");
			assert_eq!(value["data"]["stats"]["matched_lines"], 2);
			assert_eq!(value["data"]["stats"]["searches"], 2, "both files were searched");
			assert_eq!(value["data"]["stats"]["bytes_searched"], 41, "every byte of both");
			assert_eq!(value["data"]["stats"]["bytes_printed"], 0, "nothing was written");
		}

		/// NON-VACUITY for the case above: without `-q` the same run prints the
		/// records, so the assertion on `lines().count() == 1` is about `-q` and
		/// not about a JSON stream that stopped working.
		#[test]
		fn the_same_run_without_quiet_prints_every_record() {
			let root = fixture();

			let (_, stdout, _) = run_rg_in(&["--json", "hit", "a.txt", "b.txt"], "", &root);

			assert_eq!(stdout.lines().count(), 5, "begin, two matches, end, summary");
		}

		/// `--json -A1` emits `context` records, a fifth record type.
		///
		/// They carry an EMPTY `submatches` array rather than no field, which is
		/// how a consumer tells a context line from a match line without looking
		/// at the record type.
		#[test]
		fn context_lines_are_their_own_record_type() {
			let root = fixture();
			let (code, stdout, stderr) = run_rg_in(&["--json", "-A1", "hit", "a.txt"], "", &root);
			assert_eq!(code, 0, "{stderr}");

			let records: Vec<serde_json::Value> = stdout
				.lines()
				.map(|line| serde_json::from_str(line).expect("JSON"))
				.collect();
			let kinds: Vec<&str> = records
				.iter()
				.map(|r| r["type"].as_str().expect("a type"))
				.collect();

			assert_eq!(kinds, ["begin", "match", "context", "match", "context", "end", "summary"]);
			assert_eq!(records[2]["data"]["lines"]["text"], "miss\n");
			assert_eq!(records[2]["data"]["line_number"], 2);
			assert_eq!(records[2]["data"]["absolute_offset"], 10);
			assert_eq!(
				records[2]["data"]["submatches"],
				serde_json::json!([]),
				"a context record carries an empty submatch list, not a missing one"
			);
		}
	}

	/// `--generate` writes the man page and the four completion scripts.
	///
	/// WHY THIS SUITE EXISTS. The help text is ripgrep's, so it PROMISED
	/// `--generate=KIND`, and the flag was not declared: `rg --generate man`
	/// answered `rg: unrecognized flag --generate` and exited 2. A flag the help
	/// advertises and the tool refuses is worse than an absent one, because the
	/// caller has no way to tell a typo from a lie.
	///
	/// The artifacts are generated from `uu_app()`, the same clap command the
	/// parser uses, which is a DELIBERATE divergence from ripgrep's own bytes:
	/// ripgrep's completions describe ripgrep's larger flag table, and shipping
	/// those here would tell the shell to offer flags this builtin refuses. The
	/// assertions below are therefore about the artifacts being real and about
	/// them agreeing with the flag table, not about matching ripgrep byte for
	/// byte.
	mod generate_writes_a_man_page_and_completion_scripts {
		use super::*;

		/// Every kind, with the anchor that proves the right generator ran.
		///
		/// Each anchor is a construct only that one output has: a `.TH` header
		/// for roff, `complete -F` for bash, `#compdef` for zsh, `complete -c`
		/// for fish, and the namespace import for PowerShell. A generator wired
		/// to the wrong shell passes no other test as cleanly as it fails this
		/// one.
		#[test]
		fn each_kind_writes_its_own_dialect() {
			for (kind, anchor) in [
				("man", ".TH"),
				("complete-bash", "complete -F _rg"),
				("complete-zsh", "#compdef rg"),
				("complete-fish", "complete -c rg"),
				("complete-powershell", "using namespace System.Management.Automation"),
			] {
				let (code, stdout, stderr) = run_rg(&["--generate", kind], "");

				assert_eq!(code, 0, "--generate {kind}: {stderr}");
				assert_eq!(stderr, "", "--generate {kind} writes nothing to stderr");
				assert!(
					stdout.contains(anchor),
					"--generate {kind} should contain {anchor:?}: {:?}",
					&stdout[..stdout.len().min(120)]
				);
			}
		}

		/// Each artifact is substantial, so an empty or truncated write fails.
		///
		/// The floor is deliberately far below what the real output is (the man
		/// page is tens of kilobytes) and far above what a stub could produce.
		#[test]
		fn no_kind_writes_a_stub() {
			for kind in
				["man", "complete-bash", "complete-zsh", "complete-fish", "complete-powershell"]
			{
				let (_, stdout, _) = run_rg(&["--generate", kind], "");

				assert!(stdout.len() > 2_000, "--generate {kind} wrote only {} bytes", stdout.len());
			}
		}

		/// The man page names the tool and its version, and documents flags.
		///
		/// Real values, not a shape check: the `.TH` line has to carry `RG` and
		/// the version this builtin reports, and the body has to mention flags a
		/// reader would look up.
		#[test]
		fn the_man_page_names_the_tool_and_documents_flags() {
			let (code, stdout, stderr) = run_rg(&["--generate", "man"], "");
			assert_eq!(code, 0, "{stderr}");

			// Not the FIRST line: roff needs a preamble defining the quote escapes
			// before any content, so the title header is the first `.TH` line.
			let title = stdout
				.lines()
				.find(|line| line.starts_with(".TH"))
				.expect("the man page should have a title header");
			assert!(title.contains("rg") || title.contains("RG"), "it names the tool: {title:?}");
			assert!(stdout.contains("15.1.0"), "the version this builtin reports is in the page");
			// roff escapes a hyphen as `\-`, so a flag is written `\-\-json` in the
			// page. Looking for the plain spelling finds nothing, which is a way to
			// write a coverage check that silently passes on an empty page.
			for flag in ["json", "generate", "max-filesize", "type-add", "vimgrep"] {
				let roff = format!("\\-\\-{}", flag.replace('-', "\\-"));
				assert!(stdout.contains(&roff), "the man page should document --{flag} as {roff}");
			}
		}

		/// Every long flag this builtin ACCEPTS is offered by every completion.
		///
		/// This is the contract the artifacts exist for, and it is the one a
		/// hand-written script cannot keep: the completion is derived from the
		/// same command the parser uses, so the two cannot drift. A flag added
		/// to `RgCli` without a thought for completion still shows up here.
		#[test]
		fn every_declared_long_flag_reaches_every_generated_artifact() {
			let declared = visible_longs();
			assert!(declared.len() > 80, "the flag table is large: {} flags", declared.len());

			// Each dialect spells a long option its own way, so the token to look for
			// is the artifact's and not one shape for all five: fish writes `-l json`
			// rather than `--json`, and roff escapes every hyphen.
			for kind in
				["man", "complete-bash", "complete-zsh", "complete-fish", "complete-powershell"]
			{
				let (_, stdout, _) = run_rg(&["--generate", kind], "");
				let missing: Vec<String> = declared
					.iter()
					.map(|long| match kind {
						"man" => format!("\\-\\-{}", long.replace('-', "\\-")),
						"complete-fish" => format!("-l {long}"),
						_ => format!("--{long}"),
					})
					.filter(|token| !stdout.contains(token.as_str()))
					.collect();

				assert!(missing.is_empty(), "--generate {kind} is missing {missing:?}");
			}
		}

		/// Every long flag `RgCli` declares and does NOT hide, without its
		/// dashes.
		fn visible_longs() -> Vec<String> {
			uu_app()
				.get_arguments()
				.filter(|arg| !arg.is_hide_set())
				.filter_map(|arg| arg.get_long().map(std::string::ToString::to_string))
				.collect()
		}

		/// Every long flag `RgCli` hides, without its dashes.
		fn hidden_longs() -> Vec<String> {
			uu_app()
				.get_arguments()
				.filter(|arg| arg.is_hide_set())
				.filter_map(|arg| arg.get_long().map(std::string::ToString::to_string))
				.collect()
		}

		/// A hidden negation is left out of the man page and still completes.
		///
		/// Both halves are ripgrep's behaviour, measured: its man page has no
		/// `--no-json` at all, while every one of its four completion scripts
		/// offers it. That split is deliberate rather than an accident of the
		/// generator, so it is asserted both ways round. The third half is the
		/// one that matters most: hidden is not the same as unsupported, so
		/// each hidden flag is parsed here too, which is what stops "hide it"
		/// from becoming a way to retire a flag without saying so.
		#[test]
		fn a_hidden_flag_is_absent_from_the_man_page_and_present_everywhere_else() {
			let hidden = hidden_longs();
			assert_eq!(hidden.len(), 8, "the hidden flags are the eight negations: {hidden:?}");
			assert!(hidden.iter().any(|long| long == "no-json"));
			// The buffering negations are hidden for the same reason the others are,
			// and are named here so the count above cannot be satisfied by some
			// unrelated flag acquiring `hide`.
			assert!(hidden.iter().any(|long| long == "no-line-buffered"));
			assert!(hidden.iter().any(|long| long == "no-block-buffered"));

			let (_, man, _) = run_rg(&["--generate", "man"], "");
			for long in &hidden {
				let roff = format!("\\-\\-{}", long.replace('-', "\\-"));
				assert!(!man.contains(&roff), "the man page should not document --{long}");
			}

			for kind in ["complete-bash", "complete-zsh", "complete-fish", "complete-powershell"] {
				let (_, script, _) = run_rg(&["--generate", kind], "");
				for long in &hidden {
					let token = if kind == "complete-fish" {
						format!("-l {long}")
					} else {
						format!("--{long}")
					};
					assert!(script.contains(&token), "--generate {kind} should offer --{long}");
				}
			}

			for long in &hidden {
				let flag = format!("--{long}");
				let (code, _, stderr) = run_rg(&[flag.as_str(), "hit"], "hit\n");
				assert_ne!(code, 2, "{flag} is hidden, not refused: {stderr}");
			}
		}

		/// A kind the tool does not know is refused in ripgrep's words.
		///
		/// One line, no usage block, and the phrase `unrecognized_choice` owns,
		/// so `--generate` and `--color` word a rejected choice identically.
		/// The uppercase spelling is included because the kinds are case
		/// SENSITIVE: `MAN` is a mistake, and accepting it would be a second
		/// spelling table.
		#[test]
		fn an_unknown_kind_is_refused_in_ripgreps_words() {
			for kind in ["nope", "MAN", "complete-elvish", "complete-bash-extra"] {
				let (code, stdout, stderr) = run_rg(&["--generate", kind], "");

				assert_eq!(code, 2, "--generate {kind} should be refused");
				assert_eq!(stdout, "", "--generate {kind} should write nothing");
				assert_eq!(
					stderr,
					format!("rg: error parsing flag --generate: choice '{kind}' is unrecognized\n")
				);
			}
		}

		/// `--generate` with no value is the missing-value diagnostic.
		#[test]
		fn a_missing_kind_reports_the_missing_value() {
			let (code, stdout, stderr) = run_rg(&["--generate"], "");

			assert_eq!(code, 2);
			assert_eq!(stdout, "");
			assert_eq!(
				stderr,
				"rg: missing value for flag --generate: missing argument for option '--generate'\n"
			);
		}

		/// A value starting with a hyphen is a KIND, not the next flag.
		///
		/// Every value-taking flag here carries `allow_hyphen_values` because
		/// ripgrep always takes the next argument, so `rg --generate -c` is a bad
		/// kind rather than a `--generate` with its value left off. Getting this
		/// wrong turns a typo into the wrong diagnostic.
		#[test]
		fn a_hyphen_value_is_read_as_the_kind() {
			let (code, stdout, stderr) = run_rg(&["--generate", "-c"], "");

			assert_eq!(code, 2);
			assert_eq!(stdout, "");
			assert_eq!(stderr, "rg: error parsing flag --generate: choice '-c' is unrecognized\n");
		}

		/// Operands are ignored, so no pattern is required.
		///
		/// `--generate` looks at nothing after itself, which is why it short
		/// circuits before the operands are resolved. Measured on ripgrep 15.1.0:
		/// `rg --generate man hit a.txt` writes the same bytes as `rg --generate
		/// man`, and neither needs a pattern.
		#[test]
		fn the_operands_are_ignored_and_no_pattern_is_needed() {
			let bare = run_rg(&["--generate", "man"], "");
			let with_operands = run_rg(&["--generate", "man", "hit", "nosuchfile.txt"], "");

			assert_eq!(with_operands.0, 0, "{}", with_operands.2);
			assert_eq!(with_operands.2, "", "a missing operand is never opened");
			assert_eq!(with_operands.1, bare.1, "the same bytes either way");
		}

		/// `--generate` is an output mode, so the last mode flag still wins.
		///
		/// Measured in both orders: `rg -c --generate man` writes the man page,
		/// and `rg --generate man -c` runs a count, which with no pattern is the
		/// missing-pattern error. That is what puts `generate` in
		/// `OUTPUT_MODE_FLAGS` rather than in a check of its own.
		#[test]
		fn it_is_a_mode_and_loses_to_a_later_one() {
			let (code, stdout, stderr) = run_rg(&["-c", "--generate", "man"], "");
			assert_eq!(code, 0, "{stderr}");
			assert!(stdout.contains("\n.TH"), "--generate last writes the man page");

			let (code, stdout, stderr) = run_rg(&["--generate", "man", "-c"], "");
			assert_eq!(code, 2, "a count with no pattern cannot run");
			assert_eq!(stdout, "");
			assert_eq!(stderr, "rg: ripgrep requires at least one pattern to execute a search\n");

			let (code, stdout, stderr) =
				run_rg(&["--generate", "complete-bash", "--json", "hit"], "hit\n");
			assert_eq!(code, 0, "{stderr}");
			assert!(stdout.starts_with('{'), "--json last searches: {stdout:?}");
		}
	}

	/// `--no-messages` reaches every mode that can print a diagnostic.
	///
	/// WHY THIS SUITE EXISTS. `--no-messages` is the one flag whose entire job
	/// is silencing stderr, and `--files` ignored it. Both diagnostics in
	/// `list_files`, the unreadable-operand one and the failed-walk one, wrote
	/// unconditionally, because that function has no `SearchOptions` and the
	/// two-flag rule (`--messages` undoes an earlier `--no-messages`, so the
	/// later flag wins) lived inline in the options builder where `list_files`
	/// could not see it. A second derivation was never added; the check was
	/// simply absent.
	///
	/// PROBED AGAINST REAL RIPGREP 15.1.0 before any of this was written:
	/// `rg --files nosuchdir` prints `rg: nosuchdir: IO error for operation on
	/// nosuchdir: No such file or directory ...` and exits 2, while
	/// `rg --files --no-messages nosuchdir` prints NOTHING and still exits 2.
	/// So the flag suppresses the message and does NOT touch the status, which
	/// is the pair every case below asserts together. Asserting silence alone
	/// would pass for an implementation that stopped reporting the failure.
	///
	/// The rule now has one owner, `no_messages_for`, used by the options
	/// builder and by `list_files`.
	mod no_messages_reaches_every_mode {
		use super::*;

		/// A path that cannot be stat'ed: the operand-level diagnostic.
		#[test]
		fn files_mode_reports_an_unreadable_operand_and_silences_it_on_request() {
			let tree = unique_tree("files-missing");

			let (code, stdout, stderr) = run_rg_in(&["--files", "nosuchdir"], "", &tree);
			assert_eq!(code, 2, "a missing operand is an error");
			assert_eq!(stdout, "", "nothing to list");
			assert!(
				stderr.starts_with("rg: nosuchdir: "),
				"the diagnostic names the tool then the operand: {stderr:?}"
			);

			let (quiet_code, quiet_stdout, quiet_stderr) =
				run_rg_in(&["--files", "--no-messages", "nosuchdir"], "", &tree);
			assert_eq!(quiet_stderr, "", "--no-messages must silence it");
			assert_eq!(quiet_code, 2, "and must NOT change the status");
			assert_eq!(quiet_stdout, "", "still nothing to list");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// `--messages` after `--no-messages` puts the diagnostic back, which is
		/// the half of the rule a single boolean field would have lost. Without
		/// this case an implementation reading only `cli.no_messages` passes.
		#[test]
		fn a_later_messages_flag_undoes_an_earlier_no_messages() {
			let tree = unique_tree("files-undo");

			let (code, _, stderr) =
				run_rg_in(&["--files", "--no-messages", "--messages", "nosuchdir"], "", &tree);
			assert_eq!(code, 2);
			assert!(
				stderr.starts_with("rg: nosuchdir: "),
				"--messages must restore the diagnostic: {stderr:?}"
			);

			let _ = std::fs::remove_dir_all(tree);
		}

		/// NON-VACUITY, and the reason the case above is not circular:
		/// `--files` on a directory that IS readable lists it and prints nothing
		/// on stderr either way. A gate that only ever saw failures could not
		/// tell "silenced" from "broken".
		#[test]
		fn files_mode_still_lists_a_readable_directory_under_no_messages() {
			let tree = unique_tree("files-ok");
			std::fs::write(tree.join("alpha.txt"), "a\n").expect("fixture written");

			for args in [&["--files", "."][..], &["--files", "--no-messages", "."][..]] {
				let (code, stdout, stderr) = run_rg_in(args, "", &tree);
				assert_eq!(code, 0, "a readable directory is not an error: {stderr:?}");
				assert_eq!(stdout, "./alpha.txt\n", "the file is listed for {args:?}");
				assert_eq!(stderr, "", "a successful listing says nothing");
			}

			let _ = std::fs::remove_dir_all(tree);
		}

		/// The SEARCH path already honoured the flag, and it must keep doing so:
		/// this is the behaviour `--files` was supposed to match, so it is
		/// asserted here rather than assumed, in the same shape.
		#[test]
		fn the_search_path_honours_the_same_flag() {
			let tree = unique_tree("search-missing");

			let (code, _, stderr) = run_rg_in(&["hit", "nosuchdir"], "", &tree);
			assert_eq!(code, 2, "a missing operand is an error");
			assert!(!stderr.is_empty(), "the search path reports it: {stderr:?}");

			let (quiet_code, _, quiet_stderr) =
				run_rg_in(&["--no-messages", "hit", "nosuchdir"], "", &tree);
			assert_eq!(quiet_stderr, "", "and silences it on request");
			assert_eq!(quiet_code, 2, "without changing the status");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// The rule at its one owner, with BOTH orders spelled out.
		///
		/// The order is the content of this rule, so the cases are written as
		/// literal argv rather than generated from a pair of booleans: a
		/// generator that appends `--no-messages` before `--messages` can only
		/// ever produce one of the two orders, and the order it cannot produce
		/// is the one that used to be wrong.
		#[test]
		fn the_flag_rule_has_one_owner_and_the_last_flag_wins() {
			for (args, expected) in [
				(&["hit"][..], false),
				(&["--no-messages", "hit"][..], true),
				(&["--messages", "hit"][..], false),
				(&["--no-messages", "--messages", "hit"][..], false),
				(&["--messages", "--no-messages", "hit"][..], true),
			] {
				let argv: Vec<OsString> = ["rg"]
					.into_iter()
					.chain(args.iter().copied())
					.map(OsString::from)
					.collect();
				let cli = RgCli::try_parse_from(argv).expect("the argv should parse");
				assert_eq!(no_messages_for(&cli), expected, "for {args:?}");
				// The options builder must agree with the owner rather than
				// deriving its own answer.
				assert_eq!(search_options(&cli).no_messages, expected, "SearchOptions must agree");
			}
		}
	}

	/// Every negatable flag pair resolves by ORDER, not by fixed precedence.
	///
	/// WHY THIS SUITE EXISTS. Thirteen pairs in this file were resolved by hand
	/// with a conjunction: `cli.trim && !cli.no_trim`, `cli.no_messages &&
	/// !cli.messages`, `cli.hidden && !cli.no_hidden`, and so on. Each of those
	/// picks a WINNER BY SIDE, so exactly one of the two orders is wrong, and
	/// which one depends on which side the author happened to put the `!`. Five
	/// of the thirteen also carried `overrides_with`, so the mechanism that
	/// resolves this correctly was already in the file, applied to some pairs
	/// and not the rest, with the redundant conjunction layered on top.
	///
	/// PROBED AGAINST RIPGREP 15.1.0 before anything changed. It is
	/// LAST-FLAG-WINS, uniformly:
	///
	/// - `--no-messages --messages nosuchdir` prints the diagnostic; `--messages
	///   --no-messages` prints nothing.
	/// - `--trim --no-trim` keeps the indentation; `--no-trim --trim` strips it.
	/// - `--hidden --no-hidden` skips dotfiles; `--no-hidden --hidden` finds
	///   them.
	/// - `-F --no-fixed-strings 'a.b'` matches `axb` as a regex;
	///   `--no-fixed-strings -F` matches only the literal `a.b`.
	/// - `-n -N` prints no line numbers; `-N -n` prints them.
	/// - `-i -s` searches case-sensitively; `-s -i` insensitively. The case
	///   group is three flags rather than a pair and is last-wins across all
	///   three. The comment here used to claim `--case-sensitive` beat both `-i`
	///   and `-S` because "the flag that asks for exactness wins", a documented
	///   belief the probe disproved.
	///
	/// Resolution now belongs entirely to clap, through `overrides_with` on
	/// every pair and `overrides_with_all` on the case trio, so the derivations
	/// are plain field reads and there is nowhere left to encode a precedence.
	mod negatable_flags_resolve_by_order {
		use super::*;

		/// The observable half for `--trim`, asserted as BYTES: the leading
		/// whitespace is either there or it is not.
		#[test]
		fn trim_follows_the_last_flag_in_the_output() {
			assert_eq!(run_rg(&["--trim", "xx"], "   xx\n").1, "xx\n", "--trim strips");
			assert_eq!(run_rg(&["--no-trim", "xx"], "   xx\n").1, "   xx\n", "--no-trim keeps");
			assert_eq!(
				run_rg(&["--trim", "--no-trim", "xx"], "   xx\n").1,
				"   xx\n",
				"--no-trim written last must win"
			);
			assert_eq!(
				run_rg(&["--no-trim", "--trim", "xx"], "   xx\n").1,
				"xx\n",
				"--trim written last must win"
			);
		}

		/// `-F` decides whether a pattern is a regex, so the wrong answer changes
		/// what MATCHES rather than how it is printed. `a.b` matches `axb` as a
		/// regex and only itself as a literal, which is the pair that makes the
		/// difference visible.
		#[test]
		fn fixed_strings_follows_the_last_flag_and_changes_what_matches() {
			let haystack = "a.b\naxb\n";
			assert_eq!(run_rg(&["-F", "a.b"], haystack).1, "a.b\n", "-F is literal");
			assert_eq!(
				run_rg(&["--no-fixed-strings", "a.b"], haystack).1,
				"a.b\naxb\n",
				"a regex matches both"
			);
			assert_eq!(
				run_rg(&["-F", "--no-fixed-strings", "a.b"], haystack).1,
				"a.b\naxb\n",
				"--no-fixed-strings last must restore the regex"
			);
			assert_eq!(
				run_rg(&["--no-fixed-strings", "-F", "a.b"], haystack).1,
				"a.b\n",
				"-F last must make it literal again"
			);
		}

		/// The case trio, which is three flags and not a pair. All six ordered
		/// combinations, because a two-flag rule cannot express `-i -S` and
		/// `-S -i` differing.
		#[test]
		fn the_case_trio_is_last_wins_across_all_three_flags() {
			let haystack = "Aa\naa\n";
			// -s: only the lowercase line. -i and -S (the pattern is all
			// lowercase, so smart case is insensitive): both lines.
			for (args, expected) in [
				(&["-i", "-s", "aa"][..], "aa\n"),
				(&["-s", "-i", "aa"][..], "Aa\naa\n"),
				(&["-i", "-S", "aa"][..], "Aa\naa\n"),
				(&["-S", "-i", "aa"][..], "Aa\naa\n"),
				(&["-s", "-S", "aa"][..], "Aa\naa\n"),
				(&["-S", "-s", "aa"][..], "aa\n"),
			] {
				assert_eq!(run_rg(args, haystack).1, expected, "for {args:?}");
			}
		}

		/// `-w` versus `-x`, WHERE RG AND GNU GREP DISAGREE, so neither builtin
		/// can borrow the other's rule.
		///
		/// PROBED ON BOTH, against the same fixture (`hit`, `hit there`,
		/// `xhitx`):
		///
		/// - `rg -w -x hit` matches only `hit`; `rg -x -w hit` matches `hit` AND
		///   `hit there`. Last-wins.
		/// - `grep -w -x hit` and `grep -x -w hit` BOTH match only `hit`. `-x`
		///   wins regardless of order.
		///
		/// This builtin therefore uses `overrides_with` while the `grep` builtin
		/// keeps a fixed precedence, and that difference is deliberate rather
		/// than an inconsistency. Ours used grep's rule here, so `rg -x -w`
		/// dropped the `hit there` line: fewer results, no error, from a flag
		/// the user wrote last precisely to ask for them.
		#[test]
		fn word_and_line_anchoring_is_last_wins_here_unlike_in_gnu_grep() {
			let haystack = "hit\nhit there\nxhitx\n";

			assert_eq!(run_rg(&["-w", "hit"], haystack).1, "hit\nhit there\n", "-w is word bounded");
			assert_eq!(run_rg(&["-x", "hit"], haystack).1, "hit\n", "-x is the whole line");
			assert_eq!(run_rg(&["-w", "-x", "hit"], haystack).1, "hit\n", "-x written last wins");
			assert_eq!(
				run_rg(&["-x", "-w", "hit"], haystack).1,
				"hit\nhit there\n",
				"-w written last wins, which is where ripgrep differs from GNU grep"
			);

			// And the flags really are exclusive after the parse, so the matcher
			// never sees both anchorings at once.
			let cli = parse(&["-x", "-w", "hit"]);
			assert!(cli.word_regexp && !cli.line_regexp);
			let flags = MatcherFlags::from_cli(&cli);
			assert!(flags.word && !flags.whole_line);
		}

		/// `-n` / `-N`, where the wrong answer silently changes the SHAPE of
		/// every output line and breaks anything parsing `path:line:text`.
		#[test]
		fn line_numbers_follow_the_last_flag() {
			assert_eq!(run_rg(&["-n", "-N", "aa"], "aa\n").1, "aa\n", "-N last suppresses");
			assert_eq!(run_rg(&["-N", "-n", "aa"], "aa\n").1, "1:aa\n", "-n last prints");
		}

		/// The remaining pairs at the parse layer, both orders each.
		///
		/// Asserted on the parsed flags rather than on output because several
		/// need a symlink, a mount point or a zip to observe, and the property
		/// under test is the RESOLUTION, which the cases above prove end to
		/// end. Written as literal argv so the order is visible in the case
		/// itself.
		#[test]
		fn every_remaining_pair_lets_the_last_flag_win() {
			assert!(parse(&["--hidden", "--no-hidden", "x"]).no_hidden);
			assert!(!parse(&["--hidden", "--no-hidden", "x"]).hidden);
			assert!(parse(&["--no-hidden", "--hidden", "x"]).hidden);
			assert!(!parse(&["--no-hidden", "--hidden", "x"]).no_hidden);

			assert!(parse(&["--no-ignore", "--ignore", "x"]).ignore);
			assert!(!parse(&["--no-ignore", "--ignore", "x"]).no_ignore);
			assert!(parse(&["--ignore", "--no-ignore", "x"]).no_ignore);

			assert!(parse(&["--follow", "--no-follow", "x"]).no_follow);
			assert!(parse(&["--no-follow", "--follow", "x"]).follow);

			assert!(parse(&["--crlf", "--no-crlf", "x"]).no_crlf);
			assert!(parse(&["--no-crlf", "--crlf", "x"]).crlf);

			assert!(parse(&["--search-zip", "--no-search-zip", "x"]).no_search_zip);
			assert!(parse(&["--no-search-zip", "--search-zip", "x"]).search_zip);

			assert!(parse(&["--one-file-system", "--no-one-file-system", "x"]).no_one_file_system);
			assert!(parse(&["--no-one-file-system", "--one-file-system", "x"]).one_file_system);

			assert!(
				parse(&["--max-columns-preview", "--no-max-columns-preview", "x"])
					.no_max_columns_preview
			);
			assert!(
				parse(&["--no-max-columns-preview", "--max-columns-preview", "x"]).max_columns_preview
			);

			assert!(parse(&["--stats", "--no-stats", "x"]).no_stats);
			assert!(parse(&["--no-stats", "--stats", "x"]).stats);
		}

		/// NON-VACUITY: a lone flag still sets its own field, and neither field
		/// is set when neither flag appears. Without this, every assertion
		/// above is satisfied by clap clearing both flags always, which would
		/// silently disable each of these features.
		#[test]
		fn a_lone_flag_still_takes_effect_and_absence_sets_neither() {
			assert!(parse(&["--hidden", "x"]).hidden);
			assert!(parse(&["--no-hidden", "x"]).no_hidden);
			assert!(parse(&["--stats", "x"]).stats);
			assert!(parse(&["--trim", "x"]).trim);
			assert!(parse(&["-F", "x"]).fixed_strings);
			assert!(parse(&["-i", "x"]).ignore_case);

			let bare = parse(&["x"]);
			assert!(!bare.hidden && !bare.no_hidden, "neither hidden flag is set by default");
			assert!(!bare.stats && !bare.no_stats, "stats is off by default");
			assert!(!bare.trim && !bare.no_trim);
			assert!(!bare.ignore_case && !bare.case_sensitive && !bare.smart_case);
		}

		/// `--null-data` is NOT the negation of `--crlf`, so its precedence is
		/// still expressed in code rather than by clap. A NUL-terminated record
		/// has no line ending to strip, so it wins over an explicit `--crlf`
		/// instead of overriding the flag, and both flags survive the parse.
		#[test]
		fn null_data_beats_crlf_without_being_its_negation() {
			let cli = parse(&["--crlf", "--null-data", "x"]);
			assert!(cli.crlf, "both flags survive; this is not an override pair");
			assert!(cli.null_data);
			assert!(!MatcherFlags::from_cli(&cli).crlf, "--null-data must win at the matcher");

			let without = parse(&["--crlf", "x"]);
			assert!(MatcherFlags::from_cli(&without).crlf, "and --crlf alone still applies");
		}
	}

	/// `--stats` prints the summary block ripgrep prints.
	///
	/// WHY THIS SUITE EXISTS. `--stats` was declared as `_stats: bool`, with the
	/// doc comment "accepted; not emitted by this builtin". It parsed and then
	/// did NOTHING, silently: a user asking for a summary got the results and no
	/// summary and no diagnostic. Meanwhile every number it wants was already
	/// being computed on every single run, because `Stats` is threaded through
	/// each search function, and `--json` was already emitting all six fields in
	/// its summary event. So the work was paid for, the data existed, and the
	/// one flag that asks for it was wired to nothing.
	///
	/// PROBED AGAINST RIPGREP 15.1.0 for every detail of the format, including
	/// the parts that read like mistakes and are copied anyway: a leading blank
	/// line even when the block is the whole output, no singularization
	/// (`1 matches`, `1 files searched`), six decimal places on both durations,
	/// and the block going to stdout after the results.
	mod stats_prints_the_summary_block {
		use super::*;

		/// Split the trailing block off, dropping the two timing lines whose
		/// values are wall-clock and cannot be asserted exactly. Their PRESENCE
		/// and shape are checked separately below, so dropping them here does not
		/// let a missing line through.
		fn stable_block(stdout: &str) -> Vec<String> {
			stdout
				.lines()
				.skip_while(|line| !line.ends_with(" matches"))
				.filter(|line| !line.ends_with(" seconds spent searching"))
				.filter(|line| !line.ends_with(" seconds total"))
				.map(str::to_owned)
				.collect()
		}

		/// The counted fields, against the numbers real rg reports for the same
		/// input: 3 matches on 2 lines of a 1-file search.
		#[test]
		fn the_counts_match_what_ripgrep_reports() {
			let (code, stdout, stderr) = run_rg(&["--stats", "aa"], "aa bb aa\ncc\naa\n");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stable_block(&stdout),
				vec![
					"3 matches",
					"2 matched lines",
					"1 files contained matches",
					"1 files searched",
					"12 bytes printed",
					"15 bytes searched",
				],
				"full stdout was {stdout:?}"
			);
		}

		/// The results come FIRST and the block is separated by a blank line, so
		/// a reader can tell where the matches stop. Asserted as the exact
		/// prefix.
		#[test]
		fn the_results_come_first_then_a_blank_line() {
			let (_, stdout, _) = run_rg(&["--stats", "aa"], "aa bb aa\ncc\naa\n");

			assert!(
				stdout.starts_with("aa bb aa\naa\n\n3 matches\n"),
				"the block must follow the results after one blank line: {stdout:?}"
			);
		}

		/// A run with NO matches still prints the block, and the blank line is
		/// still first, so the whole output begins with a newline. This is the
		/// case where the format looks wrong and is copied anyway, and it is also
		/// the case where the exit status must stay 1.
		#[test]
		fn a_run_with_no_matches_still_prints_the_block_and_still_exits_one() {
			let (code, stdout, _) = run_rg(&["--stats", "zzz"], "aa\n");

			assert_eq!(code, 1, "no match is still exit 1 with --stats");
			assert!(stdout.starts_with("\n0 matches\n"), "leading blank line: {stdout:?}");
			assert_eq!(
				stable_block(&stdout),
				vec![
					"0 matches",
					"0 matched lines",
					"0 files contained matches",
					"1 files searched",
					"0 bytes printed",
					"3 bytes searched",
				],
				"full stdout was {stdout:?}"
			);
		}

		/// Nothing is singularized: one match prints `1 matches`. Pluralizing
		/// correctly would be a divergence from the tool being reimplemented, so
		/// the wrong-looking form is pinned deliberately.
		#[test]
		fn a_single_match_still_says_matches_and_files() {
			let (_, stdout, _) = run_rg(&["--stats", "cc"], "aa bb aa\ncc\naa\n");

			let block = stable_block(&stdout);
			assert_eq!(block[0], "1 matches", "not \"1 match\"");
			assert_eq!(block[1], "1 matched lines", "not \"1 matched line\"");
			assert_eq!(block[2], "1 files contained matches", "not \"1 file\"");
			assert_eq!(block[3], "1 files searched", "not \"1 file searched\"");
		}

		/// Both timing lines are present, in order, last, and each carries a
		/// SIX-DECIMAL number that parses as a float. The values are wall clock
		/// so they cannot be pinned, but the shape can, and the shape is what a
		/// reader parses.
		#[test]
		fn both_timing_lines_are_present_last_and_carry_six_decimals() {
			let (_, stdout, _) = run_rg(&["--stats", "aa"], "aa\n");

			let lines: Vec<&str> = stdout.lines().collect();
			let total = lines.last().expect("there is output");
			let searching = lines[lines.len() - 2];

			assert!(total.ends_with(" seconds total"), "last line is the total: {total:?}");
			assert!(
				searching.ends_with(" seconds spent searching"),
				"searching time comes immediately before it: {searching:?}"
			);
			for line in [searching, total] {
				let number = line.split(' ').next().expect("a leading number");
				assert_eq!(
					number.split('.').nth(1).map(str::len),
					Some(6),
					"six decimal places in {line:?}"
				);
				assert!(number.parse::<f64>().is_ok(), "{number:?} must parse as a float");
			}
		}

		/// THE DEFAULT, which is the reason this flag can print to stdout at all:
		/// without it there is no block, so an ordinary pipeline is unaffected.
		/// `--no-stats` reaches the same state, and `--no-stats --stats` does
		/// not.
		#[test]
		fn there_is_no_block_without_the_flag() {
			assert_eq!(run_rg(&["aa"], "aa\n").1, "aa\n", "no flag, no block");
			assert_eq!(run_rg(&["--no-stats", "aa"], "aa\n").1, "aa\n", "--no-stats, no block");
			assert_eq!(
				run_rg(&["--stats", "--no-stats", "aa"], "aa\n").1,
				"aa\n",
				"--no-stats written last suppresses it"
			);
			assert!(
				run_rg(&["--no-stats", "--stats", "aa"], "aa\n")
					.1
					.contains("1 matches"),
				"--stats written last restores it"
			);
		}

		/// `--json` already carries every one of these fields in its summary
		/// event, so the text block must NOT also be printed: it would be the
		/// same numbers twice, in a shape no JSON reader can parse.
		#[test]
		fn json_carries_the_same_numbers_and_the_text_block_stays_out_of_it() {
			let (_, stdout, _) = run_rg(&["--json", "--stats", "aa"], "aa bb aa\ncc\naa\n");

			assert!(!stdout.contains("matched lines"), "no text block in a JSON stream: {stdout:?}");
			assert!(stdout.contains("\"type\":\"summary\""), "the summary event is there");
			assert!(stdout.contains("\"matches\":3"), "and carries the same match count");
			assert!(stdout.contains("\"matched_lines\":2"), "and the same line count");
		}

		/// The counts follow the SEARCH and not the printing, so a summary mode
		/// that prints one line per file still reports every match it found. This
		/// is what makes the block useful with `-c`, and it is the case where a
		/// naive implementation counting printed lines would silently differ.
		#[test]
		fn the_counts_follow_the_search_even_when_the_output_is_a_summary() {
			let (_, stdout, _) = run_rg(&["--stats", "-c", "aa"], "aa bb aa\ncc\naa\n");

			assert!(stdout.starts_with("2\n"), "-c still prints its own count first: {stdout:?}");
			let block = stable_block(&stdout);
			assert_eq!(block[0], "3 matches", "all three matches are counted");
			assert_eq!(block[1], "2 matched lines", "on two lines");
		}

		/// MATCHES AND MATCHED LINES ARE DIFFERENT NUMBERS, and every surface
		/// that reports either must agree.
		///
		/// The sink used to add ONE per line unless `--count-matches` or `-o` was
		/// asking, discarding a per-line count it had already computed. Nothing
		/// read the field in the other modes, so the lie cost nothing until
		/// `--stats` read it and reported 2 for a run ripgrep reports 3 for.
		///
		/// All three surfaces are asserted against the same input and against the
		/// numbers real rg 15.1.0 gives for it (`-c` 2, `--count-matches` 3, `-o`
		/// three lines), because the bug was precisely two of them disagreeing.
		#[test]
		fn every_surface_reporting_a_count_agrees_on_the_same_input() {
			let haystack = "aa bb aa\ncc\naa\n";

			assert_eq!(run_rg(&["-c", "aa"], haystack).1, "2\n", "-c counts LINES");
			assert_eq!(
				run_rg(&["--count-matches", "aa"], haystack).1,
				"3\n",
				"--count-matches counts MATCHES"
			);
			assert_eq!(run_rg(&["-o", "aa"], haystack).1, "aa\naa\naa\n", "-o prints one per match");

			let block = stable_block(&run_rg(&["--stats", "aa"], haystack).1);
			assert_eq!(block[0], "3 matches", "the block agrees with --count-matches");
			assert_eq!(block[1], "2 matched lines", "and with -c");
		}

		/// A WALK UNDER `--stats` VISITS EVERY FILE EVEN WHEN THE MODE NEEDS ONE.
		///
		/// `-q` stops the run at its first match and `-l` stops each file at its
		/// first, which is right until `--stats` asks how many matches the
		/// whole search found. Measured on ripgrep 15.1.0 over a tree of
		/// `aa\naa\n` and `aa bb\n`: a plain run, `--stats -q` and `--stats -l`
		/// all report `3 matches`, `3 matched lines`, `2 files contained
		/// matches`, `2 files searched` and `12 bytes searched`. Ours stopped
		/// at the first match of the first file and reported `1 matches`
		/// over `1 files searched`, describing a search that never happened.
		#[test]
		fn a_mode_that_needs_one_match_still_searches_everything_under_stats() {
			let tree = unique_tree("stats-early-stop");
			std::fs::write(tree.join("a.txt"), "aa\naa\n").expect("fixture should be written");
			std::fs::write(tree.join("b.txt"), "aa bb\n").expect("fixture should be written");
			let want = vec![
				"3 matches",
				"3 matched lines",
				"2 files contained matches",
				"2 files searched",
				"0 bytes printed",
				"12 bytes searched",
			];

			for args in [&["--stats", "-q", "aa", "."][..], &["--stats", "-l", "aa", "."][..]] {
				let (code, stdout, stderr) = run_rg_no_stdin(args, &tree);

				assert_eq!(code, 0, "{args:?}: {stderr}");
				assert_eq!(stable_block(&stdout), want, "{args:?}: {stdout:?}");
			}

			let _ = std::fs::remove_dir_all(tree);
		}

		/// The same two modes keep their own output exactly as it was: `-q`
		/// prints no records at all and `-l` prints one path per matching file,
		/// once. Searching further must not turn into printing further, which
		/// is the mistake the first attempt at the fix above made: it let `-q`
		/// fall through to the printer and dump both matching lines.
		#[test]
		fn searching_further_does_not_print_further() {
			let tree = unique_tree("stats-early-stop-output");
			std::fs::write(tree.join("a.txt"), "aa\naa\n").expect("fixture should be written");
			std::fs::write(tree.join("b.txt"), "aa bb\n").expect("fixture should be written");

			let (code, stdout, stderr) = run_rg_no_stdin(&["--stats", "-q", "aa", "."], &tree);
			assert_eq!(code, 0, "{stderr}");
			assert!(stdout.starts_with("\n3 matches\n"), "-q prints the block alone: {stdout:?}");

			let (code, stdout, stderr) = run_rg_no_stdin(&["--stats", "-l", "aa", "."], &tree);
			assert_eq!(code, 0, "{stderr}");
			let mut paths: Vec<&str> = stdout.lines().take_while(|line| !line.is_empty()).collect();
			paths.sort_unstable();
			assert_eq!(paths, vec!["./a.txt", "./b.txt"], "one path per file: {stdout:?}");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// WITHOUT `--stats` THE EARLY STOP IS STILL THERE, which is the whole
		/// reason `-q` is fast: it reads until the first match and no further.
		/// Turning the stop off outright would have passed every assertion
		/// above while quietly making every `-q` run read whole trees, so the
		/// two owners of the question are asserted directly, both ways round.
		#[test]
		fn without_stats_the_early_stop_survives() {
			let opts = |args: &[&str]| {
				let argv: Vec<OsString> = ["rg"]
					.into_iter()
					.chain(args.iter().copied())
					.map(OsString::from)
					.collect();
				search_options(&RgCli::try_parse_from(argv).expect("the argv should parse"))
			};

			assert!(opts(&["-q", "aa"]).stops_the_run_at_first_match(), "-q stops the run");
			assert!(opts(&["-q", "aa"]).stops_a_file_at_first_match(), "and the file with it");
			assert!(
				opts(&["-l", "aa"]).stops_a_file_at_first_match(),
				"-l stops each file at its first match"
			);
			assert!(
				!opts(&["-l", "aa"]).stops_the_run_at_first_match(),
				"but -l has a path to print for every file, so the run goes on"
			);
			assert!(
				!opts(&["--stats", "-q", "aa"]).stops_the_run_at_first_match(),
				"--stats counts the whole search"
			);
			assert!(!opts(&["--stats", "-q", "aa"]).stops_a_file_at_first_match(), "in every file");
			assert!(!opts(&["--stats", "-l", "aa"]).stops_a_file_at_first_match(), "and under -l");
			assert!(!opts(&["-c", "aa"]).stops_a_file_at_first_match(), "-c never stopped early");
			assert!(!opts(&["aa"]).stops_the_run_at_first_match(), "nor does a plain run");
		}

		/// `bytes printed` COUNTS RECORDS, AND A SUMMARY MODE PRINTS NONE.
		///
		/// Measured on ripgrep 15.1.0 over `aa bb aa\ncc\naa\n`: `-c` prints `2`,
		/// `--count-matches` prints `3`, `-l` prints `<stdin>` and `-q` prints
		/// nothing, and all four report `0 bytes printed` while every other
		/// number in the block stays exactly what a plain run reports. Ours
		/// counted its own summary lines, so `--stats -c` claimed 2 bytes
		/// printed where rg says 0. The field exists to size the RESULT text a
		/// caller is about to read, and a count line is not part of it, so a
		/// run that prints no records prints no bytes.
		#[test]
		fn a_summary_mode_reports_no_bytes_printed() {
			let haystack = "aa bb aa\ncc\naa\n";

			// `--files-without-match` exits 1 because it found nothing to LIST, which is
			// its own answer and not an error; every other mode here exits 0.
			for (args, code_wanted) in [
				(&["--stats", "-c", "aa"][..], 0),
				(&["--stats", "--count-matches", "aa"][..], 0),
				(&["--stats", "-l", "aa"][..], 0),
				(&["--stats", "--files-without-match", "aa"][..], 1),
				(&["--stats", "-q", "aa"][..], 0),
			] {
				let (code, stdout, stderr) = run_rg(args, haystack);

				assert_eq!(code, code_wanted, "{args:?}: {stderr}");
				assert_eq!(
					stable_block(&stdout),
					vec![
						"3 matches",
						"2 matched lines",
						"1 files contained matches",
						"1 files searched",
						"0 bytes printed",
						"15 bytes searched",
					],
					"{args:?}: full stdout was {stdout:?}"
				);
			}
		}

		/// The modes that DO print records report their real width, and the
		/// widths differ per mode: 12 bytes for the two whole lines, 9 for the
		/// three matches `-o` prints instead. Without this twin the fix above
		/// could report zero for everything and still pass.
		#[test]
		fn a_printing_mode_reports_the_width_of_what_it_printed() {
			let haystack = "aa bb aa\ncc\naa\n";

			for (args, printed) in [
				(&["--stats", "aa"][..], "12 bytes printed"),
				(&["--stats", "-o", "aa"][..], "9 bytes printed"),
				(&["--stats", "--heading", "aa"][..], "12 bytes printed"),
			] {
				let (code, stdout, stderr) = run_rg(args, haystack);

				assert_eq!(code, 0, "{args:?}: {stderr}");
				assert_eq!(stable_block(&stdout)[4], printed, "{args:?}: {stdout:?}");
			}
		}

		/// `-q` prints no records and still prints the block, so the block is the
		/// whole output and begins with the leading blank line. `--stats -q` is
		/// how a caller asks only for the numbers, and it has to keep working.
		#[test]
		fn quiet_leaves_the_block_as_the_whole_output() {
			let (code, stdout, stderr) = run_rg(&["--stats", "-q", "aa"], "aa bb aa\ncc\naa\n");

			assert_eq!(code, 0, "{stderr}");
			assert!(stdout.starts_with("\n3 matches\n"), "block only: {stdout:?}");
			assert!(!stdout.contains("aa bb aa"), "-q prints no records: {stdout:?}");
		}

		/// A line the searcher selected counts as at least one match even when a
		/// per-line re-scan finds nothing to point at, which is what
		/// `--multiline` produces: the pattern spans the newline, so neither
		/// line matches it on its own. Real rg reports `1 matches` here, and
		/// without the `.max(1)` floor the block would report 0 matches for
		/// output that plainly matched.
		#[test]
		fn a_multiline_match_counts_as_one_even_though_no_single_line_matches() {
			let (code, stdout, stderr) = run_rg(&["-U", "--stats", "(?s)x.y"], "x\ny\n");

			assert_eq!(code, 0, "{stderr}");
			assert!(stdout.starts_with("x\ny\n"), "the match spans both lines: {stdout:?}");
			let block = stable_block(&stdout);
			assert_eq!(block[0], "1 matches", "a selected line is never zero matches");
			assert_eq!(block[1], "1 matched lines");
		}
	}
	/// `--heading` prints the path above each file's lines instead of on them.
	///
	/// WHY THIS SUITE EXISTS. `--heading` and `--no-heading` were declared as
	/// `_heading` / `_no_heading`: parsed, then ignored. So was `-p`, whose doc
	/// said "colors/headings are not emitted" when two of the three things it
	/// aliases needed no color work at all. A user asking for heading output got
	/// path-prefixed output and no diagnostic.
	///
	/// PROBED AGAINST RIPGREP 15.1.0 for every rule, including the four that are
	/// not guessable:
	///
	/// - The blank line goes BETWEEN groups, never above the first.
	/// - It is emitted even under `--no-filename`, where there is no heading to
	///   separate, because it separates the GROUPS.
	/// - `--vimgrep` and the summary modes (`-c`, `-l`, `-L`) IGNORE heading and
	///   keep their path prefixes.
	/// - The heading is a RECORD rather than a prefix, so `--null` makes it
	///   `path` then NUL, and so does `--null-data`, where NUL is the record
	///   terminator. One rule explains all three forms, which is why they share
	///   `write_path_with_separator` with `-l`.
	///
	/// Every case pins the WHOLE stdout as bytes, because the entire content of
	/// this feature is where the newlines and paths go.
	mod heading_puts_the_path_above_the_group {
		use super::*;

		/// Two files, the full byte sequence: heading, lines with no prefix,
		/// blank line, next heading. This is the shape the flag exists to
		/// produce.
		#[test]
		fn a_path_line_then_unprefixed_lines_then_a_blank_line_between_groups() {
			let tree = unique_tree("heading-two");
			std::fs::write(tree.join("a.txt"), "aa bb aa\ncc\naa\n").expect("fixture written");
			std::fs::write(tree.join("b.txt"), "aa\n").expect("fixture written");

			let (code, stdout, stderr) = run_rg_in(&["--heading", "aa", "a.txt", "b.txt"], "", &tree);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a.txt\naa bb aa\naa\n\nb.txt\naa\n");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// With line numbers, the combination `-p` produces: the numbers stay on
		/// the lines and only the PATH moves to the heading.
		#[test]
		fn line_numbers_stay_on_the_lines_when_the_path_moves_to_the_heading() {
			let tree = unique_tree("heading-numbers");
			std::fs::write(tree.join("a.txt"), "aa bb aa\ncc\naa\n").expect("fixture written");
			std::fs::write(tree.join("b.txt"), "aa\n").expect("fixture written");

			let (_, stdout, _) = run_rg_in(&["--heading", "-n", "aa", "a.txt", "b.txt"], "", &tree);

			assert_eq!(stdout, "a.txt\n1:aa bb aa\n3:aa\n\nb.txt\n1:aa\n");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// THE COMPARISON that makes the rest meaningful: without the flag, the
		/// same run prefixes every line and prints no blank line at all. Both
		/// spellings of "off" are covered, and the pair is last-wins both ways.
		#[test]
		fn without_the_flag_every_line_carries_the_path_and_no_blank_line_appears() {
			let tree = unique_tree("heading-off");
			std::fs::write(tree.join("a.txt"), "aa bb aa\ncc\naa\n").expect("fixture written");
			std::fs::write(tree.join("b.txt"), "aa\n").expect("fixture written");

			for args in [
				&["aa", "a.txt", "b.txt"][..],
				&["--no-heading", "aa", "a.txt", "b.txt"][..],
				&["--heading", "--no-heading", "aa", "a.txt", "b.txt"][..],
			] {
				let (_, stdout, _) = run_rg_in(args, "", &tree);
				assert_eq!(stdout, "a.txt:aa bb aa\na.txt:aa\nb.txt:aa\n", "for {args:?}");
			}

			let (_, last_wins, _) =
				run_rg_in(&["--no-heading", "--heading", "aa", "a.txt", "b.txt"], "", &tree);
			assert_eq!(last_wins, "a.txt\naa bb aa\naa\n\nb.txt\naa\n", "--heading written last wins");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// A single file shows no heading, because it shows no path either: the
		/// heading follows whether the path is displayed at all, so a one-file
		/// search is byte-identical with and without the flag.
		#[test]
		fn one_file_prints_no_heading_because_it_prints_no_path() {
			let plain = run_rg(&["aa"], "aa bb aa\ncc\naa\n").1;
			let headed = run_rg(&["--heading", "aa"], "aa bb aa\ncc\naa\n").1;

			assert_eq!(headed, "aa bb aa\naa\n");
			assert_eq!(headed, plain, "one input means the flag changes nothing");
		}

		/// `--no-filename` removes the heading and KEEPS the blank line, the rule
		/// that shows the separator belongs to the groups rather than to the
		/// headings. Guessing the other way is the obvious mistake.
		#[test]
		fn no_filename_drops_the_heading_but_keeps_the_group_separator() {
			let tree = unique_tree("heading-nofile");
			std::fs::write(tree.join("a.txt"), "aa bb aa\ncc\naa\n").expect("fixture written");
			std::fs::write(tree.join("b.txt"), "aa\n").expect("fixture written");

			let (_, stdout, _) =
				run_rg_in(&["--heading", "--no-filename", "aa", "a.txt", "b.txt"], "", &tree);

			assert_eq!(stdout, "aa bb aa\naa\n\naa\n");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// A file that MATCHES NOTHING prints no group and no separator, so a
		/// blank line never appears where an empty group would have been. An
		/// implementation keying the separator off "a file was searched" rather
		/// than "a file printed" fails here and nowhere else.
		#[test]
		fn a_file_with_no_match_leaves_no_group_and_no_separator() {
			let tree = unique_tree("heading-empty");
			std::fs::write(tree.join("a.txt"), "nothing\n").expect("fixture written");
			std::fs::write(tree.join("b.txt"), "aa\n").expect("fixture written");
			std::fs::write(tree.join("c.txt"), "aa\n").expect("fixture written");

			let (_, stdout, _) = run_rg_in(&["--heading", "aa", "a.txt", "b.txt", "c.txt"], "", &tree);

			assert_eq!(stdout, "b.txt\naa\n\nc.txt\naa\n", "no blank line where a.txt would be");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// `--vimgrep` IGNORES the flag. Its contract is one parseable
		/// `path:line:col:text` per match, and hoisting the path into a heading
		/// would break every editor that reads it.
		#[test]
		fn vimgrep_keeps_its_path_prefix_and_ignores_the_heading() {
			let tree = unique_tree("heading-vimgrep");
			std::fs::write(tree.join("a.txt"), "aa bb aa\n").expect("fixture written");
			std::fs::write(tree.join("b.txt"), "aa\n").expect("fixture written");

			let (_, stdout, _) =
				run_rg_in(&["--heading", "--vimgrep", "aa", "a.txt", "b.txt"], "", &tree);

			assert_eq!(stdout, "a.txt:1:1:aa bb aa\na.txt:1:7:aa bb aa\nb.txt:1:1:aa\n");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// The summary modes keep their `path:count` and `path` records, because
		/// those records already ARE one line per file and a heading above each
		/// would say the path twice.
		#[test]
		fn the_summary_modes_keep_their_prefixes() {
			let tree = unique_tree("heading-summary");
			std::fs::write(tree.join("a.txt"), "aa bb aa\ncc\naa\n").expect("fixture written");
			std::fs::write(tree.join("b.txt"), "aa\n").expect("fixture written");

			let (_, counted, _) = run_rg_in(&["--heading", "-c", "aa", "a.txt", "b.txt"], "", &tree);
			assert_eq!(counted, "a.txt:2\nb.txt:1\n");

			let (_, listed, _) = run_rg_in(&["--heading", "-l", "aa", "a.txt", "b.txt"], "", &tree);
			assert_eq!(listed, "a.txt\nb.txt\n", "-l prints paths with no blank lines between");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// THE HEADING IS A RECORD, the single rule behind all three NUL forms:
		/// it ends with the record terminator, and `--null` replaces that byte.
		/// Asserted as exact bytes for both flags, because this is precisely
		/// where a NUL-splitting consumer breaks.
		#[test]
		fn the_heading_ends_like_a_record_under_both_nul_flags() {
			let tree = unique_tree("heading-nul");
			std::fs::write(tree.join("a.txt"), "aa bb aa\ncc\naa\n").expect("fixture written");
			std::fs::write(tree.join("b.txt"), "aa\n").expect("fixture written");

			// `--null` replaces the byte after the path. The group separator is
			// still the record terminator, a newline here.
			let (_, nulled, _) =
				run_rg_in(&["--heading", "--null", "aa", "a.txt", "b.txt"], "", &tree);
			assert_eq!(nulled, "a.txt\x00aa bb aa\naa\n\nb.txt\x00aa\n");

			// `--null-data` makes NUL the record terminator, so the heading ends
			// with NUL for that reason instead, and so does the group separator.
			// The whole file is one record here, since neither file contains a NUL.
			let (_, null_data, _) =
				run_rg_in(&["--heading", "--null-data", "aa", "a.txt", "b.txt"], "", &tree);
			assert_eq!(null_data, "a.txt\x00aa bb aa\ncc\naa\n\x00\x00b.txt\x00aa\n\x00");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// `-p` is an alias, and what it aliases is asserted rather than
		/// described: heading plus line numbers. The color third is not
		/// implemented, so the output must contain no escape byte, which is
		/// also what makes `-p` safe to write into a captured buffer.
		#[test]
		fn pretty_implies_heading_and_line_numbers_and_emits_no_escapes() {
			let tree = unique_tree("heading-pretty");
			std::fs::write(tree.join("a.txt"), "aa bb aa\ncc\naa\n").expect("fixture written");
			std::fs::write(tree.join("b.txt"), "aa\n").expect("fixture written");

			let (_, pretty, _) = run_rg_in(&["-p", "aa", "a.txt", "b.txt"], "", &tree);
			let (_, spelled, _) = run_rg_in(&["--heading", "-n", "aa", "a.txt", "b.txt"], "", &tree);

			assert_eq!(pretty, "a.txt\n1:aa bb aa\n3:aa\n\nb.txt\n1:aa\n");
			assert_eq!(pretty, spelled, "-p must equal what it aliases");
			assert!(!pretty.contains('\u{1b}'), "no color escapes: {pretty:?}");

			let _ = std::fs::remove_dir_all(tree);
		}

		/// Context lines join the group rather than carrying the path, and keep
		/// their `-` separator, so a reader can still tell a context line from a
		/// match inside a heading group.
		#[test]
		fn context_lines_join_the_group_and_keep_their_dash() {
			let tree = unique_tree("heading-context");
			std::fs::write(tree.join("a.txt"), "one\nhit\nthree\n").expect("fixture written");
			std::fs::write(tree.join("b.txt"), "hit\n").expect("fixture written");

			let (_, stdout, _) =
				run_rg_in(&["--heading", "-n", "-C1", "hit", "a.txt", "b.txt"], "", &tree);

			assert_eq!(stdout, "a.txt\n1-one\n2:hit\n3-three\n\nb.txt\n1:hit\n");

			let _ = std::fs::remove_dir_all(tree);
		}
	}
	/// `--max-columns` and its preview.
	///
	/// WHY THIS SUITE EXISTS. Three separate things were wrong here, and none of
	/// them was visible without comparing against real ripgrep 15.1.0, which is
	/// where every expectation below comes from.
	///
	/// (1) A CONTEXT line that was too long said `[Omitted long matching line]`.
	/// ripgrep says `[Omitted long context line]`, and the difference matters
	/// beyond wording: a reader who greps their own output for the matching
	/// notice and finds it on a line that never matched has been told something
	/// false about their own search.
	///
	/// (2) `--max-columns-preview` printed a truncated line with NOTHING to say
	/// it had been cut, so a preview was indistinguishable from a line that
	/// really ended there. ripgrep appends ` [... omitted end of long line]`.
	///
	/// (3) The preview cut on a BYTE boundary. ripgrep cuts on a CHARACTER
	/// boundary, and cutting on a byte splits a multi-byte character down the
	/// middle and writes a lone continuation byte to stdout.
	mod an_over_long_line_is_replaced_or_previewed {
		use super::*;

		/// The limit counts BYTES and counts the terminator among them. A
		/// nineteen-character line survives `-M 20`; a twenty-character one does
		/// not, because it is twenty-one bytes with its newline. Both sides of
		/// that boundary, since only one of them catches an off-by-one.
		#[test]
		fn the_limit_counts_the_terminator() {
			let nineteen = format!("{}match\n", "x".repeat(14));
			let (code, stdout, stderr) = run_rg(&["-M", "20", "match"], &nineteen);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "xxxxxxxxxxxxxxmatch\n");

			let twenty = format!("{}match\n", "x".repeat(15));
			let (code, stdout, stderr) = run_rg(&["-M", "20", "match"], &twenty);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "[Omitted long matching line]\n");
		}

		/// `-M 0` is no limit at all, so a long line prints whole.
		#[test]
		fn a_zero_limit_is_no_limit() {
			let long = format!("{}match\n", "x".repeat(500));
			let (code, stdout, stderr) = run_rg(&["-M", "0", "match"], &long);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, long);
		}

		/// A CONTEXT line gets its OWN notice. This is the case that was wrong,
		/// and the second half puts both notices in ONE run, so the test fails
		/// if either takes the other's wording.
		#[test]
		fn a_context_line_says_context_and_a_matching_line_says_matching() {
			let text = format!("{}\nmatch\n{}\n", "y".repeat(40), "z".repeat(40));
			let (code, stdout, stderr) = run_rg(&["-M", "20", "-C", "1", "match"], &text);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "[Omitted long context line]\nmatch\n[Omitted long context line]\n");

			let both = format!("{}\n{}match\n", "y".repeat(40), "x".repeat(40));
			let (code, stdout, stderr) = run_rg(&["-M", "20", "-C", "1", "match"], &both);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "[Omitted long context line]\n[Omitted long matching line]\n",
				"the two notices must not collapse into one wording"
			);
		}

		/// The preview keeps the first `limit` characters and then SAYS it
		/// stopped. The leading space belongs to the marker, so a preview whose
		/// last kept character is itself a space prints two.
		#[test]
		fn a_preview_ends_with_the_marker() {
			let text = "this is a very long line with match inside it and more text after\n";
			let (code, stdout, stderr) = run_rg(&["-M", "20", "--max-columns-preview", "match"], text);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "this is a very long  [... omitted end of long line]\n");
		}

		/// A line whose CONTENT fits but whose terminator pushed it over the
		/// limit previews whole and still carries the marker, and the marker
		/// lands after the content rather than after a newline.
		#[test]
		fn a_preview_strips_the_terminator_before_marking() {
			let text = format!("{}match\n", "x".repeat(15));
			let (code, stdout, stderr) =
				run_rg(&["-M", "20", "--max-columns-preview", "match"], &text);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "xxxxxxxxxxxxxxxmatch [... omitted end of long line]\n");
		}

		/// The preview cuts on a CHARACTER boundary. Twenty two-byte characters
		/// is forty bytes wide under a limit of twenty, and cutting at twenty
		/// BYTES would have split the eleventh and emitted a lone continuation
		/// byte.
		#[test]
		fn a_preview_cuts_on_a_character_boundary() {
			let wide = "\u{e9}".repeat(30);
			let text = format!("{wide}match\n");
			let (code, stdout, stderr) =
				run_rg(&["-M", "20", "--max-columns-preview", "match"], &text);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, format!("{} [... omitted end of long line]\n", "\u{e9}".repeat(20)));
		}

		/// A context line previews too, and previewing does not lose the `-` its
		/// prefix carries.
		#[test]
		fn a_context_line_previews_behind_its_own_separator() {
			let text = format!("{}\nmatch\n", "y".repeat(40));
			let (code, stdout, stderr) =
				run_rg(&["-M", "20", "-C", "1", "-n", "--max-columns-preview", "match"], &text);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout,
				format!("1-{} [... omitted end of long line]\n2:match\n", "y".repeat(20))
			);
		}

		/// `--trim` runs BEFORE the limit is measured, so a line that is only
		/// long because of its indentation prints in full.
		#[test]
		fn trim_runs_before_the_limit_is_measured() {
			let text = format!("{}xxxxxmatch\n", " ".repeat(10));
			let (code, stdout, stderr) = run_rg(&["-M", "20", "--trim", "match"], &text);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "xxxxxmatch\n", "eleven characters once the indent is gone");

			let (code, stdout, stderr) = run_rg(&["-M", "20", "match"], &text);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "[Omitted long matching line]\n", "twenty-one bytes untrimmed");
		}

		/// Under `--null-data` the notice and the preview both end with a NUL,
		/// since the record terminator is what ends a record and not `\n`.
		#[test]
		fn the_notice_and_the_preview_end_with_the_record_terminator() {
			let text = format!("{}match\0", "x".repeat(40));
			let (code, stdout, stderr) = run_rg(&["--null-data", "-M", "20", "match"], &text);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "[Omitted long matching line]\0");

			let (code, stdout, stderr) =
				run_rg(&["--null-data", "-M", "20", "--max-columns-preview", "match"], &text);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout,
				format!("{} [... omitted end of long line]\0", "x".repeat(20)),
				"the NUL comes off before the marker, exactly as a newline does"
			);
		}
	}

	/// The character walk the preview cuts with, tested directly because the
	/// inputs that break it are the ones a CLI test cannot express.
	mod a_preview_prefix_never_splits_a_character {
		use super::*;

		/// ASCII is one byte per character, so the prefix is the obvious one.
		#[test]
		fn ascii_counts_one_byte_each() {
			assert_eq!(preview_prefix(b"abcdef", 3), b"abc");
			assert_eq!(preview_prefix(b"abc", 10), b"abc", "a short line is not padded");
			assert_eq!(preview_prefix(b"", 5), b"");
			assert_eq!(preview_prefix(b"abc", 0), b"", "a zero-column prefix is empty");
		}

		/// Two-, three- and four-byte sequences are each taken whole, so the
		/// result is valid UTF-8 whenever the input was.
		#[test]
		fn multi_byte_characters_are_taken_whole() {
			assert_eq!(preview_prefix("\u{e9}\u{e9}\u{e9}".as_bytes(), 2), "\u{e9}\u{e9}".as_bytes());
			assert_eq!(
				preview_prefix("\u{65e5}\u{672c}\u{8a9e}".as_bytes(), 2),
				"\u{65e5}\u{672c}".as_bytes()
			);
			assert_eq!(preview_prefix("\u{1f980}\u{1f980}".as_bytes(), 1), "\u{1f980}".as_bytes());
			assert_eq!(
				preview_prefix("a\u{2192}b".as_bytes(), 2),
				"a\u{2192}".as_bytes(),
				"a mixed-width line counts characters, not bytes"
			);
		}

		/// The prefix of valid text is valid text at EVERY limit, and holds
		/// exactly as many characters as were asked for. That is the property
		/// the byte-wise cut broke.
		#[test]
		fn every_prefix_of_valid_text_is_valid_text() {
			let text = "a\u{e9}\u{65e5}\u{1f980}b\u{e9}\u{65e5}\u{1f980}";
			let total = text.chars().count();
			for columns in 0..=total + 2 {
				let prefix = preview_prefix(text.as_bytes(), columns);
				let decoded = std::str::from_utf8(prefix)
					.unwrap_or_else(|err| panic!("columns {columns} produced invalid UTF-8: {err}"));
				assert_eq!(
					decoded.chars().count(),
					columns.min(total),
					"columns {columns} kept the wrong number of characters"
				);
			}
		}

		/// A byte that starts no sequence advances by one and counts as one, so a
		/// binary line previews instead of looping or reading past its end.
		#[test]
		fn a_stray_continuation_byte_advances_by_one() {
			assert_eq!(preview_prefix(&[0x80, 0x80, 0x80], 2), &[0x80, 0x80]);
			assert_eq!(preview_prefix(&[0xff, b'a', 0xfe], 2), &[0xff, b'a']);
		}

		/// A TRUNCATED sequence at the end of the input is clamped to the input
		/// rather than read past it, which is the case a bare `at += len` panics
		/// on.
		#[test]
		fn a_truncated_sequence_at_the_end_is_clamped() {
			// A three-byte lead followed by only one continuation byte.
			assert_eq!(preview_prefix(&[0xe6, 0x97], 1), &[0xe6, 0x97]);
			assert_eq!(preview_prefix(&[b'a', 0xf0], 2), &[b'a', 0xf0]);
		}
	}
	/// `--vimgrep` and `-o` together.
	///
	/// WHY THIS SUITE EXISTS. `--vimgrep` used to win outright over `-o`, so
	/// `rg --vimgrep -o` printed the whole LINE under a flag whose entire
	/// promise is that it prints only what matched. The two flags do not
	/// compete: `--vimgrep` decides the PREFIX, one record per match with a
	/// line and a column, and `-o` decides the BODY. Every expectation here
	/// came from ripgrep 15.1.0. `--vimgrep` and `-o` are the two flags that
	/// turn one matching line into one record PER MATCH, and they were written
	/// as two loops that could not compose.
	///
	/// Every expectation here was measured against ripgrep 15.1.0 on the same
	/// stdin, including the two that look like typos: `--vimgrep` prints a path
	/// prefix even for stdin, where it names the source `<stdin>`, and
	/// `--column` implies `--line-number`.
	mod vimgrep_and_only_matching_compose {
		use super::*;

		/// `--vimgrep` alone: one record per match, each carrying the whole line
		/// and the column the match starts at. Two matches on one line means
		/// two records with the SAME text and different columns, which is the
		/// shape an editor jumps through.
		///
		/// The `<stdin>` prefix is ripgrep's: `--vimgrep` output is parsed by an
		/// editor that needs a file to open, so the flag turns the path on
		/// whether or not there is a file to name.
		#[test]
		fn vimgrep_alone_repeats_the_line_once_per_match() {
			let (code, stdout, stderr) = run_rg(&["--vimgrep", "aa"], "aa bb aa\nmiss\ncc aa\n");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>:1:1:aa bb aa\n<stdin>:1:7:aa bb aa\n<stdin>:3:4:cc aa\n");
		}

		/// With `-o` the body becomes the MATCH and the prefix is unchanged. This
		/// is the case that was wrong: `--vimgrep` used to win outright and
		/// print the whole line under a flag whose entire promise is that it
		/// prints only what matched.
		#[test]
		fn only_matching_replaces_the_body_and_keeps_the_prefix() {
			let (code, stdout, stderr) = run_rg(&["--vimgrep", "-o", "aa"], "aa bb aa\nmiss\ncc aa\n");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>:1:1:aa\n<stdin>:1:7:aa\n<stdin>:3:4:aa\n");
		}

		/// Plain `-o` is untouched: no path, no line number and no column,
		/// because `-o` turns none of those on and `--vimgrep` turns all three
		/// on.
		#[test]
		fn only_matching_alone_still_prints_no_column() {
			let (code, stdout, stderr) = run_rg(&["-o", "aa"], "aa bb aa\nmiss\ncc aa\n");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "aa\naa\naa\n");
		}

		/// `-o --column` gets a column AND a line number, because `--column`
		/// implies `--line-number` on its own. It gets no path, so the reorder
		/// did not tie the three fields together: each is still decided by its
		/// own flag.
		#[test]
		fn only_matching_with_column_gets_a_column_and_the_implied_line_number() {
			let (code, stdout, stderr) = run_rg(&["-o", "--column", "aa"], "aa bb aa\n");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:1:aa\n1:7:aa\n");
		}

		/// `-r` reaches the body on both paths: with `-o` the replacement alone,
		/// and without it the whole replaced line.
		///
		/// The columns are 1 and 6, not 1 and 7, because they are positions in
		/// `X bb X`. See `a_replacement_reports_its_own_position`.
		#[test]
		fn replacement_reaches_both_bodies() {
			let (code, stdout, stderr) =
				run_rg(&["--vimgrep", "-o", "-r", "X", "aa"], "aa bb aa\ncc aa\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>:1:1:X\n<stdin>:1:6:X\n<stdin>:2:4:X\n");

			let (code, stdout, stderr) = run_rg(&["--vimgrep", "-r", "X", "aa"], "aa bb aa\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>:1:1:X bb X\n<stdin>:1:6:X bb X\n");
		}

		/// `-M` still replaces an over-long body, and under `-o` the body it
		/// measures is the MATCH, so a short match inside a long line is
		/// printed rather than omitted. That is the practical reason to combine
		/// the two.
		#[test]
		fn the_column_limit_measures_the_body_that_is_printed() {
			let long = format!("{}aa{}\n", "x".repeat(60), "y".repeat(60));

			let (code, stdout, stderr) = run_rg(&["--vimgrep", "-o", "-M", "20", "aa"], &long);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>:1:61:aa\n", "the match is short, so nothing is omitted");

			let (code, stdout, stderr) = run_rg(&["--vimgrep", "-M", "20", "aa"], &long);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "<stdin>:1:61:[Omitted long line with 1 matches]\n",
				"without -o the body is the whole line and it is too long"
			);
		}

		/// `--trim` trims the BODY and never the column, which is measured on the
		/// line as it was read. Both paths agree on that.
		#[test]
		fn trim_moves_the_body_and_not_the_column() {
			let (code, stdout, stderr) = run_rg(&["--vimgrep", "--trim", "aa"], "   aa  \n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>:1:4:aa  \n", "the column counts the untrimmed line");

			let (code, stdout, stderr) = run_rg(&["--vimgrep", "-o", "--trim", "aa"], "   aa  \n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>:1:4:aa\n");
		}

		/// A counting mode wins over both, because it returns before either body
		/// is written. With `-o` asking, the number is MATCHES and not lines:
		/// three matches over two lines.
		#[test]
		fn a_counting_mode_still_wins_over_both() {
			let (code, stdout, stderr) =
				run_rg(&["--vimgrep", "-o", "-c", "aa"], "aa bb aa\nmiss\ncc aa\n");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>:3\n", "-o makes -c count matches, and vimgrep adds the path");
		}
	}

	/// Where a `-r` run says its matches are.
	///
	/// THE BUG. Every position ripgrep reports under `-r` is a position in the
	/// line it BUILT, not in the line it read, and this printer reported the
	/// original line's offsets. Measured against ripgrep 15.1.0: `-r XYZ` over
	/// `aa bb aa` puts the second replacement at column 8, because `XYZ bb XYZ`
	/// is what the reader sees and the second `XYZ` starts there. Ours said 7,
	/// which points a jump-to-column editor at the space.
	///
	/// The fix made the replacement walk record its own output offsets, which is
	/// also what put the whole-line and `-o` paths on one implementation.
	mod a_replacement_reports_its_own_position {
		use super::*;

		/// A replacement LONGER than what it replaced pushes every later column
		/// right. Three widths in one run, since a fix that reported the original
		/// offsets passes any test where the two happen to agree.
		#[test]
		fn a_longer_replacement_pushes_the_next_column_right() {
			let (code, stdout, stderr) = run_rg(&["--vimgrep", "-r", "XYZ", "aa"], "aa bb aa\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>:1:1:XYZ bb XYZ\n<stdin>:1:8:XYZ bb XYZ\n");

			let (code, stdout, stderr) = run_rg(&["--vimgrep", "-r", "X", "aa"], "aa bb aa\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>:1:1:X bb X\n<stdin>:1:6:X bb X\n");

			let (code, stdout, stderr) = run_rg(&["--vimgrep", "-r", "", "aa"], "aa bb aa\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "<stdin>:1:1: bb \n<stdin>:1:5: bb \n",
				"an empty replacement still occupies a position"
			);
		}

		/// `--byte-offset` shifts with the column, because it is the same offset
		/// counted from the start of the file rather than the start of the line.
		#[test]
		fn the_byte_offset_shifts_with_the_replacement() {
			let (code, stdout, stderr) =
				run_rg(&["-b", "--vimgrep", "-r", "XYZ", "aa"], "xaa bb aa\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>:1:2:1:xXYZ bb XYZ\n<stdin>:1:9:8:xXYZ bb XYZ\n");

			let (code, stdout, stderr) = run_rg(&["-b", "--vimgrep", "aa"], "xaa bb aa\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "<stdin>:1:2:1:xaa bb aa\n<stdin>:1:8:7:xaa bb aa\n",
				"THE TWIN: without -r the offsets are the original line's"
			);
		}

		/// `-o -r` reports the same replaced positions, and prints the
		/// replacement as its body. This is the pair that used to be computed
		/// by two different walks.
		#[test]
		fn only_matching_agrees_with_the_whole_line_path() {
			let (code, stdout, stderr) = run_rg(&["--vimgrep", "-o", "-r", "XYZ", "aa"], "aa bb aa\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>:1:1:XYZ\n<stdin>:1:8:XYZ\n");

			let (code, stdout, stderr) = run_rg(&["-b", "-o", "-r", "ZZZZ", "aa"], "x aa bb aa\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2:ZZZZ\n10:ZZZZ\n");
		}

		/// A capture-interpolating replacement of VARYING width, so the offsets
		/// are not a constant shift and a per-match sum is the only thing that
		/// gets them all right.
		#[test]
		fn interpolated_widths_shift_each_column_by_its_own_amount() {
			let (code, stdout, stderr) =
				run_rg(&["--vimgrep", "-r", "<$0>", r"a\d+"], "a1 a22 a333\n");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout,
				"<stdin>:1:1:<a1> <a22> <a333>\n<stdin>:1:6:<a1> <a22> <a333>\n<stdin>:1:12:<a1> \
				 <a22> <a333>\n"
			);
		}

		/// A one-record mode reports the FIRST replacement's column, so the
		/// non-vimgrep path shifted too.
		#[test]
		fn a_single_record_reports_the_first_replacement() {
			let (code, stdout, stderr) = run_rg(&["--column", "-r", "XYZ", "aa"], "xaa bb aa\n");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:2:xXYZ bb XYZ\n");
		}
	}

	/// How many matches a line has, which used to be three answers.
	///
	/// THE BUG. `count_matches`, the `-o` loop and the `--vimgrep` loop each
	/// walked the line with their own `find_at` loop, and they disagreed about
	/// EMPTY matches: the count skipped them, `-o` skipped them, `--vimgrep`
	/// printed them. Measured against ripgrep 15.1.0, all three should report
	/// the same sequence, which is the one the matcher's own iteration
	/// produces. The fix deleted the three loops in favour of
	/// `Matcher::find_iter`.
	mod every_match_on_a_line_is_found_once {
		use super::*;

		/// A pattern that matches the empty string produces one record per
		/// POSITION, including one past the last byte, and each record has an
		/// empty body.
		#[test]
		fn an_empty_match_is_a_record_of_its_own() {
			let (code, stdout, stderr) = run_rg(&["-o", "x*"], "ab\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "\n\n\n", "three positions in a two-byte line, three empty records");

			let (code, stdout, stderr) = run_rg(&["-o", "--column", "x*"], "ab\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:1:\n1:2:\n1:3:\n", "and each one still reports where it was");
		}

		/// An empty match ADJACENT to the previous match's end is not reported,
		/// which is the rule that makes `b*` two records over `ab` and not
		/// three: the empty match at the end of `b` is suppressed by the `b`
		/// before it.
		///
		/// This is the case a hand-written `find_at` loop gets wrong, and the
		/// reason the walk was handed to the matcher.
		#[test]
		fn an_empty_match_next_to_a_real_one_is_suppressed() {
			let (code, stdout, stderr) = run_rg(&["--vimgrep", "b*"], "ab\n");

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>:1:1:ab\n<stdin>:1:2:ab\n");
		}

		/// The COUNT is the same sequence, so `--count-matches` reports 3 for
		/// `x*` and 2 for `b*` over the same line. That is the assertion that
		/// pins the count and the records to one walk: before, they came from
		/// two.
		#[test]
		fn the_count_is_the_same_sequence_the_records_are() {
			let (code, stdout, stderr) = run_rg(&["--count-matches", "x*"], "ab\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "3\n");

			let (code, stdout, stderr) = run_rg(&["--count-matches", "b*"], "ab\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2\n");
		}

		/// A line the searcher selected but a per-line scan finds nothing on
		/// still counts as one match and still prints one record. `-v` is the
		/// way to reach that state: every line it prints is one the pattern did
		/// NOT match.
		#[test]
		fn a_line_with_no_findable_span_counts_as_one() {
			let (code, stdout, stderr) = run_rg(&["-v", "--count-matches", "ab"], "ab\ncd\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1\n", "one line printed, so one match counted");

			let (code, stdout, stderr) = run_rg(&["-v", "--vimgrep", "ab"], "ab\ncd\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "<stdin>:2:1:cd\n",
				"vimgrep owes a record, and column 1 is the fallback"
			);

			let (code, stdout, stderr) = run_rg(&["-v", "-o", "ab"], "ab\ncd\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "", "-o owes nothing, because there is no match text to print");
		}
	}

	/// What `--max-columns` says about a body it dropped.
	///
	/// THE BUG. There were two wordings and ripgrep has four. When a run already
	/// knows where the matches are, because `--column` needs a position to print
	/// or `-r` needs the spans to interpolate into, ripgrep COUNTS the matches
	/// it is dropping instead of saying only that a line was long. Every string
	/// here was read off ripgrep 15.1.0 with `od -c`.
	mod the_omitted_wording_says_what_was_dropped {
		use super::*;

		/// The counted notice, and the plain one beside it in the same run. The
		/// plural is ripgrep's: the notice says `with 1 matches` and does not
		/// singularize.
		#[test]
		fn a_run_that_knows_its_columns_counts_what_it_dropped() {
			let long = format!("{}aa{}aa{}\n", "x".repeat(60), "y".repeat(30), "z".repeat(30));

			let (code, stdout, stderr) = run_rg(&["--column", "-M", "20", "aa"], &long);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:61:[Omitted long line with 2 matches]\n");

			let (code, stdout, stderr) = run_rg(&["-M", "20", "aa"], &long);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "[Omitted long matching line]\n",
				"THE TWIN: with no column to print there is no count either"
			);

			let single = format!("aa{}\n", "x".repeat(80));
			let (code, stdout, stderr) = run_rg(&["--column", "-M", "20", "aa"], &single);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:1:[Omitted long line with 1 matches]\n", "not `1 match`");
		}

		/// `-r` counts too, because interpolating needs the spans. The count is
		/// of the REPLACEMENTS, which is why a replacement the pattern cannot
		/// match is still counted: `a+` matches `QXXXXXXXXXX` no times at all.
		#[test]
		fn a_replacement_run_counts_its_replacements() {
			let text = format!("{}{}\n", "a".repeat(25), "X".repeat(10));
			let (code, stdout, stderr) = run_rg(&["-M", "5", "-r", "Q", "a+"], &text);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "[Omitted long line with 1 matches]\n");
		}

		/// A CONTEXT line keeps its own wording however the run is configured,
		/// because nothing matched on it and there is nothing to count.
		#[test]
		fn a_context_line_is_never_counted() {
			let text = format!("aa\n{}\n", "y".repeat(40));
			let (code, stdout, stderr) = run_rg(&["--column", "-M", "20", "-A", "1", "aa"], &text);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:1:aa\n2-[Omitted long context line]\n");
		}

		/// `-o` is never counted either: its record holds one match, which it has
		/// just printed, so there is nothing left to say. It keeps the plain
		/// wording even under `--column`, which every other matching body
		/// counts under.
		#[test]
		fn only_matching_keeps_the_plain_wording() {
			let (code, stdout, stderr) = run_rg(&["-o", "-M", "1", "aa"], "aa\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "[Omitted long matching line]\n");

			let (code, stdout, stderr) = run_rg(&["-o", "--column", "-M", "1", "aa"], "aa\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:1:[Omitted long matching line]\n");

			let (code, stdout, stderr) = run_rg(&["-o", "-M", "3", "-r", "REPLACEMENT", "aa"], "aa\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "[Omitted long matching line]\n", "the limit measures the replacement");
		}

		/// The limit counts a LINE's terminator and a MATCH has none, so the same
		/// two bytes fit under `-M 2` as a match and do not as a line. Both
		/// halves in one test, because the asymmetry is the whole point.
		#[test]
		fn a_match_is_measured_without_a_terminator() {
			let (code, stdout, stderr) = run_rg(&["-o", "-M", "2", "aa"], "aa\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "aa\n", "two bytes of match under a limit of two");

			let (code, stdout, stderr) = run_rg(&["-M", "2", "aa"], "aa\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "[Omitted long matching line]\n", "three bytes of line");
		}

		/// The PREVIEW marker counts as well, and it counts the matches the
		/// preview did not REACH. It also singularizes, which the notice does
		/// not.
		#[test]
		fn a_preview_counts_the_matches_it_did_not_reach() {
			let two = format!("{}aa{}aa{}\n", "x".repeat(60), "y".repeat(30), "z".repeat(30));
			let (code, stdout, stderr) =
				run_rg(&["--column", "-M", "20", "--max-columns-preview", "aa"], &two);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, format!("1:61:{} [... 2 more matches]\n", "x".repeat(20)));

			let one_inside = format!("aa{}aa\n", "x".repeat(80));
			let (code, stdout, stderr) =
				run_rg(&["--column", "-M", "20", "--max-columns-preview", "aa"], &one_inside);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout,
				format!("1:1:aa{} [... 1 more match]\n", "x".repeat(18)),
				"the match inside the preview is not counted, and one left is `1 more match`"
			);
		}

		/// A match that STRADDLES the cut counts as reached, so a line whose only
		/// match begins two characters before the cut previews as `0 more
		/// matches`. Zero takes the plural.
		#[test]
		fn a_match_across_the_cut_counts_as_reached() {
			let text = format!("{}aaaa{}\n", "x".repeat(18), "x".repeat(80));
			let (code, stdout, stderr) =
				run_rg(&["--column", "-M", "20", "--max-columns-preview", "aaaa"], &text);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, format!("1:19:{}aa [... 0 more matches]\n", "x".repeat(18)));
		}

		/// Without a column to print there is no count in the preview either, and
		/// the marker says only that the line went on. A context line says the
		/// same, whatever the run knows.
		#[test]
		fn a_run_with_nothing_to_count_says_only_that_it_stopped() {
			let text = "this is a very long line with match inside it and more text after\n";
			let (code, stdout, stderr) = run_rg(&["-M", "20", "--max-columns-preview", "match"], text);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "this is a very long  [... omitted end of long line]\n");

			let with_context = format!("aa\n{}\n", "y".repeat(40));
			let (code, stdout, stderr) = run_rg(
				&["--column", "-M", "20", "-A", "1", "--max-columns-preview", "aa"],
				&with_context,
			);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout,
				format!("1:1:aa\n2-{} [... omitted end of long line]\n", "y".repeat(20)),
				"a context line has no matches to count"
			);
		}

		/// `-o` previews with the counted marker and always reports ZERO, because
		/// a record holds one match and has already printed it. Three shapes,
		/// since `0` is also what a wrong implementation returns by accident:
		/// two matches on the line, a run with `--column`, and a run with `-r`.
		#[test]
		fn an_only_matching_preview_always_has_nothing_left() {
			let (code, stdout, stderr) =
				run_rg(&["-o", "-M", "1", "--max-columns-preview", "aa"], "aaaa\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a [... 0 more matches]\na [... 0 more matches]\n");

			let (code, stdout, stderr) =
				run_rg(&["-o", "--column", "-M", "1", "--max-columns-preview", "aa"], "aaaa\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:1:a [... 0 more matches]\n1:3:a [... 0 more matches]\n");

			let (code, stdout, stderr) = run_rg(
				&["-o", "-M", "3", "-r", "LONGREPLACEMENT", "--max-columns-preview", "aa"],
				"aa\n",
			);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "LON [... 0 more matches]\n");
		}
	}
	/// What the `rg` builtin says about an input that holds binary data.
	///
	/// THE BUG. The sink had no `binary_data` hook, so the default detection
	/// (`BinaryDetection::quit`) stopped the search at the first NUL and the run
	/// said NOTHING: everything after that byte was dropped and the output
	/// looked like a complete answer. Recall loss with no notice is the one
	/// failure a search tool must not have. ripgrep 15.1.0 reports it, on
	/// stdout, and every byte of the wording here was read off `od -c`.
	///
	/// The two builtins differ here ON PURPOSE, because their reference tools
	/// do: GNU grep moved its notice to stderr in 3.5 and ripgrep never did.
	/// See `a_binary_file_reports_on_stderr` in the `grep` half.
	/// `-m/--max-count` was parsed and reached the kernel, but nothing pinned
	/// what it bounds. It bounds MATCHING LINES, PER FILE, and it is not a
	/// bound on output: trailing context, passthru lines and the summary all
	/// still describe the rest of the file. Every expectation here was measured
	/// against ripgrep 15.1.0 on the same two fixtures.
	/// The operand a caller names is echoed VERBATIM in front of every path
	/// printed from it, and ripgrep normalises nothing on the way. The builtin
	/// used to special-case the operand `.` and strip it, which it could not
	/// help doing, because the implicit root was represented as that same
	/// operand: `rg hit .` printed `a.rs` where ripgrep 15.1.0 prints `./a.rs`.
	/// Every path here was read off ripgrep 15.1.0 in a fixture tree.
	mod an_operand_prints_in_front_of_every_path_from_it {
		use super::*;

		/// One file per extension at the top and one nested two directories down,
		/// so the prefix rule and the walked remainder are both visible.
		fn tree(label: &str) -> TempTree {
			let root = unique_tree(label);
			std::fs::create_dir_all(root.join("sub/deep")).expect("nested dirs should be created");
			std::fs::write(root.join("a.rs"), "hit rust\n").expect("rust fixture");
			std::fs::write(root.join("a.py"), "hit py\n").expect("python fixture");
			std::fs::write(root.join("a.txt"), "hit txt\n").expect("text fixture");
			std::fs::write(root.join("sub/deep/d.rs"), "hit deep\n").expect("nested fixture");
			root
		}

		/// The `.` operand keeps its `./` on every path, nested ones included.
		#[test]
		fn a_dot_operand_keeps_its_dot_slash() {
			let root = tree("prefix-dot");

			let (code, stdout, stderr) = run_rg_in(&["--sort", "path", "hit", "."], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout,
				"./a.py:hit py\n./a.rs:hit rust\n./a.txt:hit txt\n./sub/deep/d.rs:hit deep\n"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// A trailing slash is not doubled, because the prefix is joined as a
		/// path and not concatenated as text.
		#[test]
		fn a_trailing_slash_is_not_doubled() {
			let root = tree("prefix-slash");

			let (code, stdout, stderr) = run_rg_in(&["--sort", "path", "hit", "./"], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout,
				"./a.py:hit py\n./a.rs:hit rust\n./a.txt:hit txt\n./sub/deep/d.rs:hit deep\n"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// An ugly operand survives intact: ripgrep prints `.//./a.py` for
		/// `.//.`, so nothing in this path may normalise or canonicalise what
		/// the caller wrote.
		#[test]
		fn an_unnormalised_operand_survives_intact() {
			let root = tree("prefix-ugly");

			let (code, stdout, stderr) = run_rg_in(&["--sort", "path", "hit", ".//."], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout,
				".//./a.py:hit py\n.//./a.rs:hit rust\n.//./a.txt:hit txt\n.//./sub/deep/d.rs:hit \
				 deep\n"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// A named subdirectory is the prefix, and the walked remainder follows
		/// it.
		#[test]
		fn a_named_directory_is_the_prefix() {
			let root = tree("prefix-sub");

			let (code, stdout, stderr) = run_rg_in(&["--sort", "path", "hit", "sub"], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "sub/deep/d.rs:hit deep\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// An absolute operand prints absolute paths, which is how editors get a
		/// path they can open from any working directory.
		#[test]
		fn an_absolute_operand_prints_absolute_paths() {
			let root = tree("prefix-abs");
			let operand = root.join("sub").to_string_lossy().into_owned();

			let (code, stdout, stderr) = run_rg_in(&["--sort", "path", "hit", &operand], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, format!("{operand}/deep/d.rs:hit deep\n"));
			let _ = std::fs::remove_dir_all(root);
		}

		/// The TWIN that makes the rule a rule rather than a habit: when the
		/// caller names no path at all, ripgrep picks the working directory
		/// itself and prints no prefix, so the same tree reports `a.py` and not
		/// `./a.py`.
		#[test]
		fn an_implicit_root_prints_no_prefix() {
			let root = tree("prefix-implicit");

			let (code, stdout, stderr) = run_rg_no_stdin(&["--sort", "path", "hit"], &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a.py:hit py\na.rs:hit rust\na.txt:hit txt\nsub/deep/d.rs:hit deep\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// The rule holds on every surface that prints a path, not just the
		/// record printer: `-l` names files and `--files` lists them without
		/// searching, and both take the prefix from the operand.
		#[test]
		fn the_other_path_printing_modes_agree() {
			let root = tree("prefix-modes");

			let (code, stdout, stderr) = run_rg_in(&["--sort", "path", "-l", "hit", "."], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./a.py\n./a.rs\n./a.txt\n./sub/deep/d.rs\n");

			let (code, stdout, stderr) = run_rg_in(&["--sort", "path", "--files", "."], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./a.py\n./a.rs\n./a.txt\n./sub/deep/d.rs\n");

			let (code, stdout, stderr) = run_rg_no_stdin(&["--sort", "path", "--files"], &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a.py\na.rs\na.txt\nsub/deep/d.rs\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// A file operand is printed as the caller wrote it too, which is the
		/// case where the walked remainder is empty.
		#[test]
		fn a_file_operand_prints_as_written() {
			let root = tree("prefix-file");

			let (code, stdout, stderr) = run_rg_in(&["-H", "hit", "./sub/deep/d.rs"], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./sub/deep/d.rs:hit deep\n");
			let _ = std::fs::remove_dir_all(root);
		}
	}

	/// `--path-separator` replaces the `/` in every printed path and
	/// `--include-zero` makes a count mode report the files it found nothing
	/// in. Neither flag existed: both exited 2 as unknown flags, so a
	/// Windows-shaped consumer had no way to ask for backslashes and a caller
	/// comparing two trees file by file had no way to see the misses. Measured
	/// against ripgrep 15.1.0.
	mod the_path_and_count_shape_flags {
		use super::*;

		fn tree(label: &str) -> TempTree {
			let root = unique_tree(label);
			std::fs::create_dir_all(root.join("d")).expect("nested dir created");
			std::fs::write(root.join("a.txt"), "hit\nhit\n").expect("a fixture");
			std::fs::write(root.join("d/e.txt"), "hit\n").expect("nested fixture");
			std::fs::write(root.join("nomatch.txt"), "nothing\n").expect("miss fixture");
			root
		}

		/// Every `/` in the printed path becomes the requested byte, including
		/// the one between the operand and the walked remainder: `rg
		/// --path-separator '|' hit .` prints `.|a.txt`, so the operand keeps
		/// its own text and only the slash moves.
		#[test]
		fn the_path_separator_replaces_every_slash() {
			let root = tree("path-separator");

			let (code, stdout, stderr) =
				run_rg_in(&["--sort", "path", "--path-separator", "|", "hit", "."], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, ".|a.txt:hit\n.|a.txt:hit\n.|d|e.txt:hit\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// It reaches the other path-printing modes too, since they print the
		/// same path.
		#[test]
		fn the_path_separator_reaches_every_mode_that_prints_a_path() {
			let root = tree("path-separator-modes");

			let (code, stdout, stderr) =
				run_rg_in(&["--sort", "path", "-l", "--path-separator", "\\", "hit", "."], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, ".\\a.txt\n.\\d\\e.txt\n");

			let (code, stdout, stderr) =
				run_rg_in(&["--sort", "path", "--files", "--path-separator", "\\", "."], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, ".\\a.txt\n.\\d\\e.txt\n.\\nomatch.txt\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// A separator longer than one byte is refused, with ripgrep's message
		/// and its Windows hint, rather than being truncated to the first byte.
		#[test]
		fn a_multi_byte_separator_is_refused() {
			let root = tree("path-separator-long");

			let (code, stdout, stderr) = run_rg_in(&["--path-separator", "XY", "hit", "."], "", &root);

			assert_eq!(code, 2);
			assert_eq!(stdout, "");
			assert_eq!(
				stderr,
				"rg: error parsing flag --path-separator: A path separator must be exactly one byte, \
				 but the given separator is 2 bytes: XY\nIn some shells on Windows '/' is \
				 automatically expanded. Use '//' instead.\n"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// A count mode says nothing about a file it found nothing in, and
		/// `--include-zero` asks for the `0` anyway. Both counts appear, so the
		/// flag changes which FILES are reported and not what the numbers mean.
		#[test]
		fn include_zero_reports_the_files_that_matched_nothing() {
			let root = tree("include-zero");

			let (code, stdout, stderr) = run_rg_in(&["--sort", "path", "-c", "hit", "."], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./a.txt:2\n./d/e.txt:1\n", "the miss is not mentioned");

			let (code, stdout, stderr) =
				run_rg_in(&["--sort", "path", "-c", "--include-zero", "hit", "."], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./a.txt:2\n./d/e.txt:1\n./nomatch.txt:0\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--count-matches` takes it the same way, and a single file that
		/// matched nothing reports `0` while the STATUS still says nothing was
		/// found.
		#[test]
		fn include_zero_keeps_the_no_match_status() {
			let root = tree("include-zero-status");

			let (code, stdout, stderr) = run_rg_in(
				&["--sort", "path", "--count-matches", "--include-zero", "hit", "."],
				"",
				&root,
			);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./a.txt:2\n./d/e.txt:1\n./nomatch.txt:0\n");

			let (code, stdout, stderr) =
				run_rg_in(&["-c", "--include-zero", "hit", "nomatch.txt"], "", &root);
			assert_eq!(code, 1, "printing a zero is not finding a match: {stderr}");
			assert_eq!(stdout, "0\n");
			let _ = std::fs::remove_dir_all(root);
		}
	}

	/// The four separator flags decide what stands between groups of context
	/// lines and between the fields of one record. None of them existed: `rg
	/// --context-separator=XX` exited 2 as an unknown flag, so a caller feeding
	/// the output to a parser that cannot tolerate `--` or `:` had nothing to
	/// reach for. Every byte below was read off ripgrep 15.1.0 with `od -c`.
	mod the_separator_flags_shape_the_output {
		use super::*;

		/// Two matches far enough apart that their context blocks do not touch,
		/// which is the only way to see a group separator at all.
		const HAYSTACK: &str = "a1\na2\nhit1\na4\na5\na6\na7\nhit2\na9\n";

		/// The default separator is `--` on its own record.
		#[test]
		fn the_default_group_separator_is_two_dashes() {
			let (code, stdout, stderr) = run_rg(&["-C1", "-n", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2-a2\n3:hit1\n4-a4\n--\n7-a7\n8:hit2\n9-a9\n");
		}

		/// `--context-separator` replaces it, and the replacement still gets its
		/// own record terminator.
		#[test]
		fn the_group_separator_can_be_replaced() {
			let (code, stdout, stderr) =
				run_rg(&["-C1", "-n", "--context-separator", "XX", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2-a2\n3:hit1\n4-a4\nXX\n7-a7\n8:hit2\n9-a9\n");
		}

		/// An EMPTY separator still prints its terminator, so the groups are
		/// parted by a blank line. `--no-context-separator` prints nothing at
		/// all. The two are different answers and both were measured.
		#[test]
		fn an_empty_separator_is_not_the_same_as_none() {
			let (code, stdout, stderr) =
				run_rg(&["-C1", "-n", "--context-separator", "", "hit"], HAYSTACK);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2-a2\n3:hit1\n4-a4\n\n7-a7\n8:hit2\n9-a9\n", "a blank line");

			let (code, stdout, stderr) =
				run_rg(&["-C1", "-n", "--no-context-separator", "hit"], HAYSTACK);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2-a2\n3:hit1\n4-a4\n7-a7\n8:hit2\n9-a9\n", "nothing at all");
		}

		/// An escape in a separator value is a byte: `\t` is a TAB, because a
		/// shell cannot always pass a control byte through.
		#[test]
		fn an_escape_in_a_separator_is_a_byte() {
			let (code, stdout, stderr) =
				run_rg(&["-C1", "-n", "--context-separator", "\\t", "hit"], HAYSTACK);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2-a2\n3:hit1\n4-a4\n\t\n7-a7\n8:hit2\n9-a9\n");

			let (code, stdout, stderr) =
				run_rg(&["-n", "--field-match-separator", "\\t", "hit"], HAYSTACK);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "3\thit1\n8\thit2\n");

			let (code, stdout, stderr) =
				run_rg(&["-n", "--field-match-separator", "\\x7c", "hit"], HAYSTACK);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "3|hit1\n8|hit2\n", "a hex escape names any byte");
		}

		/// A backslash that starts no escape keeps both of its characters, rather
		/// than being dropped: a dropped one would silently change the
		/// separator.
		#[test]
		fn an_unknown_escape_keeps_its_backslash() {
			let (code, stdout, stderr) =
				run_rg(&["-n", "--field-match-separator", "\\q", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "3\\qhit1\n8\\qhit2\n");
		}

		/// `--field-context-separator` changes the fields of CONTEXT lines only,
		/// and `--field-match-separator` the fields of matching lines only.
		/// Running both halves proves neither reaches the other's records.
		#[test]
		fn the_field_separators_apply_to_their_own_kind_of_line() {
			let (code, stdout, stderr) =
				run_rg(&["-C1", "-n", "--field-context-separator", "%", "hit"], HAYSTACK);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2%a2\n3:hit1\n4%a4\n--\n7%a7\n8:hit2\n9%a9\n");

			let (code, stdout, stderr) =
				run_rg(&["-C1", "-n", "--field-match-separator", "%", "hit"], HAYSTACK);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2-a2\n3%hit1\n4-a4\n--\n7-a7\n8%hit2\n9-a9\n");
		}

		/// The field separator sits after the FILENAME too, not just between the
		/// numbers, which is what a parser splitting on it depends on.
		#[test]
		fn the_field_separator_follows_the_filename() {
			let root = unique_tree("separator-name");
			std::fs::write(root.join("a.txt"), HAYSTACK).expect("fixture written");

			let (code, stdout, stderr) = run_rg_in(
				&[
					"-C1",
					"-n",
					"-H",
					"--field-match-separator",
					"%",
					"--field-context-separator",
					"~",
					"hit",
					"a.txt",
				],
				"",
				&root,
			);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout,
				"a.txt~2~a2\na.txt%3%hit1\na.txt~4~a4\n--\na.txt~7~a7\na.txt%8%hit2\na.txt~9~a9\n"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--vimgrep` puts the match separator between all four of its fields,
		/// since every one of them belongs to a matching line.
		#[test]
		fn vimgrep_uses_the_match_separator_throughout() {
			let root = unique_tree("separator-vimgrep");
			std::fs::write(root.join("a.txt"), HAYSTACK).expect("fixture written");

			let (code, stdout, stderr) =
				run_rg_in(&["--vimgrep", "--field-match-separator", "%", "hit", "a.txt"], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a.txt%3%1%hit1\na.txt%8%1%hit2\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// The context sides are independent: `-A` and `-B` set them separately,
		/// and a later `-A0` overrides the after-side of an earlier `-C1` while
		/// leaving the before-side alone.
		#[test]
		fn the_two_context_sides_are_set_independently() {
			let (code, stdout, stderr) = run_rg(&["-A2", "-B1", "-n", "hit"], HAYSTACK);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2-a2\n3:hit1\n4-a4\n5-a5\n--\n7-a7\n8:hit2\n9-a9\n");

			let (code, stdout, stderr) = run_rg(&["-C1", "-A0", "-n", "hit"], HAYSTACK);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2-a2\n3:hit1\n--\n7-a7\n8:hit2\n");
		}
	}

	/// `-e/--regexp` supplies patterns as values instead of as the first
	/// operand, and several of them are ONE alternation rather than several
	/// searches. That distinction is visible in the output, so it is worth
	/// holding still: the alternation is leftmost-FIRST, so `-e o -e one`
	/// reports `o` where `-e one -e o` reports `one`. Measured against ripgrep
	/// 15.1.0.
	mod patterns_given_as_values_form_one_alternation {
		use super::*;

		const HAYSTACK: &str = "one\ntwo\nthree\nfour\n";

		/// Two patterns match the union of what each would match alone.
		#[test]
		fn several_patterns_match_the_union() {
			let (code, stdout, stderr) = run_rg(&["-n", "-e", "one", "-e", "three"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:one\n3:three\n");
		}

		/// The alternation prefers the pattern written FIRST, not the longest
		/// match, so the two orders give different output on the same input. A
		/// build that sorted or deduplicated the patterns would fail exactly
		/// here.
		#[test]
		fn the_alternation_prefers_the_earlier_pattern() {
			let (code, stdout, stderr) = run_rg(&["-o", "-e", "o", "-e", "one"], HAYSTACK);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "o\no\no\n", "the short pattern comes first, so it wins");

			let (code, stdout, stderr) = run_rg(&["-o", "-e", "one", "-e", "o"], HAYSTACK);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "one\no\no\n", "and the other order reports the longer match");
		}

		/// A value starting with `-` is a value, not a flag, because the flag
		/// before it takes the next argument whatever it looks like. This is
		/// the reason `-e` exists at all, and ripgrep 15.1.0 accepts a hyphen
		/// value for every string-valued flag: `-e -two` searches for `-two`,
		/// `-r -X` replaces with `-X`, and `--glob '-a*'` is a glob. Ours used
		/// to exit 2 with clap's "unexpected argument" instead, which made the
		/// flag useless for exactly the patterns it was added for.
		#[test]
		fn a_value_may_start_with_a_dash() {
			let (code, stdout, stderr) = run_rg(&["-n", "-e", "-two"], "a-two\nb\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:a-two\n");

			let (code, stdout, stderr) = run_rg(&["-o", "-r", "-X", "one"], "one\ntwo\n");
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "-X\n", "a replacement may start with a dash");

			let root = unique_tree("regexp-dash-glob");
			std::fs::write(root.join("-a.txt"), "hit dash\n").expect("fixture written");
			std::fs::write(root.join("b.txt"), "hit b\n").expect("fixture written");
			let (code, stdout, stderr) =
				run_rg_in(&["--sort", "path", "--glob", "-a*", "hit", "."], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./-a.txt:hit dash\n", "a glob may start with a dash");
			let _ = std::fs::remove_dir_all(root);
		}

		/// An empty pattern matches every line, which is the boundary a
		/// `!is_empty` guard would quietly turn into "no patterns given".
		#[test]
		fn an_empty_pattern_matches_every_line() {
			let (code, stdout, stderr) = run_rg(&["-n", "-e", ""], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:one\n2:two\n3:three\n4:four\n");
		}

		/// A flag that applies to the pattern applies to the whole alternation:
		/// with `-w`, `hree` matches nothing even though `three` contains it.
		#[test]
		fn a_word_boundary_applies_to_every_pattern() {
			let (code, stdout, stderr) = run_rg(&["-n", "-w", "-e", "one", "-e", "hree"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:one\n");
		}

		/// Once `-e` is given, the first positional argument is a FILE and not
		/// the pattern. Measured on ripgrep 15.1.0: `rg -e one two a.txt`
		/// reports `two` as missing, searches `a.txt` anyway, and exits 2
		/// because a named operand could not be read.
		#[test]
		fn the_first_operand_is_a_file_once_a_pattern_was_given() {
			let root = unique_tree("regexp-operand");
			std::fs::write(root.join("a.txt"), HAYSTACK).expect("fixture written");

			let (code, stdout, stderr) = run_rg_in(&["-n", "-e", "one", "two", "a.txt"], "", &root);

			assert_eq!(code, 2, "an operand that cannot be read is an error");
			assert_eq!(stdout, "a.txt:1:one\n", "the readable operand is still searched");
			assert!(stderr.contains("rg: two: "), "the diagnostic names the operand: {stderr:?}");
			let _ = std::fs::remove_dir_all(root);
		}

		/// Patterns from `-f` and from `-e` join the same alternation, in that
		/// order.
		#[test]
		fn pattern_files_and_values_join_the_same_alternation() {
			let root = unique_tree("regexp-file");
			std::fs::write(root.join("pats.txt"), "four\n").expect("pattern file written");
			std::fs::write(root.join("a.txt"), HAYSTACK).expect("fixture written");

			let (code, stdout, stderr) =
				run_rg_in(&["-n", "-f", "pats.txt", "-e", "one", "a.txt"], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:one\n4:four\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `-f -` reads the patterns from stdin, which leaves the operand as the
		/// only thing left to search.
		#[test]
		fn a_pattern_file_may_be_stdin() {
			let root = unique_tree("regexp-stdin");
			std::fs::write(root.join("a.txt"), HAYSTACK).expect("fixture written");

			let (code, stdout, stderr) = run_rg_in(&["-n", "-f", "-", "a.txt"], "one\n", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:one\n");
			let _ = std::fs::remove_dir_all(root);
		}
	}

	/// `--sort` and `--sortr` promise an order, and only `path` was implemented:
	/// every other key was accepted and IGNORED, so `--sort modified` returned
	/// files in whatever order the parallel walk finished them in while
	/// claiming to be sorted. An unrecognised key was accepted too. Measured
	/// against ripgrep 15.1.0.
	mod the_sort_keys_order_the_files_they_name {
		use super::*;

		/// Three files with known modification times, deliberately not in path
		/// order, so a path sort and a time sort cannot produce the same
		/// answer.
		fn tree(label: &str) -> TempTree {
			let root = unique_tree(label);
			for (name, seconds) in [("a.txt", 1_000), ("b.txt", 3_000), ("c.txt", 2_000)] {
				let path = root.join(name);
				std::fs::write(&path, format!("hit {name}\n")).expect("fixture written");
				let time = filetime(seconds);
				set_times(&path, time);
			}
			root
		}

		fn filetime(seconds: u64) -> std::time::SystemTime {
			std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000 + seconds)
		}

		fn set_times(path: &Path, time: std::time::SystemTime) {
			let file = std::fs::File::options()
				.write(true)
				.open(path)
				.expect("fixture should open for writing");
			file
				.set_times(
					std::fs::FileTimes::new()
						.set_accessed(time)
						.set_modified(time),
				)
				.expect("fixture times should be settable");
		}

		fn search(root: &Path, args: &[&str]) -> String {
			let mut full = args.to_vec();
			full.extend_from_slice(&["hit", "."]);
			let (code, stdout, stderr) = run_rg_in(&full, "", root);
			assert_eq!(code, 0, "{args:?}: {stderr}");
			stdout
		}

		/// The path key orders by path, and the reverse form reverses it.
		#[test]
		fn the_path_key_orders_by_path() {
			let root = tree("sort-path");

			assert_eq!(
				search(&root, &["--sort", "path"]),
				"./a.txt:hit a.txt\n./b.txt:hit b.txt\n./c.txt:hit c.txt\n"
			);
			assert_eq!(
				search(&root, &["--sortr", "path"]),
				"./c.txt:hit c.txt\n./b.txt:hit b.txt\n./a.txt:hit a.txt\n"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// Paths compare COMPONENT BY COMPONENT, so `sub/a.txt` sorts before
		/// `sub.txt`: the first components are `sub` and `sub.txt`. A plain
		/// string comparison would put `sub.txt` first, because `.` is below
		/// `/` in ASCII. Measured on ripgrep 15.1.0, and it is what Rust's
		/// `Path` ordering already does.
		#[test]
		fn paths_compare_component_by_component() {
			let root = unique_tree("sort-components");
			std::fs::create_dir_all(root.join("sub")).expect("sub created");
			std::fs::write(root.join("sub/a.txt"), "hit deep\n").expect("deep fixture");
			std::fs::write(root.join("sub.txt"), "hit flat\n").expect("flat fixture");
			std::fs::write(root.join("z.txt"), "hit z\n").expect("z fixture");

			assert_eq!(
				search(&root, &["--sort", "path"]),
				"./sub/a.txt:hit deep\n./sub.txt:hit flat\n./z.txt:hit z\n"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// The modified key orders oldest first, which on this tree is neither
		/// path order nor its reverse, and the reverse form is newest first.
		#[test]
		fn the_modified_key_orders_oldest_first() {
			let root = tree("sort-modified");

			assert_eq!(
				search(&root, &["--sort", "modified"]),
				"./a.txt:hit a.txt\n./c.txt:hit c.txt\n./b.txt:hit b.txt\n"
			);
			assert_eq!(
				search(&root, &["--sortr", "modified"]),
				"./b.txt:hit b.txt\n./c.txt:hit c.txt\n./a.txt:hit a.txt\n"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// The accessed key reads the other timestamp, set to the same values
		/// here, so the order matches. Without this case `accessed` could route
		/// to the modified time and nothing would notice.
		#[test]
		fn the_accessed_key_orders_by_access_time() {
			let root = tree("sort-accessed");

			assert_eq!(
				search(&root, &["--sort", "accessed"]),
				"./a.txt:hit a.txt\n./c.txt:hit c.txt\n./b.txt:hit b.txt\n"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// `created` is accepted, and on a platform that records a creation time
		/// the files come back in the order they were made. The fixtures are
		/// written in path order, so that is the expected answer here.
		#[test]
		fn the_created_key_is_accepted() {
			let root = tree("sort-created");

			assert_eq!(
				search(&root, &["--sort", "created"]),
				"./a.txt:hit a.txt\n./b.txt:hit b.txt\n./c.txt:hit c.txt\n"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// `none` is a real key meaning "do not sort", so it is not an error and
		/// the search still finds all three files.
		#[test]
		fn the_none_key_asks_for_no_order() {
			let root = tree("sort-none");

			let mut lines = search(&root, &["--sort", "none"])
				.lines()
				.map(str::to_owned)
				.collect::<Vec<_>>();
			lines.sort();
			assert_eq!(lines, ["./a.txt:hit a.txt", "./b.txt:hit b.txt", "./c.txt:hit c.txt"]);
			let _ = std::fs::remove_dir_all(root);
		}

		/// An unrecognised key exits 2 with ripgrep's wording, naming the flag it
		/// came from, rather than being accepted and ignored. A silently
		/// ignored sort key answers a different question than the one asked.
		#[test]
		fn an_unrecognised_key_is_refused() {
			let root = tree("sort-bogus");

			let (code, stdout, stderr) = run_rg_in(&["--sort", "bogus", "hit", "."], "", &root);
			assert_eq!(code, 2);
			assert_eq!(stdout, "");
			assert_eq!(stderr, "rg: error parsing flag --sort: choice 'bogus' is unrecognized\n");

			let (code, _, stderr) = run_rg_in(&["--sortr", "bogus", "hit", "."], "", &root);
			assert_eq!(code, 2);
			assert_eq!(
				stderr, "rg: error parsing flag --sortr: choice 'bogus' is unrecognized\n",
				"the message names the flag that carried the key"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--sort` and `--sortr` override each other, so the one written LAST
		/// wins in both directions.
		#[test]
		fn the_last_of_the_two_flags_wins() {
			let root = tree("sort-override");

			assert_eq!(
				search(&root, &["--sort", "path", "--sortr", "path"]),
				"./c.txt:hit c.txt\n./b.txt:hit b.txt\n./a.txt:hit a.txt\n"
			);
			assert_eq!(
				search(&root, &["--sortr", "path", "--sort", "path"]),
				"./a.txt:hit a.txt\n./b.txt:hit b.txt\n./c.txt:hit c.txt\n"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--sort-files` is the deprecated spelling of `--sort path`, and
		/// `--no-sort-files` cancels it, with the last of the pair winning.
		#[test]
		fn the_deprecated_alias_still_sorts() {
			let root = tree("sort-alias");

			assert_eq!(
				search(&root, &["--sort-files"]),
				"./a.txt:hit a.txt\n./b.txt:hit b.txt\n./c.txt:hit c.txt\n"
			);

			let mut lines = search(&root, &["--sort-files", "--no-sort-files"])
				.lines()
				.map(str::to_owned)
				.collect::<Vec<_>>();
			lines.sort();
			assert_eq!(
				lines,
				["./a.txt:hit a.txt", "./b.txt:hit b.txt", "./c.txt:hit c.txt"],
				"cancelling the alias leaves the search unordered, not empty"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--files` takes the same order, because it is the same walk with the
		/// search left out. With no operand these are implicit-root paths, so
		/// they print with no prefix, which is the other rule this run happens
		/// to prove.
		#[test]
		fn the_files_mode_takes_the_same_order() {
			let root = tree("sort-files-mode");

			let (code, stdout, stderr) = run_rg_in(&["--sort", "modified", "--files"], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a.txt\nc.txt\nb.txt\n");

			let (code, stdout, stderr) = run_rg_in(&["--sortr", "path", "--files"], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "c.txt\nb.txt\na.txt\n");

			let (code, stdout, stderr) = run_rg_in(&["--sort", "path", "--files", "."], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./a.txt\n./b.txt\n./c.txt\n", "a named operand prints in front");
			let _ = std::fs::remove_dir_all(root);
		}
	}

	/// Each `--no-ignore-*` flag turns off ONE ignore source, and the whole
	/// family was parsed and wired to nothing: the walk had a single switch
	/// covering every source, so `--no-ignore-dot` and `--no-ignore-vcs` did
	/// nothing at all. Every expectation was measured against ripgrep 15.1.0 on
	/// the same fixtures.
	mod each_no_ignore_flag_turns_off_one_source {
		use super::*;

		/// A repository whose `.gitignore` hides one file, whose `.ignore` hides
		/// another, and whose exclude file hides a third.
		fn tree(label: &str) -> TempTree {
			let root = unique_tree(label);
			std::fs::create_dir_all(root.join(".git/info")).expect(".git/info created");
			std::fs::write(root.join(".gitignore"), "g.txt\n").expect("gitignore written");
			std::fs::write(root.join(".ignore"), "d.txt\n").expect("dot ignore written");
			std::fs::write(root.join(".git/info/exclude"), "e.txt\n").expect("exclude written");
			std::fs::write(root.join("g.txt"), "hit g\n").expect("g fixture");
			std::fs::write(root.join("d.txt"), "hit d\n").expect("d fixture");
			std::fs::write(root.join("e.txt"), "hit e\n").expect("e fixture");
			std::fs::write(root.join("z.txt"), "hit z\n").expect("z fixture");
			root
		}

		fn search(root: &Path, args: &[&str]) -> String {
			let mut full = vec!["--sort", "path"];
			full.extend_from_slice(args);
			full.extend_from_slice(&["hit", "."]);
			let (_, stdout, stderr) = run_rg_in(&full, "", root);
			assert_eq!(stderr, "", "{args:?} should not report anything");
			stdout
		}

		/// All three sources apply by default, so only the plain file is
		/// searched.
		#[test]
		fn all_three_sources_apply_by_default() {
			let root = tree("no-ignore-default");

			assert_eq!(search(&root, &[]), "./z.txt:hit z\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--no-ignore-dot` drops `.ignore` and keeps the other two.
		#[test]
		fn no_ignore_dot_drops_the_dot_ignore_file_only() {
			let root = tree("no-ignore-dot");

			assert_eq!(search(&root, &["--no-ignore-dot"]), "./d.txt:hit d\n./z.txt:hit z\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--no-ignore-vcs` drops BOTH git sources, `.gitignore` and the
		/// repository's exclude file, and keeps `.ignore`. That is the flag's
		/// whole point: git's files go, the tool-neutral one stays.
		#[test]
		fn no_ignore_vcs_drops_both_git_sources() {
			let root = tree("no-ignore-vcs");

			assert_eq!(
				search(&root, &["--no-ignore-vcs"]),
				"./e.txt:hit e\n./g.txt:hit g\n./z.txt:hit z\n"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--no-ignore-exclude` drops only the repository's exclude file, so
		/// `.gitignore` still applies. Without this case the flag could share a
		/// switch with `--no-ignore-vcs` and nothing would notice.
		#[test]
		fn no_ignore_exclude_drops_the_exclude_file_only() {
			let root = tree("no-ignore-exclude");

			assert_eq!(search(&root, &["--no-ignore-exclude"]), "./e.txt:hit e\n./z.txt:hit z\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--no-ignore` drops every source at once, which is the master switch
		/// the others are carved out of.
		#[test]
		fn no_ignore_drops_every_source() {
			let root = tree("no-ignore-all");

			assert_eq!(
				search(&root, &["--no-ignore"]),
				"./d.txt:hit d\n./e.txt:hit e\n./g.txt:hit g\n./z.txt:hit z\n"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// Each flag has an `--ignore-*` partner, and the one written LAST wins,
		/// the way every other pair in this tool resolves. A conjunction such
		/// as `no_dot && !dot` would get one of the two orders wrong.
		#[test]
		fn the_partner_flag_wins_when_written_last() {
			let root = tree("no-ignore-partner");

			assert_eq!(
				search(&root, &["--no-ignore-dot", "--ignore-dot"]),
				"./z.txt:hit z\n",
				"the partner restores the source"
			);
			assert_eq!(
				search(&root, &["--ignore-dot", "--no-ignore-dot"]),
				"./d.txt:hit d\n./z.txt:hit z\n",
				"and the other order turns it off again"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// A parent directory's ignore files reach into a subdirectory, and
		/// `--no-ignore-parent` stops that. Measured on ripgrep 15.1.0 searching
		/// from `child/`: the repository root's `.gitignore` and `.ignore` both
		/// apply, and the flag drops both.
		#[test]
		fn no_ignore_parent_stops_reading_above_the_root() {
			let root = unique_tree("no-ignore-parent");
			std::fs::create_dir_all(root.join(".git")).expect(".git created");
			std::fs::create_dir_all(root.join("child")).expect("child created");
			std::fs::write(root.join(".gitignore"), "x.txt\n").expect("gitignore written");
			std::fs::write(root.join(".ignore"), "y.txt\n").expect("dot ignore written");
			std::fs::write(root.join("child/x.txt"), "hit x\n").expect("x fixture");
			std::fs::write(root.join("child/y.txt"), "hit y\n").expect("y fixture");
			std::fs::write(root.join("child/z.txt"), "hit z\n").expect("z fixture");
			let child = root.join("child");

			let (code, stdout, stderr) = run_rg_in(&["--sort", "path", "hit", "."], "", &child);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./z.txt:hit z\n", "the parent's rules reach down here");

			let (code, stdout, stderr) =
				run_rg_in(&["--sort", "path", "--no-ignore-parent", "hit", "."], "", &child);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "./x.txt:hit x\n./y.txt:hit y\n./z.txt:hit z\n",
				"and the flag stops reading them"
			);
			let _ = std::fs::remove_dir_all(root);
		}
	}

	/// The type filters and `--max-depth` decide which files a walk reaches, and
	/// nothing pinned either. Both are the kind of filter whose failure is
	/// silent: a file that is never searched cannot report a match, so a wrong
	/// answer here reads as "no results". Measured against ripgrep 15.1.0.
	/// Which files a walk is allowed to reach: the ignore rules, the hidden rule
	/// and the size limit. Each of these can only ever REMOVE files, so a
	/// mistake in one reads as "no results" rather than as an error, and that
	/// is why every case below asserts the exact set of files reached. Measured
	/// against ripgrep 15.1.0.
	mod the_walk_filters_decide_which_files_are_reachable {
		use super::*;

		/// A tree with one plain file, one gitignored file, one hidden file and a
		/// `.git` directory holding a file, which is the smallest tree that
		/// separates the three rules.
		fn tree(label: &str) -> TempTree {
			let root = unique_tree(label);
			std::fs::create_dir_all(root.join(".git")).expect(".git should be created");
			std::fs::write(root.join(".git/config"), "hit git\n").expect("git fixture");
			std::fs::write(root.join(".hidden.txt"), "hit hidden\n").expect("hidden fixture");
			std::fs::write(root.join(".gitignore"), "ignored.txt\n").expect("ignore rules");
			std::fs::write(root.join("ignored.txt"), "hit ignored\n").expect("ignored fixture");
			std::fs::write(root.join("plain.txt"), "hit plain\n").expect("plain fixture");
			root
		}

		/// By default only the plain file is reachable: the ignore rules remove
		/// one file and the hidden rule removes the other two.
		#[test]
		fn the_default_reaches_neither_ignored_nor_hidden_files() {
			let root = tree("filters-default");

			let (code, stdout, stderr) = run_rg_in(&["--sort", "path", "hit", "."], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./plain.txt:hit plain\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `.gitignore` needs a repository. It describes what git tracks, so git
		/// reads it only inside a repository and so does ripgrep: measured on
		/// ripgrep 15.1.0, the same tree without a `.git` searches the
		/// "ignored" file, and adding `.git` stops it. `--no-require-git` asks
		/// for the rules anyway. Ours applied them everywhere, so a directory
		/// that merely holds a `.gitignore` had files removed from the search
		/// with nothing said about it.
		#[test]
		fn gitignore_needs_a_repository_unless_told_otherwise() {
			let root = unique_tree("filters-no-repo");
			std::fs::write(root.join(".gitignore"), "ignored.txt\n").expect("ignore rules");
			std::fs::write(root.join("ignored.txt"), "hit ignored\n").expect("ignored fixture");
			std::fs::write(root.join("plain.txt"), "hit plain\n").expect("plain fixture");

			let (code, stdout, stderr) = run_rg_in(&["--sort", "path", "hit", "."], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "./ignored.txt:hit ignored\n./plain.txt:hit plain\n",
				"no repository, so the git file does not apply"
			);

			let (code, stdout, stderr) =
				run_rg_in(&["--sort", "path", "--no-require-git", "hit", "."], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./plain.txt:hit plain\n", "the flag asks for them anyway");

			std::fs::create_dir_all(root.join(".git")).expect(".git should be created");
			let (code, stdout, stderr) = run_rg_in(&["--sort", "path", "hit", "."], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./plain.txt:hit plain\n", "a repository makes them apply");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `.ignore` is not a git file, so it applies with no repository in
		/// sight. This is the twin that keeps the rule above about GIT files
		/// rather than about ignore files in general, and `--no-ignore-dot` is
		/// what turns it off.
		#[test]
		fn a_dot_ignore_file_applies_without_a_repository() {
			let root = unique_tree("filters-dot-ignore");
			std::fs::write(root.join(".ignore"), "ignored.txt\n").expect("ignore rules");
			std::fs::write(root.join("ignored.txt"), "hit ignored\n").expect("ignored fixture");
			std::fs::write(root.join("plain.txt"), "hit plain\n").expect("plain fixture");

			let (code, stdout, stderr) = run_rg_in(&["--sort", "path", "hit", "."], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./plain.txt:hit plain\n", "no repository needed for `.ignore`");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--no-ignore` drops the ignore rules and nothing else: the hidden
		/// files stay out.
		#[test]
		fn no_ignore_drops_the_rules_and_keeps_the_hidden_rule() {
			let root = tree("filters-no-ignore");

			let (code, stdout, stderr) =
				run_rg_in(&["--sort", "path", "--no-ignore", "hit", "."], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./ignored.txt:hit ignored\n./plain.txt:hit plain\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--hidden` is the mirror image: the hidden files arrive, the ignored
		/// one does not. `.git/config` arrives with them, because ripgrep has
		/// no rule about `.git` beyond it being hidden.
		#[test]
		fn hidden_drops_the_hidden_rule_and_reaches_dot_git() {
			let root = tree("filters-hidden");

			let (code, stdout, stderr) =
				run_rg_in(&["--sort", "path", "--hidden", "hit", "."], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout,
				"./.git/config:hit git\n./.hidden.txt:hit hidden\n./plain.txt:hit plain\n"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// `-u` is one step of unrestriction and equals `--no-ignore`; `-uu` adds
		/// the hidden files. The levels are cumulative, so `-uu` reaches
		/// everything both single flags reach.
		#[test]
		fn unrestricted_levels_are_cumulative() {
			let root = tree("filters-unrestricted");

			let (code, stdout, stderr) = run_rg_in(&["--sort", "path", "-u", "hit", "."], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "./ignored.txt:hit ignored\n./plain.txt:hit plain\n",
				"one level is the ignore rules only"
			);

			let (code, stdout, stderr) = run_rg_in(&["--sort", "path", "-uu", "hit", "."], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout,
				"./.git/config:hit git\n./.hidden.txt:hit hidden\n./ignored.txt:hit \
				 ignored\n./plain.txt:hit plain\n",
				"two levels are both rules"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// An explicit include glob outranks BOTH other rules: `--iglob '*.TXT'`
		/// matches case-insensitively and brings back the hidden and ignored
		/// files, because a caller who names a glob has said what they want
		/// searched.
		#[test]
		fn an_include_glob_outranks_the_ignore_and_hidden_rules() {
			let root = tree("filters-iglob");

			let (code, stdout, stderr) =
				run_rg_in(&["--sort", "path", "--iglob", "*.TXT", "hit", "."], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout,
				"./.hidden.txt:hit hidden\n./ignored.txt:hit ignored\n./plain.txt:hit plain\n"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// The directory half of the glob rule. A glob only reaches inside a
		/// pruned directory when it names the directory too: measured on
		/// ripgrep 15.1.0, `--glob 'skipdir/*'` finds nothing in a tree where
		/// `skipdir/` is gitignored, while `--glob '*'` reaches every file
		/// including the ones under `.git`.
		#[test]
		fn a_glob_reaches_into_a_pruned_directory_only_when_it_names_it() {
			let root = unique_tree("filters-glob-dirs");
			std::fs::create_dir_all(root.join(".git")).expect(".git created");
			std::fs::create_dir_all(root.join("skipdir")).expect("ignored dir created");
			std::fs::write(root.join(".git/config"), "hit git\n").expect("git fixture");
			std::fs::write(root.join(".gitignore"), "skipdir/\n").expect("ignore rules");
			std::fs::write(root.join("skipdir/a.txt"), "hit deep\n").expect("ignored-dir fixture");
			std::fs::write(root.join("plain.txt"), "hit plain\n").expect("plain fixture");

			let (code, stdout, _) =
				run_rg_in(&["--sort", "path", "--glob", "skipdir/*", "hit", "."], "", &root);
			assert_eq!(code, 1, "the directory was never whitelisted, so nothing was searched");
			assert_eq!(stdout, "");

			let (code, stdout, stderr) =
				run_rg_in(&["--sort", "path", "--glob", "*", "hit", "."], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "./.git/config:hit git\n./plain.txt:hit plain\n./skipdir/a.txt:hit deep\n",
				"`*` names every component, so both pruned directories open up"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// The case-sensitive twin: `--glob '*.TXT'` matches nothing in this
		/// tree, so the run reports no match. Without this, the case above
		/// would pass for a build that ignored the glob entirely.
		#[test]
		fn a_case_sensitive_glob_matches_nothing_here() {
			let root = tree("filters-glob-case");

			let (code, stdout, stderr) =
				run_rg_in(&["--sort", "path", "--glob", "*.TXT", "hit", "."], "", &root);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--max-filesize` removes a file over the limit and keeps one under it,
		/// and the suffixes are binary multiples: `1K` is 1024 bytes.
		#[test]
		fn a_size_limit_removes_the_files_over_it() {
			let root = unique_tree("filters-size");
			std::fs::write(root.join("small.txt"), "hit small\n").expect("small fixture");
			let mut big = String::from("hit big\n");
			big.push_str(&"x".repeat(3000));
			big.push('\n');
			std::fs::write(root.join("big.txt"), &big).expect("big fixture");

			let (code, stdout, stderr) = run_rg_in(&["--sort", "path", "hit", "."], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./big.txt:hit big\n./small.txt:hit small\n", "both without a limit");

			let (code, stdout, stderr) =
				run_rg_in(&["--sort", "path", "--max-filesize", "1K", "hit", "."], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./small.txt:hit small\n", "1K is 1024 bytes, so the 3 KB file goes");

			let (code, stdout, stderr) =
				run_rg_in(&["--sort", "path", "--max-filesize", "3001", "hit", "."], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./small.txt:hit small\n", "a plain number is bytes");
			let _ = std::fs::remove_dir_all(root);
		}

		/// A limit of zero admits nothing here, and reports the no-match status
		/// rather than treating zero as "no limit".
		#[test]
		fn a_size_limit_of_zero_admits_nothing() {
			let root = unique_tree("filters-size-zero");
			std::fs::write(root.join("small.txt"), "hit small\n").expect("small fixture");

			let (code, stdout, stderr) = run_rg_in(&["--max-filesize", "0", "hit", "."], "", &root);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "");
			assert_eq!(stderr, "");
			let _ = std::fs::remove_dir_all(root);
		}
	}

	mod the_type_filters_and_depth_decide_what_is_searched {
		use super::*;

		fn tree(label: &str) -> TempTree {
			let root = unique_tree(label);
			std::fs::create_dir_all(root.join("sub/deep")).expect("nested dirs should be created");
			std::fs::write(root.join("a.rs"), "hit rust\n").expect("rust fixture");
			std::fs::write(root.join("a.py"), "hit py\n").expect("python fixture");
			std::fs::write(root.join("a.txt"), "hit txt\n").expect("text fixture");
			std::fs::write(root.join("sub/deep/d.rs"), "hit deep\n").expect("nested fixture");
			root
		}

		/// `-t rust` keeps the Rust files at any depth and drops the rest.
		#[test]
		fn a_selected_type_keeps_only_that_type() {
			let root = tree("type-select");

			let (code, stdout, stderr) =
				run_rg_in(&["--sort", "path", "-t", "rust", "hit", "."], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./a.rs:hit rust\n./sub/deep/d.rs:hit deep\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `-T rust` is the exact complement: everything the selection kept is
		/// gone and everything it dropped is here.
		#[test]
		fn a_negated_type_is_the_complement() {
			let root = tree("type-negate");

			let (code, stdout, stderr) =
				run_rg_in(&["--sort", "path", "-T", "rust", "hit", "."], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./a.py:hit py\n./a.txt:hit txt\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// Two selections are a union, not an intersection, so nothing is lost by
		/// naming a second type.
		#[test]
		fn two_selections_are_a_union() {
			let root = tree("type-union");

			let (code, stdout, stderr) =
				run_rg_in(&["--sort", "path", "-t", "rust", "-t", "py", "hit", "."], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./a.py:hit py\n./a.rs:hit rust\n./sub/deep/d.rs:hit deep\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--type-add` defines a new type, and defining one against an EXISTING
		/// name extends it rather than replacing it: `rust:*.txt` leaves `*.rs`
		/// selected and adds `*.txt` to it.
		#[test]
		fn adding_a_type_defines_or_extends_it() {
			let root = tree("type-add");

			let (code, stdout, stderr) = run_rg_in(
				&["--sort", "path", "--type-add", "mine:*.txt", "-t", "mine", "hit", "."],
				"",
				&root,
			);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./a.txt:hit txt\n");

			let (code, stdout, stderr) = run_rg_in(
				&["--sort", "path", "--type-add", "rust:*.txt", "-t", "rust", "hit", "."],
				"",
				&root,
			);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "./a.rs:hit rust\n./a.txt:hit txt\n./sub/deep/d.rs:hit deep\n",
				"the added glob joins the type instead of replacing its globs"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--type-clear` removes the definition entirely, so selecting the
		/// cleared name afterwards is an error rather than a silently empty
		/// filter. A filter that matched nothing would look exactly like a
		/// search with no results, which is the failure this refuses.
		#[test]
		fn a_cleared_type_is_no_longer_a_type() {
			let root = tree("type-clear");

			let (code, stdout, stderr) =
				run_rg_in(&["--type-clear", "rust", "-t", "rust", "hit", "."], "", &root);

			assert_eq!(code, 2, "an unusable filter is an error, not an empty result");
			assert_eq!(stdout, "");
			assert!(
				stderr.contains("unrecognized file type: rust"),
				"the diagnostic names the type: {stderr:?}"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// A type that was never defined reports the same way, with status 2.
		#[test]
		fn an_unknown_type_is_refused() {
			let root = tree("type-unknown");

			let (code, stdout, stderr) = run_rg_in(&["-t", "nope", "hit", "."], "", &root);

			assert_eq!(code, 2);
			assert_eq!(stdout, "");
			assert!(stderr.contains("unrecognized file type: nope"), "{stderr:?}");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--type-list` prints every definition as `name: glob, glob`, the
		/// built-in ones and the added ones, with each type's globs in sorted
		/// order. Repeating the flag for one name accumulates globs, which is
		/// how a type gains a second extension.
		#[test]
		fn the_type_list_shows_definitions_including_added_ones() {
			let root = tree("type-list");

			let (code, stdout, stderr) = run_rg_in(
				&["--type-add", "mine:*.veyyon", "--type-add", "mine:*.txt", "--type-list"],
				"",
				&root,
			);

			assert_eq!(code, 0, "{stderr}");
			assert!(stdout.contains("ada: *.adb, *.ads\n"), "a built-in definition is listed");
			assert!(stdout.contains("mine: *.txt, *.veyyon\n"), "both globs, sorted: {stdout:?}");
			let _ = std::fs::remove_dir_all(root);
		}

		/// A comma in a `--type-add` value is NOT a separator:
		/// `mine:*.veyyon,*.txt` defines one glob whose text contains a comma,
		/// which matches no real file. Measured against ripgrep 15.1.0, which
		/// lists it as the single glob `*.veyyon,*.txt` and finds nothing with
		/// it. Anyone reading the flag as a list gets an empty search rather
		/// than an error, so the shape is worth holding still.
		#[test]
		fn a_comma_in_a_definition_is_part_of_the_glob() {
			let root = tree("type-add-comma");

			let (code, stdout, stderr) =
				run_rg_in(&["--type-add", "mine:*.veyyon,*.txt", "--type-list"], "", &root);
			assert_eq!(code, 0, "{stderr}");
			assert!(stdout.contains("mine: *.veyyon,*.txt\n"), "one glob, comma included: {stdout:?}");

			let (code, stdout, _) =
				run_rg_in(&["--type-add", "mine:*.veyyon,*.txt", "-t", "mine", "hit", "."], "", &root);
			assert_eq!(code, 1, "the comma glob matches no file in the tree");
			assert_eq!(stdout, "");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--max-depth 1` reaches the operand's own entries and no deeper.
		#[test]
		fn a_depth_of_one_reaches_the_top_level_only() {
			let root = tree("depth-one");

			let (code, stdout, stderr) =
				run_rg_in(&["--sort", "path", "--max-depth", "1", "hit", "."], "", &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./a.py:hit py\n./a.rs:hit rust\n./a.txt:hit txt\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--max-depth 0` searches nothing at all and reports the no-match
		/// status. This is the boundary a `depth > 0` guard would quietly turn
		/// into "unlimited", searching the whole tree when the caller asked for
		/// none of it.
		#[test]
		fn a_depth_of_zero_searches_nothing() {
			let root = tree("depth-zero");

			let (code, stdout, stderr) = run_rg_in(&["--max-depth", "0", "hit", "."], "", &root);

			assert_eq!(code, 1, "nothing was searched, so nothing matched");
			assert_eq!(stdout, "");
			assert_eq!(stderr, "");
			let _ = std::fs::remove_dir_all(root);
		}
	}

	mod max_count_bounds_matching_lines_per_file {
		use super::*;

		/// Two matching lines, a non-matching line between them, and two more
		/// after.
		const HAYSTACK: &str = "one hit\ntwo\nthree hit\nfour hit\nfive\n";

		/// The cap stops the search at the second matching line, so the third and
		/// fourth never print.
		#[test]
		fn the_cap_counts_matching_lines() {
			let (code, stdout, stderr) = run_rg(&["-m2", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "one hit\nthree hit\n");
		}

		/// Each file gets its own budget: `-m2` over two files prints two lines
		/// from each, not two lines in total. `--sort path` is what makes the
		/// order here something a test may assert, because the walk is
		/// otherwise parallel.
		#[test]
		fn every_file_gets_its_own_budget() {
			let tree = unique_tree("max-count-per-file");
			std::fs::write(tree.join("a.txt"), HAYSTACK).expect("first fixture should be written");
			std::fs::write(tree.join("b.txt"), "six hit\nseven hit\neight hit\n")
				.expect("second fixture should be written");

			let (code, stdout, stderr) =
				run_rg_in(&["--sort", "path", "-m2", "-n", "hit", "a.txt", "b.txt"], "", &tree);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout,
				"a.txt:1:one hit\na.txt:3:three hit\nb.txt:1:six hit\nb.txt:2:seven hit\n"
			);
			let _ = std::fs::remove_dir_all(tree);
		}

		/// A count is capped the same way, per file, because the cap ends the
		/// search rather than filtering what a finished search reports.
		#[test]
		fn a_count_is_capped_too() {
			let (code, stdout, stderr) = run_rg(&["-m2", "-c", "hit"], HAYSTACK);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2\n");

			let tree = unique_tree("max-count-count");
			std::fs::write(tree.join("a.txt"), HAYSTACK).expect("first fixture should be written");
			std::fs::write(tree.join("b.txt"), "six hit\nseven hit\neight hit\n")
				.expect("second fixture should be written");
			let (code, stdout, stderr) =
				run_rg_in(&["--sort", "path", "-m2", "-c", "hit", "a.txt", "b.txt"], "", &tree);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a.txt:2\nb.txt:2\n");
			let _ = std::fs::remove_dir_all(tree);
		}

		/// `--count-matches` reports MATCHES while the cap counts LINES, so the
		/// two numbers differ on purpose: `h` matches once on `one hit` and
		/// twice on `three hit`, and the cap of two lines still lets all three
		/// be counted.
		#[test]
		fn counting_matches_can_exceed_the_line_cap() {
			let (code, stdout, stderr) = run_rg(&["-m2", "--count-matches", "h"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "3\n", "two lines, three matches on them");
		}

		/// A cap of zero permits no match at all, so the run reports failure with
		/// nothing on either stream. This is the boundary that a `> 0` check
		/// would silently turn into "unlimited".
		#[test]
		fn a_zero_cap_finds_nothing() {
			let (code, stdout, stderr) = run_rg(&["-m0", "hit"], HAYSTACK);

			assert_eq!(code, 1, "no match is permitted, so the status is the no-match status");
			assert_eq!(stdout, "");
			assert_eq!(stderr, "");
		}

		/// The cap bounds matches, not output: the trailing context after the
		/// last permitted match still prints, and so does the leading context
		/// before it.
		#[test]
		fn context_around_the_last_permitted_match_still_prints() {
			let (code, stdout, stderr) = run_rg(&["-m1", "-A1", "-n", "hit"], HAYSTACK);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:one hit\n2-two\n", "the line after the only match survives");

			let (code, stdout, stderr) = run_rg(&["-m1", "-B1", "-n", "three"], HAYSTACK);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2-two\n3:three hit\n");
		}

		/// `--passthru` prints every line whatever the cap, and the lines past
		/// the cap arrive as CONTEXT rather than as matches: `four hit` keeps a
		/// `-` separator even though the pattern is in it.
		#[test]
		fn passthru_prints_the_rest_as_context() {
			let (code, stdout, stderr) = run_rg(&["-m2", "--passthru", "-n", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "1:one hit\n2-two\n3:three hit\n4-four hit\n5-five\n",
				"line 4 matches the pattern and is still marked as context"
			);
		}

		/// The record modes take the cap as well: `-o` prints one record per
		/// permitted match, and `-l` names a file that reached the cap exactly
		/// once.
		#[test]
		fn the_record_modes_take_the_cap() {
			let (code, stdout, stderr) = run_rg(&["-m2", "-o", "h.t"], HAYSTACK);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "hit\nhit\n");

			let (code, stdout, stderr) = run_rg(&["-m2", "-l", "hit"], HAYSTACK);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>\n");
		}

		/// With `-v` the cap counts the lines that did NOT match, which is the
		/// only reading that keeps `-m` meaningful for an inverted search.
		#[test]
		fn an_inverted_search_caps_the_lines_it_prints() {
			let (code, stdout, stderr) = run_rg(&["-m2", "-v", "-n", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2:two\n5:five\n");
		}

		/// `--stats` describes the capped search, not the whole file: two
		/// matches, two matched lines, one file with a match.
		#[test]
		fn the_stats_describe_the_capped_search() {
			let (code, stdout, stderr) = run_rg(&["-m2", "--stats", "hit"], HAYSTACK);

			assert_eq!(code, 0, "{stderr}");
			assert!(
				stdout.contains("\n2 matches\n2 matched lines\n"),
				"stats should count only what the cap permitted: {stdout}"
			);
			assert!(stdout.contains("1 files contained matches"), "{stdout}");
		}
	}

	mod a_binary_input_is_reported_and_not_silently_truncated {
		use super::*;

		/// A NUL three bytes in, before either match.
		const BINARY: &str = "bin\0hit\nplain hit\n";

		/// The notice, on stdout, with the offset ripgrep reports and the status
		/// of a run that found something.
		#[test]
		fn the_notice_names_the_offset_it_stopped_at() {
			let (code, stdout, stderr) = run_rg(&["hit"], BINARY);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "binary file matches (found \"\\0\" byte around offset 3)\n");
			assert_eq!(stderr, "", "ripgrep reports this as output, not as a diagnostic");
		}

		/// `-a` searches it as text instead, so the records print with the NUL
		/// still in them and there is no notice. This is the twin that shows
		/// the notice is the detector's and not a property of the bytes.
		#[test]
		fn text_mode_prints_the_records_instead() {
			let (code, stdout, stderr) = run_rg(&["-a", "-n", "hit"], BINARY);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:bin\0hit\n2:plain hit\n");
			assert_eq!(stderr, "");
		}

		/// A summary mode reads the WHOLE file and reports no notice: measured
		/// against ripgrep 15.1.0, `-c` counts both matching lines even though
		/// the file's first bytes are binary, and `-l` names it.
		#[test]
		fn a_summary_mode_sees_the_whole_file() {
			let (code, stdout, stderr) = run_rg(&["-c", "hit"], BINARY);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2\n", "both lines, and no notice");

			let (code, stdout, stderr) = run_rg(&["--count-matches", "hit"], BINARY);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2\n");

			let (code, stdout, stderr) = run_rg(&["-l", "hit"], BINARY);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "<stdin>\n");
		}

		/// `-q` prints nothing at all, notice included, and still reports that
		/// something was found.
		#[test]
		fn quiet_prints_nothing_at_all() {
			let (code, stdout, stderr) = run_rg(&["-q", "hit"], BINARY);

			assert_eq!(code, 0);
			assert_eq!(stdout, "");
			assert_eq!(stderr, "");
		}

		/// The record modes do not change the notice: `-o` and `--max-columns`
		/// each print exactly the same sentence, because it replaces the file's
		/// records rather than being one of them.
		#[test]
		fn the_record_modes_do_not_change_it() {
			for args in [vec!["-o", "hit"], vec!["-M", "5", "hit"]] {
				let (code, stdout, stderr) = run_rg(&args, BINARY);

				assert_eq!(code, 0, "{args:?}: {stderr}");
				assert_eq!(
					stdout, "binary file matches (found \"\\0\" byte around offset 3)\n",
					"{args:?}"
				);
			}
		}

		/// The notice carries the name exactly when the run prints names, and the
		/// separator there is a colon and a SPACE, not the colon a record uses.
		/// Measured against ripgrep 15.1.0: `rg -H hit binfile` says
		/// `binfile: binary file matches ...`, `rg -o hit binfile` says it with
		/// no name at all, and `--vimgrep` prints the name because it implies
		/// `-H`.
		#[test]
		fn the_notice_is_named_when_the_records_would_be() {
			const NOTICE: &str = "binary file matches (found \"\\0\" byte around offset 3)\n";

			for args in [vec!["-H", "hit"], vec!["--vimgrep", "hit"]] {
				let (code, stdout, stderr) = run_rg(&args, BINARY);

				assert_eq!(code, 0, "{args:?}: {stderr}");
				assert_eq!(stdout, format!("<stdin>: {NOTICE}"), "{args:?}");
			}

			let (_, stdout, _) = run_rg(&["-N", "hit"], BINARY);
			assert_eq!(stdout, NOTICE, "one unnamed input keeps the bare sentence");
		}

		/// An input with no match reports nothing, whatever it holds: the notice
		/// says binary file MATCHES, so a file that matched nothing has nothing
		/// to say. Measured against ripgrep 15.1.0, which exits 1 with both
		/// streams empty.
		#[test]
		fn an_input_with_no_match_reports_nothing() {
			let (code, stdout, stderr) = run_rg(&["absent"], BINARY);

			assert_eq!(code, 1);
			assert_eq!(stdout, "");
			assert_eq!(stderr, "");
		}

		/// `--null-data` makes the NUL the record separator, so there is nothing
		/// left to detect and the records print. The first record is `bin`, the
		/// second is `hit\nplain hit\n`, and only the second matched.
		#[test]
		fn null_data_leaves_nothing_to_detect() {
			let (code, stdout, stderr) = run_rg(&["--null-data", "hit"], BINARY);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "hit\nplain hit\n\0");
			assert_eq!(stderr, "");
		}

		/// A match BEFORE the binary byte still prints when the searcher reached
		/// it first, and the notice follows the records rather than replacing
		/// them. The filler pushes the NUL past the first buffer, which is the
		/// only way to get a partial answer out of one file.
		#[test]
		fn a_match_before_the_byte_survives_and_the_notice_follows_it() {
			let mut text = String::from("hit early\n");
			text.push_str(&"x".repeat(200_000));
			text.push_str("\n\0hit late\n");

			let (code, stdout, stderr) = run_rg(&["-n", "hit"], &text);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "1:hit early\nbinary file matches (found \"\\0\" byte around offset 200011)\n",
				"the early match, then the notice, and nothing from after the byte"
			);
		}
	}

	/// What a SUMMARY mode reports for a binary file the WALK reached.
	///
	/// THE BUG. `binary_detection` turned detection off for every summary mode,
	/// on the theory that a count prints no raw bytes and so cannot be harmed
	/// by them. That had been measured on a file named as an OPERAND, which
	/// ripgrep searches with `convert` and does count, so it looked right while
	/// being wrong for every file the walk found: those are searched with
	/// `quit`, which ripgrep treats as a FILTER, and the file drops out of the
	/// report entirely. Measured against ripgrep 15.1.0, `rg -c hit .` over a
	/// tree holding `bin \0 hit` counted a file ripgrep leaves out, `-l` named
	/// it, and `-c --include-zero` printed a `0` line for it. See
	/// `RgSink::filtered_as_binary`.
	mod the_binary_filter_keeps_a_walked_file_out_of_every_summary {
		use super::*;

		/// A text file that matches, a text file that does not, and a binary file
		/// whose match sits AFTER the NUL, so only a run that reads past the byte
		/// can find it.
		fn tree(label: &str) -> TempTree {
			let root = unique_tree(label);
			std::fs::write(root.join("a.txt"), "alpha hit\n").expect("the text fixture");
			std::fs::write(root.join("c.txt"), "nothing\n").expect("the second text fixture");
			std::fs::write(root.join("bin.dat"), b"bin \0 hit\n").expect("the binary fixture");
			root
		}

		/// `-c` counts the text file and says nothing about the binary one.
		#[test]
		fn a_count_leaves_the_binary_file_out() {
			let root = tree("binary-filter-count");

			let (code, stdout, stderr) = run_rg_no_stdin(&["--sort", "path", "-c", "hit", "."], &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./a.txt:1\n", "the binary file is not a file that matched");
			assert_eq!(stderr, "", "and it is not a diagnostic either");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--count-matches` and `-l` answer the same way, because the filter is
		/// about the FILE and not about which number a mode prints for it.
		#[test]
		fn the_other_two_match_reports_agree() {
			let root = tree("binary-filter-other-reports");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--sort", "path", "--count-matches", "hit", "."], &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./a.txt:1\n");

			let (code, stdout, stderr) = run_rg_no_stdin(&["--sort", "path", "-l", "hit", "."], &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./a.txt\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--include-zero` asks for a line for every file that matched nothing,
		/// and the binary file STILL has none: a `0` there would claim the file
		/// was read to the end and found empty of matches, which is the one
		/// thing a filtered file cannot say. The text file that missed gets its
		/// `0`, which is what makes this test non-vacuous.
		#[test]
		fn include_zero_covers_the_text_file_only() {
			let root = tree("binary-filter-include-zero");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--sort", "path", "-c", "--include-zero", "hit", "."], &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./a.txt:1\n./c.txt:0\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--files-without-match` is the other half of the same count and leaves
		/// the binary file out of it too, so the file is absent from BOTH halves:
		/// it is neither a file that matched nor a file that did not.
		#[test]
		fn files_without_match_lists_the_text_file_only() {
			let root = tree("binary-filter-without-match");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--sort", "path", "--files-without-match", "hit", "."], &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./c.txt\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// A run whose only file is the filtered one reports nothing and exits 1,
		/// in every summary mode.
		///
		/// The `--files-without-match` status is a DELIBERATE divergence, and the
		/// same one this builtin already documents in its help: ripgrep exits 0
		/// here while printing no path at all, because its printer squashes the
		/// match count before the status reads it. Ours reports what was LISTED,
		/// so a caller can act on the status without also parsing stdout.
		#[test]
		fn a_run_of_nothing_but_the_filtered_file_reports_nothing() {
			let root = unique_tree("binary-filter-alone");
			std::fs::write(root.join("bin.dat"), b"bin \0 hit\n").expect("the binary fixture");

			for args in [
				vec!["--sort", "path", "-c", "hit", "."],
				vec!["--sort", "path", "-l", "hit", "."],
				vec!["--sort", "path", "-c", "--include-zero", "hit", "."],
				vec!["--sort", "path", "--files-without-match", "hit", "."],
			] {
				let (code, stdout, stderr) = run_rg_no_stdin(&args, &root);

				assert_eq!(code, 1, "{args:?}: {stderr}");
				assert_eq!(stdout, "", "{args:?}");
				assert_eq!(stderr, "", "{args:?}");
			}
			let _ = std::fs::remove_dir_all(root);
		}

		/// The twin that shows the filter belongs to the DETECTOR and not to the
		/// bytes: every flag that turns the detector off counts the file.
		#[test]
		fn the_flags_that_read_binary_files_count_it() {
			let root = tree("binary-filter-text-mode");

			for args in [
				vec!["--sort", "path", "-a", "-c", "hit", "."],
				vec!["--sort", "path", "--binary", "-c", "hit", "."],
				vec!["--sort", "path", "-uuu", "-c", "hit", "."],
			] {
				let (code, stdout, stderr) = run_rg_no_stdin(&args, &root);

				assert_eq!(code, 0, "{args:?}: {stderr}");
				assert_eq!(stdout, "./a.txt:1\n./bin.dat:1\n", "{args:?}");
			}
			let _ = std::fs::remove_dir_all(root);
		}

		/// The second twin, and the measurement the old rule was built on: a file
		/// named as an OPERAND is searched with `convert`, reads to the end, and
		/// counts. Which detection applies is a property of how the file was
		/// reached, which is why the two answers differ for the same bytes.
		#[test]
		fn an_operand_is_read_to_the_end_and_counts() {
			let root = tree("binary-filter-operand");

			let (code, stdout, stderr) = run_rg_no_stdin(&["-c", "hit", "bin.dat"], &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1\n", "the match after the NUL is found and counted");

			let (code, stdout, stderr) = run_rg_no_stdin(&["-l", "hit", "bin.dat"], &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "bin.dat\n");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--sort", "path", "-c", "hit", "a.txt", "bin.dat"], &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a.txt:1\nbin.dat:1\n", "and it is named beside the text file");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--stats` still says the file was SEARCHED, because it was: the filter
		/// decides what is reported, not what was read. Every number here is
		/// ripgrep's for the same tree, `18 bytes searched` included, which is
		/// `a.txt` plus `c.txt` and nothing for the file the searcher stopped on.
		#[test]
		fn the_stats_still_count_the_file_as_searched() {
			let root = tree("binary-filter-stats");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--sort", "path", "-c", "--stats", "hit", "."], &root);

			assert_eq!(code, 0, "{stderr}");
			let lines: Vec<&str> = stdout.lines().collect();
			assert_eq!(lines[0], "./a.txt:1");
			assert_eq!(lines[1], "");
			assert_eq!(lines[2], "1 matches");
			assert_eq!(lines[3], "1 matched lines");
			assert_eq!(lines[4], "1 files contained matches");
			assert_eq!(lines[5], "3 files searched", "the filtered file was still opened and read");
			assert_eq!(lines[6], "0 bytes printed");
			assert_eq!(lines[7], "18 bytes searched");
			let _ = std::fs::remove_dir_all(root);
		}

		/// A RECORD mode is not filtered, which is the boundary of this rule: it
		/// has already printed the lines it reached, so it prints the notice
		/// after them. `--binary` is how a walked file gets that far.
		#[test]
		fn a_record_mode_reports_the_notice_instead() {
			let root = tree("binary-filter-record-mode");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--sort", "path", "--binary", "hit", "."], &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout,
				"./a.txt:alpha hit\n./bin.dat: binary file matches (found \"\\0\" byte around offset \
				 4)\n"
			);
			let _ = std::fs::remove_dir_all(root);
		}
	}

	/// The mark that stands between one file's output and the next's.
	///
	/// THE BUG. The only separator this printer wrote between files was the
	/// blank line `--heading` puts above a group, so a run WITHOUT headings ran
	/// two files' output together with nothing to show where one ended.
	/// Measured against ripgrep 15.1.0, `rg -A1 hit .` prints `--` there,
	/// exactly as it does between two gaps inside one file, and a reader piping
	/// the output has no other way to see the boundary. One mechanism answers
	/// all three cases; see `RgSink::search_separator`.
	mod the_separator_stands_between_two_files {
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
			let root = tree("separator-context-flags");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--sort", "path", "-A", "1", "hit", "."], &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./f1.txt:hit\n./f1.txt-y\n--\n./f3.txt:hit\n./f3.txt-z\n");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--sort", "path", "-B", "1", "hit", "."], &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./f1.txt-x\n./f1.txt:hit\n--\n./f3.txt:hit\n");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--sort", "path", "-C", "1", "hit", "."], &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./f1.txt-x\n./f1.txt:hit\n./f1.txt-y\n--\n./f3.txt:hit\n./f3.txt-z\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// It is the CONTEXT separator, so the flags that shape that one shape
		/// this one: there is one setting and not two that have to be kept in
		/// step.
		#[test]
		fn the_context_separator_flags_shape_it() {
			let root = tree("separator-flags-shape-it");

			let (code, stdout, stderr) = run_rg_no_stdin(
				&["--sort", "path", "-A", "1", "--context-separator", "XX", "hit", "."],
				&root,
			);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./f1.txt:hit\n./f1.txt-y\nXX\n./f3.txt:hit\n./f3.txt-z\n");

			let (code, stdout, stderr) = run_rg_no_stdin(
				&["--sort", "path", "-A", "1", "--no-context-separator", "hit", "."],
				&root,
			);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "./f1.txt:hit\n./f1.txt-y\n./f3.txt:hit\n./f3.txt-z\n",
				"nothing at all, not an empty record"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// A run that printed no context lines prints no separator either, which
		/// is the non-vacuity twin for every case above: `-C0` and `--passthru`
		/// both print records without asking for context, and ripgrep separates
		/// neither.
		#[test]
		fn a_run_that_asked_for_no_context_prints_none() {
			let root = tree("separator-no-context-request");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--sort", "path", "-C", "0", "hit", "."], &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./f1.txt:hit\n./f3.txt:hit\n");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--sort", "path", "-A", "0", "hit", "."], &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./f1.txt:hit\n./f3.txt:hit\n");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--sort", "path", "--passthru", "hit", "."], &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout,
				"./f1.txt-x\n./f1.txt:hit\n./f1.txt-y\n./f2.txt-nope\n./f3.txt:hit\n./f3.txt-z\n",
				"passthru prints every line of every file and separates none of them"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--heading` uses the BLANK LINE instead, and the context separator
		/// does not appear even when it was given a value: the two are the same
		/// mechanism with different bytes, so only one of them can be printed.
		#[test]
		fn heading_prints_the_blank_line_and_not_the_separator() {
			let root = tree("separator-heading-wins");

			let (code, stdout, stderr) = run_rg_no_stdin(
				&["--sort", "path", "--heading", "-A", "1", "--context-separator", "XX", "hit", "."],
				&root,
			);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./f1.txt\nhit\ny\n\n./f3.txt\nhit\nz\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// It separates the OUTPUT of two searches and not two path names, so it
		/// is printed under `-I` where there are no names to tell apart. This
		/// is the case that makes it worth having: without the mark,
		/// `hit\ny\nhit\nz\n` says nothing about which file each line came
		/// from.
		#[test]
		fn it_is_printed_when_there_are_no_names_at_all() {
			let root = tree("separator-no-filename");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--sort", "path", "-I", "-A", "1", "hit", "."], &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "hit\ny\n--\nhit\nz\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// A summary mode prints one record per file and never a separator,
		/// whatever context was asked for: there are no context lines to
		/// separate.
		#[test]
		fn a_summary_mode_prints_none() {
			let root = tree("separator-summary-mode");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--sort", "path", "-A", "1", "-c", "hit", "."], &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./f1.txt:1\n./f3.txt:1\n");
			let _ = std::fs::remove_dir_all(root);
		}
	}

	/// What a match that SPANS lines prints for each line it covers.
	///
	/// THE BUG. A multi-line match arrived at the printer as one record and was
	/// written under ONE prefix, so every line after the first came out bare.
	/// Measured against ripgrep 15.1.0, `rg -U '(?s)hit.gamma' hit .` printed
	/// `./a.txt:hit hit` and then a bare `gamma`, which names no file, carries
	/// no line number, and cannot be read by anything that consumes
	/// `path:line:text`. See `RgSink::print_multi_line_records`.
	mod a_multiline_match_prefixes_every_line_it_covers {
		use super::*;

		/// The match `(?s)hit.gamma` covers lines 3 and 4 of this file, and line
		/// 1 holds a single-line match so every case has a within-one-line
		/// twin.
		const HAYSTACK: &str = "alpha hit\nbeta\nhit hit\ngamma\n";

		/// A file to search by name, so the records carry a path to compare.
		fn tree(label: &str) -> TempTree {
			let root = unique_tree(label);
			std::fs::write(root.join("a.txt"), HAYSTACK).expect("the fixture");
			root
		}

		/// Both lines carry the path, and the line numbers count up from the line
		/// the searcher reported the match on.
		#[test]
		fn every_line_carries_the_path_and_its_own_number() {
			let root = tree("multiline-prefix-each-line");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["-H", "-n", "-U", "(?s)hit.gamma", "a.txt"], &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a.txt:3:hit hit\na.txt:4:gamma\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// The byte offset is each LINE's own, not the match's: `-b` reports
		/// where the line starts, which is the number a caller seeks to.
		#[test]
		fn the_byte_offset_is_the_lines_own() {
			let root = tree("multiline-byte-offset");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["-H", "-b", "-U", "(?s)hit.gamma", "a.txt"], &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "a.txt:15:hit hit\na.txt:23:gamma\n",
				"line 3 starts at 15, line 4 at 23"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// The COLUMN is the record's, repeated: line 4 reports column 5 even
		/// though its own text has no match there. Measured against ripgrep
		/// 15.1.0 and reproduced rather than corrected, because the column
		/// belongs to the match and a reader has the line number beside it to
		/// say which line the match began on.
		#[test]
		fn the_column_is_the_matchs_and_is_repeated() {
			let root = tree("multiline-column");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["-H", "-n", "--column", "-U", "(?s)hit.gamma", "a.txt"], &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a.txt:3:5:hit hit\na.txt:4:5:gamma\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `-o` prints the part of the match that is on each line, each with its
		/// own prefix, so `hit\ngamma` becomes two addressable records.
		#[test]
		fn only_matching_prints_the_piece_on_each_line() {
			let root = tree("multiline-only-matching");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["-H", "-n", "-o", "-U", "(?s)hit.gamma", "a.txt"], &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a.txt:3:hit\na.txt:4:gamma\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--vimgrep` prints ONE record per match even when the match spans
		/// lines, which ripgrep's printer says in as many words. The column
		/// there is the match's column on THAT line, which is the one place a
		/// multi-line record reports a column relative to the line.
		#[test]
		fn vimgrep_prints_one_record_for_the_whole_match() {
			let root = tree("multiline-vimgrep");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--vimgrep", "-U", "(?s)hit.gamma", "a.txt"], &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a.txt:3:5:hit hit\n", "line 4 is not a record of its own here");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `-r` prints the line it BUILT, and a replacement that swallows the
		/// newline leaves one line to print: the split follows the text being
		/// printed rather than the text that matched.
		#[test]
		fn a_replacement_that_removes_the_newline_prints_one_line() {
			let root = tree("multiline-replacement");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["-H", "-r", "X", "-U", "(?s)hit.gamma", "a.txt"], &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a.txt:hit X\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `--max-columns` judges each LINE, so a record whose lines are both too
		/// long is replaced twice. The limit is 5 and both lines are longer.
		#[test]
		fn max_columns_judges_each_line() {
			let root = tree("multiline-max-columns");

			let (code, stdout, stderr) =
				run_rg_no_stdin(&["-H", "-M", "5", "-U", "(?s)hit.gamma", "a.txt"], &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(
				stdout, "a.txt:[Omitted long matching line]\na.txt:[Omitted long matching line]\n",
				"one notice per line, not one per record"
			);
			let _ = std::fs::remove_dir_all(root);
		}

		/// The twin: a `-U` run whose matches each sit on ONE line prints one
		/// record each, so the multi-line path is reached by the record's shape
		/// and not by the flag.
		#[test]
		fn a_single_line_match_under_multiline_prints_one_record() {
			let root = tree("multiline-single-line-match");

			let (code, stdout, stderr) = run_rg_no_stdin(&["-H", "-n", "-U", "hit", "a.txt"], &root);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "a.txt:1:alpha hit\na.txt:3:hit hit\n");
			let _ = std::fs::remove_dir_all(root);
		}
	}

	/// `--crlf`, which makes a line end at `\r\n` so a Windows checkout does not
	/// leave a stray carriage return on every pattern anchored with `$`.
	///
	/// THE BUG. The flag was passed to the searcher AND to the matcher, but the
	/// matcher's line terminator was then overwritten with `\n`, because
	/// `RegexMatcherBuilder::crlf(true)` sets that terminator and the later
	/// `line_terminator` call replaces it. grep-searcher refuses a matcher and a
	/// searcher that disagree, so `rg --crlf hit .` printed `grep config error:
	/// mismatched line terminators` for every file it opened and exited 2 having
	/// searched nothing at all. Measured against ripgrep 15.1.0, which searches
	/// them.
	mod the_crlf_flag_leaves_the_matcher_and_the_searcher_agreeing {
		use super::*;

		/// Two CRLF lines, the first of which matches.
		const CRLF: &str = "crlf hit\r\nsecond\r\n";

		/// The run searches and prints, rather than refusing the file. The
		/// carriage return stays in the printed record, which is ripgrep's
		/// behaviour: the flag changes where a LINE ends, not what a line
		/// holds.
		#[test]
		fn the_search_happens_and_the_record_keeps_its_carriage_return() {
			let (code, stdout, stderr) = run_rg(&["--crlf", "-n", "hit"], CRLF);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:crlf hit\r\n");
			assert_eq!(stderr, "", "and no config error");
		}

		/// The reason the flag exists: `$` anchors at the `\r\n` under `--crlf`
		/// and at the `\n` without it, so the same pattern matches with the
		/// flag and misses without it. This is the pair that makes the flag
		/// worth having.
		#[test]
		fn an_anchored_pattern_matches_only_with_the_flag() {
			let (code, stdout, stderr) = run_rg(&["--crlf", "hit$"], CRLF);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "crlf hit\r\n");

			let (code, stdout, stderr) = run_rg(&["hit$"], CRLF);
			assert_eq!(code, 1, "without the flag the carriage return is in the way");
			assert_eq!(stdout, "");
			assert_eq!(stderr, "");
		}

		/// A pattern anchored to the START of a line still matches on the line
		/// AFTER a CRLF, which is the other half of the terminator agreeing: the
		/// searcher and the matcher have to draw the boundary in the same place.
		#[test]
		fn a_later_line_is_still_a_line() {
			let (code, stdout, stderr) = run_rg(&["--crlf", "-n", "^second$"], CRLF);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "2:second\r\n");
		}

		/// `--no-crlf` puts the LF terminator back, and the anchored pattern
		/// misses again: the pair resolves by order, and the flag that lost
		/// leaves nothing behind.
		#[test]
		fn no_crlf_restores_the_line_feed() {
			let (code, stdout, stderr) = run_rg(&["--crlf", "--no-crlf", "hit$"], CRLF);

			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "");
			assert_eq!(stderr, "");
		}

		/// `--null-data` wins over `--crlf`, and the two still agree: a NUL-ended
		/// record has no line ending to strip, so the searcher and the matcher
		/// both take NUL and the run neither errors nor drops the carriage
		/// returns.
		#[test]
		fn null_data_wins_without_a_disagreement() {
			let (code, stdout, stderr) = run_rg(&["--crlf", "--null-data", "-n", "hit"], CRLF);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:crlf hit\r\nsecond\r\n\0");
			assert_eq!(stderr, "");
		}

		/// `--crlf` with `--multiline` also agrees: multiline drops the
		/// terminator hint for the matcher, and the CRLF one has to survive that.
		#[test]
		fn multiline_keeps_the_two_in_step() {
			let (code, stdout, stderr) = run_rg(&["--crlf", "-U", "-n", "hit"], CRLF);

			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "1:crlf hit\r\n");
			assert_eq!(stderr, "");
		}
	}

	/// The program name in front of a diagnostic, which belongs there exactly
	/// once.
	///
	/// THE BUG. A bad `--encoding` value reported `rg: rg: grep config error:
	/// unknown encoding: utf-9`, because the message carried a prefix AND the
	/// printer added one. Found by the ripgrep differential's awkward-tree
	/// batch.
	///
	/// There are two conventions in this half and each is internally consistent:
	/// a `Result<_, String>` whose caller writes `rg: {error}` must return the
	/// reason alone, and one whose caller writes `{error}` must carry the
	/// prefix itself. The encoding message was in the wrong group. The sweep
	/// below is what keeps a new one from joining it: every bad-value path is
	/// walked and the prefix counted, so a message written into either group is
	/// checked without the suite having to know which group it belongs to.
	mod a_diagnostic_carries_the_program_name_exactly_once {
		use super::*;

		/// A tree with one file, so a run that gets past its flags has something
		/// to search and a run that does not is failing on the flag.
		fn tree(label: &str) -> TempTree {
			let root = unique_tree(label);
			std::fs::write(root.join("a.txt"), "alpha hit\n").expect("the fixture");
			root
		}

		/// The message that was wrong, byte for byte, including the reason the
		/// encoding table gave.
		#[test]
		fn a_bad_encoding_names_the_value_once() {
			let root = tree("rg-prefix-encoding");

			let (code, stdout, stderr) = run_rg_no_stdin(&["--encoding", "utf-9", "hit", "."], &root);

			assert_eq!(code, 2);
			assert_eq!(stdout, "");
			assert_eq!(stderr, "rg: grep config error: unknown encoding: utf-9\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// `-E` is the same flag and the same message, since the spelling is
		/// clap's business and the reason is the encoding table's.
		#[test]
		fn the_short_spelling_reports_the_same_thing() {
			let root = tree("rg-prefix-encoding-short");

			let (code, _, stderr) = run_rg_no_stdin(&["-E", "utf-9", "hit", "."], &root);

			assert_eq!(code, 2);
			assert_eq!(stderr, "rg: grep config error: unknown encoding: utf-9\n");
			let _ = std::fs::remove_dir_all(root);
		}

		/// Every bad-value path, swept: each reports on stderr, exits 2, prints
		/// nothing on stdout, and names the program ONCE. The sweep is the
		/// durable half of this suite, because it covers the paths a future
		/// flag will be added beside.
		#[test]
		fn every_bad_value_path_names_the_program_once() {
			let root = tree("rg-prefix-sweep");
			std::fs::write(root.join("rules.txt"), "[\n").expect("the ignore fixture");

			for args in [
				vec!["--encoding", "utf-9", "hit", "."],
				vec!["--max-filesize", "twelve", "hit", "."],
				vec!["-g", "[", "hit", "."],
				vec!["--iglob", "[", "hit", "."],
				vec!["--pre-glob", "[", "--pre", "cat", "hit", "."],
				vec!["--sort", "sideways", "hit", "."],
				vec!["--sortr", "sideways", "hit", "."],
				vec!["--path-separator", "", "hit", "."],
				vec!["--type-add", "nocolon", "hit", "."],
				vec!["-f", "missing.list", "."],
				vec!["--engine", "sideways", "hit", "."],
			] {
				let (code, stdout, stderr) = run_rg_no_stdin(&args, &root);

				assert_eq!(code, 2, "{args:?} should be refused: {stderr:?}");
				assert_eq!(stdout, "", "{args:?} should print no results");
				let first = stderr.strip_prefix("rg: ").unwrap_or_else(|| {
					panic!("{args:?} should name the program: {stderr:?}");
				});
				assert!(!first.starts_with("rg: "), "{args:?} names the program twice: {stderr:?}");
				assert!(!first.trim().is_empty(), "{args:?} gives no reason: {stderr:?}");
			}
			let _ = std::fs::remove_dir_all(root);
		}

		/// The twin that shows the sweep is not passing because everything fails:
		/// the same flags with values they accept search the tree and say
		/// nothing on stderr.
		#[test]
		fn the_same_flags_with_good_values_search_and_stay_quiet() {
			let root = tree("rg-prefix-good-values");

			for args in [
				vec!["--encoding", "utf-8", "hit", "."],
				vec!["--encoding", "auto", "hit", "."],
				vec!["--encoding", "none", "hit", "."],
				vec!["--max-filesize", "1M", "hit", "."],
				vec!["-g", "*.txt", "hit", "."],
				vec!["--sort", "path", "hit", "."],
				vec!["--path-separator", "/", "hit", "."],
				vec!["--type-add", "mine:*.txt", "hit", "."],
				vec!["--engine", "default", "hit", "."],
			] {
				let (code, stdout, stderr) = run_rg_no_stdin(&args, &root);

				assert_eq!(code, 0, "{args:?}: {stderr}");
				assert_eq!(stdout, "./a.txt:alpha hit\n", "{args:?}");
				assert_eq!(stderr, "", "{args:?}");
			}
			let _ = std::fs::remove_dir_all(root);
		}
	}

	/// ripgrep refuses a bad flag value with one wording, and these lock every
	/// byte of it.
	///
	/// ripgrep parses its own flags, so a value it cannot read produces
	/// `rg: error parsing flag <flag>: <reason>` and nothing else: no "tip", no
	/// usage block, no pointer to `--help`. This builtin parses with clap, whose
	/// three failure kinds are worded differently, so `argv_diagnostic`
	/// translates them. Every expectation below was captured from ripgrep
	/// 15.1.0 and asserts the exact bytes, because the wording is the contract
	/// a script reads.
	mod a_bad_flag_value_is_refused_in_ripgreps_words {
		use super::*;

		/// A scratch tree the accepted-value checks search, so a run that gets
		/// past its flags has something to find.
		fn tree(label: &str) -> TempTree {
			unique_tree(label)
		}

		/// The reason ripgrep gives for a NUM value that is not a number.
		const NOT_A_NUMBER: &str = "value is not a valid number: invalid digit found in string";

		/// The reason ripgrep gives for a size that is not digits with an
		/// optional uppercase suffix.
		fn malformed_size(value: &str) -> String {
			format!(
				"invalid size: invalid format for size '{value}', which should be a non-empty \
				 sequence of digits followed by an optional 'K', 'M' or 'G' suffix"
			)
		}

		/// Every numeric flag refuses a value that is not a number, and names
		/// itself as the command line spelled it.
		///
		/// The spelling matters: ripgrep echoes `-m` for `rg -m abc` and
		/// `--max-count` for the long form, so a script that greps its own
		/// diagnostics sees the flag it wrote.
		#[test]
		fn a_numeric_flag_names_itself_as_it_was_written() {
			for (args, flag) in [
				(vec!["--max-count", "abc", "hit", "."], "--max-count"),
				(vec!["-m", "abc", "hit", "."], "-m"),
				(vec!["--max-count=abc", "hit", "."], "--max-count"),
				(vec!["--max-depth", "abc", "hit", "."], "--max-depth"),
				(vec!["-d", "abc", "hit", "."], "-d"),
				(vec!["--max-columns", "abc", "hit", "."], "--max-columns"),
				(vec!["-M", "abc", "hit", "."], "-M"),
				(vec!["--after-context", "abc", "hit", "."], "--after-context"),
				(vec!["-A", "abc", "hit", "."], "-A"),
				(vec!["--before-context", "abc", "hit", "."], "--before-context"),
				(vec!["-B", "abc", "hit", "."], "-B"),
				(vec!["--context", "abc", "hit", "."], "--context"),
				(vec!["-C", "abc", "hit", "."], "-C"),
			] {
				let (code, stdout, stderr) = run_rg(&args, "");

				assert_eq!(code, 2, "{args:?}: {stderr}");
				assert_eq!(stdout, "", "{args:?}");
				assert_eq!(
					stderr,
					format!("rg: error parsing flag {flag}: {NOT_A_NUMBER}\n"),
					"{args:?}"
				);
			}
		}

		/// A negative number is a value, not a flag.
		///
		/// ripgrep hands `-3` to `-m` and then refuses it as a number, so
		/// `rg -m -3` reports the number and not an unknown flag `-3`.
		#[test]
		fn a_negative_value_is_read_as_a_value() {
			for (args, flag) in [
				(vec!["-m", "-3", "hit", "."], "-m"),
				(vec!["--max-depth", "-1", "hit", "."], "--max-depth"),
				(vec!["-A", "-1", "hit", "."], "-A"),
			] {
				let (code, stdout, stderr) = run_rg(&args, "");

				assert_eq!(code, 2, "{args:?}: {stderr}");
				assert_eq!(stdout, "", "{args:?}");
				assert_eq!(
					stderr,
					format!("rg: error parsing flag {flag}: {NOT_A_NUMBER}\n"),
					"{args:?}"
				);
			}
		}

		/// A short flag inside a cluster still names itself.
		///
		/// `-imabc` is `-i` followed by `-m abc`, and ripgrep reports `-m`, so
		/// the spelling is recovered from the cluster rather than from the
		/// flag's declaration.
		#[test]
		fn a_clustered_short_flag_names_itself() {
			for args in [vec!["-mabc", "hit", "."], vec!["-imabc", "hit", "."]] {
				let (code, stdout, stderr) = run_rg(&args, "");

				assert_eq!(code, 2, "{args:?}: {stderr}");
				assert_eq!(stdout, "", "{args:?}");
				assert_eq!(stderr, format!("rg: error parsing flag -m: {NOT_A_NUMBER}\n"), "{args:?}");
			}
		}

		/// The spelling that is reported is the one whose value failed.
		///
		/// A flag repeated in two spellings keeps the last value, so
		/// `-d 1 --max-depth nope` fails on `--max-depth`.
		#[test]
		fn the_last_spelling_on_the_line_is_the_one_reported() {
			let (code, stdout, stderr) = run_rg(&["-d", "1", "--max-depth", "nope", "hit", "."], "");

			assert_eq!(code, 2, "{stderr}");
			assert_eq!(stdout, "");
			assert_eq!(stderr, format!("rg: error parsing flag --max-depth: {NOT_A_NUMBER}\n"));
		}

		/// An empty NUM value is refused with the empty-string reason.
		///
		/// `--max-count ''` is a different mistake than `--max-count abc`, and
		/// ripgrep says so, so the two reasons are not flattened into one
		/// message.
		#[test]
		fn an_empty_numeric_value_says_the_string_was_empty() {
			let (code, stdout, stderr) = run_rg(&["--max-count", "", "hit", "."], "");

			assert_eq!(code, 2, "{stderr}");
			assert_eq!(stdout, "");
			assert_eq!(
				stderr,
				"rg: error parsing flag --max-count: value is not a valid number: cannot parse \
				 integer from empty string\n"
			);
		}

		/// A size takes digits and an uppercase suffix, and nothing else.
		///
		/// `1k` is refused where `1K` is accepted: the suffix ripgrep documents
		/// is uppercase, and accepting a lowercase one would silently change
		/// which files a filter searches.
		#[test]
		fn a_malformed_size_is_refused_by_its_shape() {
			for value in ["12Q", "1k", "", "1.5M", "K", "-1"] {
				let args = vec!["--max-filesize", value, "hit", "."];
				let (code, stdout, stderr) = run_rg(&args, "");

				assert_eq!(code, 2, "{args:?}: {stderr}");
				assert_eq!(stdout, "", "{args:?}");
				assert_eq!(
					stderr,
					format!("rg: error parsing flag --max-filesize: {}\n", malformed_size(value)),
					"{args:?}"
				);
			}
		}

		/// A size too large for the counter says so in its own words.
		///
		/// ripgrep tells a malformed size apart from a size that simply does not
		/// fit, so the two refusals stay distinct.
		#[test]
		fn a_size_that_does_not_fit_says_the_integer_was_too_large() {
			let value = "99999999999999999999";
			let (code, stdout, stderr) = run_rg(&["--max-filesize", value, "hit", "."], "");

			assert_eq!(code, 2, "{stderr}");
			assert_eq!(stdout, "");
			assert_eq!(
				stderr,
				format!(
					"rg: error parsing flag --max-filesize: invalid size: invalid integer found in \
					 size '{value}': number too large to fit in target type\n"
				)
			);
		}

		/// The sizes ripgrep accepts are still accepted, and they mean powers of
		/// 1024.
		///
		/// The refusals above must not have made the accepted shapes stricter, so
		/// each suffix is proved to leave a small file searchable and a 2 KiB
		/// file filtered out at `1K`.
		#[test]
		fn the_accepted_sizes_are_still_accepted() {
			let root = tree("bad-value-size-ok");
			std::fs::write(root.join("small.txt"), b"hit\n").expect("the small file should write");
			let mut big = vec![b'x'; 2048];
			big.extend_from_slice(b"\nhit\n");
			std::fs::write(root.join("big.txt"), &big).expect("the big file should write");

			// `1K` is 1024 bytes, so the 2 KiB file is filtered out and the small
			// one is not.
			let (code, stdout, stderr) =
				run_rg_no_stdin(&["--sort", "path", "--max-filesize", "1K", "hit", "."], &root);
			assert_eq!(code, 0, "{stderr}");
			assert_eq!(stdout, "./small.txt:hit\n");
			assert_eq!(stderr, "");

			// `1M` and `1G` are both over the 2 KiB file, so both search it.
			for value in ["1M", "1G", "4096"] {
				let args = vec!["--sort", "path", "--max-filesize", value, "hit", "."];
				let (code, stdout, stderr) = run_rg_no_stdin(&args, &root);

				assert_eq!(code, 0, "{args:?}: {stderr}");
				assert_eq!(stdout, "./big.txt:hit\n./small.txt:hit\n", "{args:?}");
				assert_eq!(stderr, "", "{args:?}");
			}

			// A limit under every file leaves nothing to search, which is exit 1 and
			// not an error.
			let (code, stdout, stderr) = run_rg_no_stdin(&["--max-filesize", "1", "hit", "."], &root);
			assert_eq!(code, 1, "{stderr}");
			assert_eq!(stdout, "");
			assert_eq!(stderr, "");
		}

		/// `--engine` names the engine it did not recognize.
		///
		/// ripgrep does not list the choices for this flag, so a derived
		/// value-enum message that listed them would not match.
		#[test]
		fn an_unknown_engine_is_named_rather_than_the_choices_listed() {
			let (code, stdout, stderr) = run_rg(&["--engine", "sideways", "hit", "."], "");

			assert_eq!(code, 2, "{stderr}");
			assert_eq!(stdout, "");
			assert_eq!(
				stderr,
				"rg: error parsing flag --engine: unrecognized regex engine 'sideways'\n"
			);
		}

		/// A flag with choices says the choice is unrecognized.
		///
		/// `--color` is accepted for compatibility and never emits color, and it
		/// still refuses a value ripgrep refuses: reporting success for a command
		/// line ripgrep rejects would hide the caller's typo.
		#[test]
		fn an_unknown_choice_is_refused_by_the_flags_that_have_choices() {
			for (args, flag, value) in [
				(vec!["--color", "sideways", "hit", "."], "--color", "sideways"),
				(vec!["--color", "", "hit", "."], "--color", ""),
				(vec!["--sort", "nope", "hit", "."], "--sort", "nope"),
				(vec!["--sortr", "nope", "hit", "."], "--sortr", "nope"),
			] {
				let (code, stdout, stderr) = run_rg(&args, "");

				assert_eq!(code, 2, "{args:?}: {stderr}");
				assert_eq!(stdout, "", "{args:?}");
				assert_eq!(
					stderr,
					format!("rg: error parsing flag {flag}: choice '{value}' is unrecognized\n"),
					"{args:?}"
				);
			}
		}

		/// The four `--color` values ripgrep accepts are accepted.
		///
		/// The check above must refuse only what ripgrep refuses, so every value
		/// it takes is proved to search normally.
		#[test]
		fn every_color_choice_ripgrep_accepts_is_accepted() {
			let root = tree("bad-value-color-ok");
			std::fs::write(root.join("a.txt"), b"hit\n").expect("the file should write");

			for value in ["never", "auto", "always", "ansi"] {
				let args = vec!["--color", value, "hit", "."];
				let (code, stdout, stderr) = run_rg_no_stdin(&args, &root);

				assert_eq!(code, 0, "{args:?}: {stderr}");
				assert_eq!(stdout, "./a.txt:hit\n", "{args:?}");
				assert_eq!(stderr, "", "{args:?}");
			}
		}

		/// A flag left without its value is a different mistake than a bad value.
		///
		/// ripgrep says `missing value for flag`, and repeats the flag inside the
		/// reason, so the two messages are not merged into one.
		#[test]
		fn a_flag_without_its_value_says_the_value_is_missing() {
			let (code, stdout, stderr) = run_rg(&["--max-count"], "");

			assert_eq!(code, 2, "{stderr}");
			assert_eq!(stdout, "");
			assert_eq!(
				stderr,
				"rg: missing value for flag --max-count: missing argument for option '--max-count'\n"
			);
		}

		/// A flag ripgrep does not know is named, with no usage block.
		///
		/// clap answers this with "unexpected argument", a tip about `--`, a
		/// usage block and a pointer to `--help`. ripgrep prints one line, and
		/// a caller reading stderr sees only that line.
		#[test]
		fn an_unknown_flag_is_one_line_naming_the_flag() {
			for (args, flag) in
				[(vec!["--nosuchflag", "hit", "."], "--nosuchflag"), (vec!["-Q", "hit", "."], "-Q")]
			{
				let (code, stdout, stderr) = run_rg(&args, "");

				assert_eq!(code, 2, "{args:?}: {stderr}");
				assert_eq!(stdout, "", "{args:?}");
				assert_eq!(stderr, format!("rg: unrecognized flag {flag}\n"), "{args:?}");
			}
		}

		/// Help and version keep clap's rendering.
		///
		/// `argv_diagnostic` answers only the three failures ripgrep words
		/// itself. Help and version are not failures: they go to stdout and
		/// exit 0, and translating them would throw the help text away.
		#[test]
		fn help_and_version_are_not_treated_as_bad_values() {
			for args in [vec!["--help"], vec!["-h"], vec!["--version"], vec!["-V"]] {
				let (code, stdout, stderr) = run_rg(&args, "");

				assert_eq!(code, 0, "{args:?}: {stderr}");
				assert!(stdout.contains("rg"), "{args:?} should print to stdout: {stdout:?}");
				assert_eq!(stderr, "", "{args:?}");
			}
		}
	}

	/// Output buffering: which mode a command line resolves to.
	///
	/// WHY THIS SUITE EXISTS. `--block-buffered` and `--no-block-buffered` were
	/// missing outright, so `rg --block-buffered hit a.txt` exited 2 with an
	/// unknown-argument error where ripgrep 15.1.0 prints the matches: measured,
	/// all four spellings are accepted there. Underneath that, the mode was read
	/// straight off one boolean (`if cli.line_buffered`), which cannot express
	/// either of ripgrep's other two rules. Its own help states the first from
	/// both sides -- `--line-buffered` says `This overrides the --block-buffered
	/// flag` and `--block-buffered` says the reverse -- which is one state whose
	/// last spelling wins, not two independent booleans. The second is the
	/// DEFAULT: ripgrep line-buffers when stdout is a tty so a long search shows
	/// results while it runs, and block-buffers to a pipe or a file because that
	/// is faster. This crate always block-buffered, so an interactive search in
	/// the shell looked frozen until 8 KiB had accumulated.
	///
	/// ripgrep's own names for the three values are `BufferMode::{Line, Block,
	/// Auto}`, and a `--no-` flag sets `Auto` rather than the opposite mode.
	/// That is why the `--no-` spellings here return the decision to the
	/// destination instead of forcing the other mode, and why a `--no-` flag
	/// cancels the OTHER flag too: `--line-buffered --no-block-buffered` is
	/// `Auto`.
	mod output_buffering_resolves_to_one_mode {
		use super::*;

		fn mode(args: &[&str], terminal: bool) -> Buffering {
			Buffering::resolve(&parse(args), terminal)
		}

		/// The default, which is the reason the flags are rarely needed.
		#[test]
		fn a_terminal_gets_lines_and_a_pipe_gets_blocks() {
			assert_eq!(mode(&["x"], true), Buffering::Line, "a tty streams");
			assert_eq!(mode(&["x"], false), Buffering::Block, "a pipe or a file batches");
		}

		/// Either explicit flag beats the destination, in both directions, since
		/// forcing the mode is the whole reason the flags exist.
		#[test]
		fn an_explicit_flag_beats_the_destination() {
			assert_eq!(mode(&["--line-buffered", "x"], false), Buffering::Line);
			assert_eq!(mode(&["--block-buffered", "x"], true), Buffering::Block);
			assert_eq!(mode(&["--line-buffered", "x"], true), Buffering::Line);
			assert_eq!(mode(&["--block-buffered", "x"], false), Buffering::Block);
		}

		/// The rule both help texts state. This is the case a pair of independent
		/// booleans gets wrong, because `if line_buffered` reads the first flag
		/// and never looks at the second.
		#[test]
		fn the_last_of_the_two_forcing_flags_wins() {
			assert_eq!(mode(&["--line-buffered", "--block-buffered", "x"], false), Buffering::Block);
			assert_eq!(mode(&["--block-buffered", "--line-buffered", "x"], false), Buffering::Line);
			assert_eq!(mode(&["--line-buffered", "--block-buffered", "x"], true), Buffering::Block);
			assert_eq!(mode(&["--block-buffered", "--line-buffered", "x"], true), Buffering::Line);
		}

		/// A repeated flag is accepted and says the same thing, which a script
		/// assembling arguments from several places will produce.
		#[test]
		fn a_repeated_flag_still_means_itself() {
			assert_eq!(mode(&["--line-buffered", "--line-buffered", "x"], false), Buffering::Line);
			assert_eq!(mode(&["--block-buffered", "--block-buffered", "x"], true), Buffering::Block);
		}

		/// A `--no-` flag returns the decision to the destination rather than
		/// forcing the other mode, which is only visible with the two grounds
		/// asserted side by side: forcing would give one answer for both.
		#[test]
		fn a_negation_returns_the_decision_to_the_destination() {
			assert_eq!(mode(&["--line-buffered", "--no-line-buffered", "x"], true), Buffering::Line);
			assert_eq!(mode(&["--line-buffered", "--no-line-buffered", "x"], false), Buffering::Block);
			assert_eq!(mode(&["--block-buffered", "--no-block-buffered", "x"], true), Buffering::Line);
			assert_eq!(
				mode(&["--block-buffered", "--no-block-buffered", "x"], false),
				Buffering::Block
			);
		}

		/// And it cancels the OTHER flag too, because all four spellings are one
		/// state. `--line-buffered --no-block-buffered` is the destination's
		/// default, not line buffering that survived a negation aimed elsewhere.
		#[test]
		fn a_negation_cancels_the_other_flag_as_well() {
			assert_eq!(
				mode(&["--line-buffered", "--no-block-buffered", "x"], false),
				Buffering::Block
			);
			assert_eq!(mode(&["--line-buffered", "--no-block-buffered", "x"], true), Buffering::Line);
			assert_eq!(mode(&["--block-buffered", "--no-line-buffered", "x"], true), Buffering::Line);
			assert_eq!(
				mode(&["--block-buffered", "--no-line-buffered", "x"], false),
				Buffering::Block
			);
		}

		/// A negation that comes FIRST is overridden like any other, so the
		/// forcing flag after it still applies.
		#[test]
		fn a_forcing_flag_after_a_negation_still_applies() {
			assert_eq!(mode(&["--no-line-buffered", "--line-buffered", "x"], false), Buffering::Line);
			assert_eq!(
				mode(&["--no-block-buffered", "--block-buffered", "x"], true),
				Buffering::Block
			);
		}

		/// NON-VACUITY: all four spellings parse at all, and none is set by
		/// default. Every assertion above is also satisfied by a parser that
		/// silently drops the flags, which is exactly the state before this.
		#[test]
		fn all_four_spellings_parse_and_none_is_on_by_default() {
			assert!(parse(&["--line-buffered", "x"]).line_buffered);
			assert!(parse(&["--no-line-buffered", "x"]).no_line_buffered);
			assert!(parse(&["--block-buffered", "x"]).block_buffered);
			assert!(parse(&["--no-block-buffered", "x"]).no_block_buffered);

			let bare = parse(&["x"]);
			assert!(!bare.line_buffered && !bare.no_line_buffered);
			assert!(!bare.block_buffered && !bare.no_block_buffered);
		}
	}

	/// Output buffering: what each mode does to the bytes.
	///
	/// WHY THIS SUITE EXISTS. The resolution above decides a mode; this decides
	/// whether the mode means anything. Line buffering used to be implemented by
	/// writing STRAIGHT THROUGH to stdout, which flushes more often than per
	/// line rather than less, and costs a write syscall per FRAGMENT: a
	/// matching line is emitted as a path, a separator, a line number, another
	/// separator and the line, so five syscalls where one is needed, on every
	/// match of a run that asked for streaming and is therefore already the
	/// slow case (Law 7). `LineWriter` is the shape ripgrep uses and the shape
	/// this asserts.
	///
	/// The writer is generic over its sink precisely so this is observable: with
	/// the real stdout, WHEN a flush happens is not something a test can see.
	mod each_buffering_mode_flushes_where_it_says {
		use super::*;

		/// A sink that records each write it receives, separately.
		struct Recorder(Arc<Mutex<Vec<Vec<u8>>>>);

		impl Write for Recorder {
			fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
				self.0.lock().push(bytes.to_vec());
				Ok(bytes.len())
			}

			fn flush(&mut self) -> io::Result<()> {
				Ok(())
			}
		}

		fn recorder() -> (Arc<Mutex<Vec<Vec<u8>>>>, Recorder) {
			let log = Arc::new(Mutex::new(Vec::new()));
			(Arc::clone(&log), Recorder(log))
		}

		/// Line mode holds a partial record and releases it at the terminator.
		#[test]
		fn line_mode_releases_a_record_at_its_terminator() {
			let (log, sink) = recorder();
			let mut out = Buffering::Line.wrap(sink);

			out.write_all(b"a.txt:1:hit")
				.expect("the write should succeed");
			assert!(log.lock().is_empty(), "a partial record is not released");

			out.write_all(b"\n").expect("the write should succeed");
			assert_eq!(
				log.lock().concat(),
				b"a.txt:1:hit\n".to_vec(),
				"the whole record reaches the sink once it is complete"
			);
		}

		/// And the fragments a record is emitted in are coalesced, which is the
		/// cost claim: MEASURED at two writes rather than six.
		///
		/// Two and not one because that is what `LineWriter` does, and the number
		/// is asserted rather than rounded off: it flushes what it has buffered
		/// as one write, then writes the fragment that carries the terminator.
		/// The comparison is the point, so the same six fragments are also
		/// written to the bare sink, which is what line buffering used to do.
		#[test]
		fn line_mode_coalesces_the_fragments_of_a_record() {
			const FRAGMENTS: [&[u8]; 6] = [b"a.txt", b":", b"1", b":", b"hit", b"\n"];

			let (log, sink) = recorder();
			let mut out = Buffering::Line.wrap(sink);
			for fragment in FRAGMENTS {
				out.write_all(fragment).expect("the write should succeed");
			}
			assert_eq!(
				log.lock().len(),
				2,
				"buffered content, then the fragment holding the terminator"
			);
			assert_eq!(log.lock().concat(), b"a.txt:1:hit\n".to_vec());

			let (unbuffered_log, mut unbuffered) = recorder();
			for fragment in FRAGMENTS {
				unbuffered
					.write_all(fragment)
					.expect("the write should succeed");
			}
			assert_eq!(
				unbuffered_log.lock().len(),
				6,
				"writing straight through costs one write per fragment, which is what this replaced"
			);
		}

		/// Two records, two writes: the mode flushes per record, not once at the
		/// end. Without this the case above passes for a writer that buffers
		/// everything and happens to be flushed by the assertion.
		#[test]
		fn line_mode_releases_each_record_as_it_completes() {
			let (log, sink) = recorder();
			let mut out = Buffering::Line.wrap(sink);

			out.write_all(b"a.txt:1:hit\n")
				.expect("the write should succeed");
			assert_eq!(log.lock().len(), 1);
			out.write_all(b"a.txt:2:hit\n")
				.expect("the write should succeed");
			assert_eq!(
				log.lock().len(),
				2,
				"the second record does not wait for the first to be read"
			);
			assert_eq!(log.lock().concat(), b"a.txt:1:hit\na.txt:2:hit\n".to_vec());
		}

		/// Block mode holds COMPLETE records, which is the difference that makes
		/// it faster and the reason a pipeline stage that wants streaming has to
		/// ask.
		#[test]
		fn block_mode_holds_complete_records_until_it_is_flushed() {
			let (log, sink) = recorder();
			let mut out = Buffering::Block.wrap(sink);

			for line in 1..=50 {
				out.write_all(format!("a.txt:{line}:hit\n").as_bytes())
					.expect("the write should succeed");
			}
			assert!(log.lock().is_empty(), "fifty records still fit in the buffer");

			out.flush().expect("the flush should succeed");
			assert_eq!(log.lock().len(), 1, "and they leave as one write");
			assert_eq!(
				log.lock().concat().len(),
				(1..=50)
					.map(|line| format!("a.txt:{line}:hit\n").len())
					.sum::<usize>()
			);
		}

		/// A record longer than the buffer still gets out, since a single long
		/// line must not be held forever.
		#[test]
		fn block_mode_passes_a_record_larger_than_its_buffer() {
			let (log, sink) = recorder();
			let mut out = Buffering::Block.wrap(sink);

			let long = vec![b'x'; 64 * 1024];
			out.write_all(&long).expect("the write should succeed");
			out.flush().expect("the flush should succeed");

			assert_eq!(log.lock().concat().len(), long.len());
		}
	}
}
