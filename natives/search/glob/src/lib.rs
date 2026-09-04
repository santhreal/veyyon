//! Glob-pattern normalization and matching, shared by the glob, grep, and
//! ast-grep tools.
//!
//! You give this crate the pattern a user or a model wrote and it gives you
//! back something you can match paths against. Two things happen on the way.
//! First the pattern is normalized: backslashes become forward slashes, a bare
//! `*.ts` becomes `**/*.ts` when you asked for a recursive search, and an
//! unclosed `{` group is closed. Then it is compiled, and the common shapes get
//! a fast path that answers without running the glob engine at all.
//!
//! ```
//! use veyyon_glob::{build_glob_pattern, compile_glob, walk_depth_bound};
//!
//! assert_eq!(build_glob_pattern("*.ts", true), "**/*.ts");
//! assert_eq!(build_glob_pattern("src/*.ts", true), "src/*.ts");
//! assert_eq!(build_glob_pattern("*.{ts,tsx", true), "**/*.{ts,tsx}");
//!
//! let glob = compile_glob("*.rs", true).expect("a valid pattern");
//! assert!(glob.is_match("src/lib.rs"));
//! assert!(!glob.is_match("src/lib.ts"));
//!
//! // A pattern with no `**` and no `{` can only match so deep, and the walker
//! // uses that to avoid descending into a subtree it can never match into.
//! assert_eq!(walk_depth_bound("dir/*.ts"), 2);
//! assert_eq!(walk_depth_bound("**/*.ts"), usize::MAX);
//! ```
//!
//! This is a plain library crate rather than part of the N-API addon, because
//! the addon is `crate-type = ["cdylib"]` with `#[napi]` entry points: nothing
//! can link it, so none of this could be reached by `cargo test` or by a
//! fuzzer. The addon now wraps this crate and converts its errors at the
//! boundary.

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};

/// A pattern that could not be compiled.
///
/// Carries the message the glob engine produced, so the caller can report what
/// was actually wrong with the pattern rather than that something was.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobError {
	message: String,
}

impl GlobError {
	/// The underlying message, for a caller that wraps it in its own error type.
	#[must_use]
	pub fn message(&self) -> &str {
		&self.message
	}
}

impl std::fmt::Display for GlobError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(&self.message)
	}
}

impl std::error::Error for GlobError {}

/// Compiled glob filter with cheap paths for common basename/extension queries.
pub struct CompiledGlob {
	fast_path: GlobFastPath,
	glob_set:  GlobSet,
}

/// Prints the fast path rather than the compiled matcher, which is the part
/// worth seeing in a failure message: a differential failure is always a
/// question of which fast path was chosen.
impl std::fmt::Debug for CompiledGlob {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("CompiledGlob")
			.field("fast_path", &self.fast_path)
			.finish_non_exhaustive()
	}
}

#[derive(Debug)]
enum GlobFastPath {
	/// Matches any path regardless of depth or name (`**`, `**/*`).
	All,
	/// Matches only root-level paths (no `/`), regardless of name (`*`).
	RootOnly,
	/// Matches by extension at any depth (`**/*.ext`, `**/*.{a,b}`).
	Extension(Vec<String>),
	/// Matches by extension only at the root level (`*.ext`, `*.{a,b}`).
	RootExtension(Vec<String>),
	/// Matches a literal basename at any depth (`**/name`).
	Basename(String),
	/// Matches a literal basename only at the root level (bare `name`).
	RootBasename(String),
	/// Falls back to full glob matching.
	GlobSet,
}

impl CompiledGlob {
	/// Returns true when the normalized relative path matches this glob.
	#[must_use]
	pub fn is_match(&self, path: &str) -> bool {
		match &self.fast_path {
			GlobFastPath::All => true,
			GlobFastPath::RootOnly => !path.contains('/'),
			GlobFastPath::Extension(exts) => {
				path_extension(path).is_some_and(|ext| exts.iter().any(|candidate| ext == candidate))
			},
			GlobFastPath::RootExtension(exts) => {
				!path.contains('/')
					&& path_extension(path)
						.is_some_and(|ext| exts.iter().any(|candidate| ext == candidate))
			},
			GlobFastPath::Basename(name) => path.rsplit('/').next() == Some(name.as_str()),
			GlobFastPath::RootBasename(name) => path == name.as_str(),
			GlobFastPath::GlobSet => self.glob_set.is_match(path),
		}
	}

	/// Matches through the glob engine, ignoring the fast paths.
	///
	/// This is the reference answer. [`is_match`](Self::is_match) is an
	/// optimization over it and must agree with it on every path, which is what
	/// `fuzz/fuzz_targets/glob_patterns.rs` checks: a fast path that disagrees
	/// silently includes or excludes files, and nothing downstream would report
	/// it. Exposed for that differential check rather than for ordinary use.
	#[must_use]
	pub fn is_match_via_engine(&self, path: &str) -> bool {
		self.glob_set.is_match(path)
	}

	/// True when this pattern answers from a fast path rather than the engine.
	///
	/// Only useful for telling the two apart in a test or a benchmark.
	#[must_use]
	pub const fn uses_fast_path(&self) -> bool {
		!matches!(self.fast_path, GlobFastPath::GlobSet)
	}
}

/// Normalize a raw glob string: fix path separators, optionally prepend `**/`
/// for recursive matching, and close any unclosed `{` alternation groups.
#[must_use]
pub fn build_glob_pattern(glob: &str, recursive: bool) -> String {
	let normalized = glob.replace('\\', "/");
	let pattern = if !recursive
		|| normalized.contains('/')
		|| normalized.starts_with("**")
		|| is_exact_brace_union(&normalized)
	{
		normalized
	} else {
		format!("**/{normalized}")
	};
	fix_unclosed_braces(pattern)
}

/// Maximum walk depth (path components) a normalized glob pattern can match,
/// or `usize::MAX` when unbounded.
///
/// Walk-relative globs compile with `literal_separator(true)`, so `*`, `?`,
/// and `[...]` never cross `/` — a pattern with N literal segments can only
/// match entries at most N components deep. Bounding the walk to that depth
/// keeps non-recursive patterns (`*`, `dir/*.json`) from traversing an entire
/// subtree they can never match into (the source of "narrow glob timed out on
/// a populated directory" failures).
///
/// `**` matches any number of components and `{...}` alternations may contain
/// `/`, so both disable the bound.
#[must_use]
pub fn walk_depth_bound(pattern: &str) -> usize {
	if pattern.contains("**") || pattern.contains('{') || bracket_class_can_match_separator(pattern)
	{
		return usize::MAX;
	}
	pattern
		.split('/')
		.filter(|seg| !seg.is_empty())
		.count()
		.max(1)
}

/// Whether any `[...]` in `pattern` can match a `/`.
///
/// `literal_separator(true)` stops `*` and `?` from crossing a separator, and
/// it is easy to assume it does the same for a character class. It does not: a
/// class matches whatever it lists, `/` included. So `[,-[]` matches `/`
/// (0x2F sits inside 0x2C..=0x5B) and the pattern spans two components while
/// the segment count says one. The walker then prunes at depth 1 and never
/// visits the directory holding the match, which is a silent recall loss --
/// the caller gets fewer results with nothing to indicate it. Found by
/// `fuzz/fuzz_targets/glob_patterns.rs` on `"*?[?!*?[?!,-[]?*"`, which matches
/// `"b/~0ba"` at depth 2 under a claimed bound of 1.
///
/// Ambiguity answers YES, because the answer only ever removes an
/// optimization: an unterminated `[`, a negated class, or anything this does
/// not understand disables the bound and the walk descends as it did before
/// the bound existed. Getting it wrong the other way loses results.
fn bracket_class_can_match_separator(pattern: &str) -> bool {
	let bytes = pattern.as_bytes();
	let mut idx = 0;
	while idx < bytes.len() {
		match bytes[idx] {
			b'\\' => {
				idx += 2;
				continue;
			},
			b'[' => {},
			_ => {
				idx += 1;
				continue;
			},
		}
		idx += 1;
		// A negated class matches everything it does not list, and almost nothing
		// lists `/`, so treat every negation as able to cross a separator rather
		// than reasoning about the complement.
		if matches!(bytes.get(idx), Some(b'!' | b'^')) {
			return true;
		}
		// `]` first is a literal `]`, not the end of the class.
		if bytes.get(idx) == Some(&b']') {
			idx += 1;
		}
		let mut previous: Option<u8> = None;
		loop {
			let Some(&byte) = bytes.get(idx) else {
				// Unterminated: the compiler may reject it, and if it does not, this
				// has no idea what it matches.
				return true;
			};
			match byte {
				b']' => {
					idx += 1;
					break;
				},
				b'\\' => {
					previous = bytes.get(idx + 1).copied();
					if previous == Some(b'/') {
						return true;
					}
					idx += 2;
				},
				b'-' if previous.is_some() && bytes.get(idx + 1).is_some_and(|&b| b != b']') => {
					let start = previous.unwrap_or(0);
					let end = bytes[idx + 1];
					if start <= b'/' && b'/' <= end {
						return true;
					}
					previous = None;
					idx += 2;
				},
				b'/' => return true,
				other => {
					previous = Some(other);
					idx += 1;
				},
			}
		}
	}
	false
}

/// Compile a glob pattern string into a [`CompiledGlob`].
///
/// When `recursive` is true, simple patterns (no path separators, no leading
/// `**`) are automatically prefixed with `**/`.
///
/// # Errors
///
/// Returns [`GlobError`] when the normalized pattern is not a valid glob.
pub fn compile_glob(glob: &str, recursive: bool) -> Result<CompiledGlob, GlobError> {
	let mut builder = GlobSetBuilder::new();
	let pattern = build_glob_pattern(glob, recursive);
	let parsed = GlobBuilder::new(&pattern)
		.literal_separator(true)
		.build()
		.map_err(|err| GlobError { message: format!("Invalid glob pattern: {err}") })?;
	builder.add(parsed);
	let glob_set = builder
		.build()
		.map_err(|err| GlobError { message: format!("Failed to build glob matcher: {err}") })?;
	Ok(CompiledGlob { fast_path: classify_fast_path(&pattern), glob_set })
}

/// Like [`compile_glob`], but accepts an `Option<&str>` — returns `Ok(None)`
/// when the input is `None`, empty, or whitespace-only.
///
/// # Errors
///
/// Returns [`GlobError`] when a non-empty pattern is not a valid glob.
pub fn try_compile_glob(
	glob: Option<&str>,
	recursive: bool,
) -> Result<Option<CompiledGlob>, GlobError> {
	let Some(glob) = glob.map(str::trim).filter(|v| !v.is_empty()) else {
		return Ok(None);
	};
	compile_glob(glob, recursive).map(Some)
}

fn classify_fast_path(pattern: &str) -> GlobFastPath {
	if matches!(pattern, "**" | "**/*") {
		return GlobFastPath::All;
	}
	if pattern == "*" {
		return GlobFastPath::RootOnly;
	}
	if let Some(ext) = pattern.strip_prefix("**/*.") {
		if is_literal_component(ext) {
			return GlobFastPath::Extension(vec![ext.to_string()]);
		}
	} else if let Some(ext) = pattern.strip_prefix("*.")
		&& is_literal_component(ext)
	{
		return GlobFastPath::RootExtension(vec![ext.to_string()]);
	}
	if let Some(inner) = pattern
		.strip_prefix("**/*.{")
		.and_then(|value| value.strip_suffix('}'))
	{
		if let Some(extensions) = literal_csv(inner) {
			return GlobFastPath::Extension(extensions);
		}
	} else if let Some(inner) = pattern
		.strip_prefix("*.{")
		.and_then(|value| value.strip_suffix('}'))
		&& let Some(extensions) = literal_csv(inner)
	{
		return GlobFastPath::RootExtension(extensions);
	}
	if let Some(name) = pattern.strip_prefix("**/") {
		if is_literal_path(name) {
			return GlobFastPath::Basename(name.to_string());
		}
	} else if is_literal_path(pattern) {
		return GlobFastPath::RootBasename(pattern.to_string());
	}
	GlobFastPath::GlobSet
}

fn literal_csv(inner: &str) -> Option<Vec<String>> {
	let extensions: Vec<String> = inner
		.split(',')
		.filter(|value| !value.is_empty() && is_literal_component(value))
		.map(ToOwned::to_owned)
		.collect();
	if extensions.is_empty() || extensions.len() != inner.split(',').count() {
		None
	} else {
		Some(extensions)
	}
}

fn path_extension(path: &str) -> Option<&str> {
	let base = path.rsplit('/').next().unwrap_or(path);
	let (_, ext) = base.rsplit_once('.')?;
	if ext.is_empty() { None } else { Some(ext) }
}

/// True when `value` can be compared against a path's extension directly.
///
/// A dot is rejected along with the glob metacharacters, and that is not
/// cosmetic. The extension fast path reads `**/*.X` as "this path's extension
/// is X", but a path's extension is the text after its LAST dot while the glob
/// means "anything, then a literal `.X`". Those two agree only when X contains
/// no dot. They disagree for `*..` against `b..` (the glob matches, the
/// extension is empty) and for `**/*.b.rs` against `a.b.rs` (the glob matches,
/// the extension is `rs`), and the disagreement is silent: the tool returns a
/// shorter file list and nothing reports that a fast path answered instead of
/// the engine. Found by `fuzz/fuzz_targets/glob_patterns.rs`, which asks both
/// and compares.
fn is_literal_component(value: &str) -> bool {
	!value.is_empty()
		&& !value
			.chars()
			.any(|ch| matches!(ch, '*' | '?' | '[' | ']' | '{' | '}' | '/' | '\\' | '.'))
}

/// True when `value` is a literal single path component: non-empty, no glob
/// metacharacters, and no path separator, so a "basename" fast path is safe
/// to apply regardless of how many directory levels precede it.
///
/// `.` and `..` are excluded even though they are literal. They are path
/// traversal components, and the glob engine does not treat them as ordinary
/// names: `**/..` answers false for `a/..` where a basename comparison answers
/// true. Whatever the engine's reason, a fast path that disagrees with it is
/// wrong by definition, since the fast path exists to be indistinguishable from
/// it. Found by `fuzz/fuzz_targets/glob_patterns.rs`.
fn is_literal_path(value: &str) -> bool {
	!value.is_empty()
		&& value != "."
		&& value != ".."
		&& !value
			.chars()
			.any(|ch| matches!(ch, '*' | '?' | '[' | ']' | '{' | '}' | '\\' | '/'))
}

/// Close unclosed `{` alternation groups in a glob pattern.
///
/// LLMs occasionally produce patterns like `*.{ts,js` without the closing `}`.
/// Rather than failing, we append the missing braces.
fn fix_unclosed_braces(pattern: String) -> String {
	let opens = pattern.chars().filter(|&c| c == '{').count();
	let closes = pattern.chars().filter(|&c| c == '}').count();
	if opens > closes {
		let mut fixed = pattern;
		for _ in 0..(opens - closes) {
			fixed.push('}');
		}
		fixed
	} else {
		pattern
	}
}

fn is_exact_brace_union(pattern: &str) -> bool {
	if !(pattern.starts_with('{') && pattern.ends_with('}')) {
		return false;
	}
	let inner = &pattern[1..pattern.len() - 1];
	!inner.is_empty()
		&& !inner
			.chars()
			.any(|ch| matches!(ch, '*' | '?' | '[' | ']' | '{' | '}'))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn simple_pattern_gets_recursive_prefix() {
		assert_eq!(build_glob_pattern("*.ts", true), "**/*.ts");
	}

	#[test]
	fn pattern_with_path_stays_as_is() {
		assert_eq!(build_glob_pattern("src/*.ts", true), "src/*.ts");
	}

	#[test]
	fn already_recursive_pattern_unchanged() {
		assert_eq!(build_glob_pattern("**/*.rs", true), "**/*.rs");
	}

	#[test]
	fn non_recursive_keeps_simple_pattern() {
		assert_eq!(build_glob_pattern("*.ts", false), "*.ts");
	}

	#[test]
	fn walk_depth_bound_counts_segments_for_bounded_patterns() {
		assert_eq!(walk_depth_bound("*"), 1);
		assert_eq!(walk_depth_bound("*.json"), 1);
		assert_eq!(walk_depth_bound("dir/*.ts"), 2);
		assert_eq!(walk_depth_bound("a/*/c.txt"), 3);
	}

	#[test]
	fn walk_depth_bound_unbounded_for_recursive_and_brace_patterns() {
		assert_eq!(walk_depth_bound("**/*"), usize::MAX);
		assert_eq!(walk_depth_bound("src/**/*.ts"), usize::MAX);
		// `{}` groups may contain `/`, so segment counting is unsound for them.
		assert_eq!(walk_depth_bound("{a/b,c}/d.txt"), usize::MAX);
	}

	#[test]
	fn compiled_non_recursive_extension_glob_matches_only_root_files() {
		let glob = compile_glob("*.rs", false).expect("compile non-recursive extension glob");

		assert!(glob.is_match("lib.rs"));
		assert!(!glob.is_match("src/lib.rs"));
		assert!(!glob.is_match("lib.ts"));
	}

	#[test]
	fn compiled_recursive_extension_glob_matches_nested_files_after_normalization() {
		let glob = compile_glob("*.rs", true).expect("compile recursive extension glob");

		assert!(glob.is_match("lib.rs"));
		assert!(glob.is_match("src/lib.rs"));
		assert!(glob.is_match("src/nested/lib.rs"));
		assert!(!glob.is_match("src/lib.ts"));
	}

	#[test]
	fn backslashes_normalized() {
		assert_eq!(build_glob_pattern("src\\**\\*.ts", true), "src/**/*.ts");
	}

	#[test]
	fn unclosed_brace_gets_closed() {
		assert_eq!(build_glob_pattern("*.{ts,tsx,js", true), "**/*.{ts,tsx,js}");
	}

	#[test]
	fn deeply_unclosed_braces_all_closed() {
		assert_eq!(build_glob_pattern("{a,{b,c}", true), "**/{a,{b,c}}");
	}

	#[test]
	fn balanced_braces_unchanged() {
		assert_eq!(build_glob_pattern("*.{ts,js}", true), "**/*.{ts,js}");
	}

	#[test]
	fn compile_glob_accepts_valid_pattern() {
		assert!(compile_glob("*.ts", true).is_ok());
	}

	#[test]
	fn compile_glob_fixes_unclosed_brace() {
		assert!(compile_glob("*.{ts,tsx,js", true).is_ok());
	}

	#[test]
	fn exact_brace_union_stays_non_recursive() {
		assert_eq!(build_glob_pattern("{alpha.txt,beta.txt}", true), "{alpha.txt,beta.txt}");
	}

	#[test]
	fn glob_brace_union_still_gets_recursive_prefix() {
		assert_eq!(build_glob_pattern("{*.ts,*.tsx}", true), "**/{*.ts,*.tsx}");
	}

	/// The error carries the engine's own message, so a caller can say what was
	/// wrong with the pattern instead of that something was.
	#[test]
	fn an_invalid_pattern_reports_what_the_engine_said() {
		let error = compile_glob("[", false).expect_err("an unclosed class is not a valid glob");

		assert!(error.to_string().starts_with("Invalid glob pattern:"), "got: {error}");
	}

	/// A blank pattern is not an error, it is the absence of a filter. Every
	/// caller passes an optional user-supplied string here.
	#[test]
	fn a_blank_pattern_compiles_to_no_filter() {
		assert!(
			try_compile_glob(None, true)
				.expect("none is not an error")
				.is_none()
		);
		assert!(
			try_compile_glob(Some(""), true)
				.expect("empty is not an error")
				.is_none()
		);
		assert!(
			try_compile_glob(Some("   "), true)
				.expect("blank is not an error")
				.is_none()
		);
		assert!(
			try_compile_glob(Some("*.ts"), true)
				.expect("valid")
				.is_some()
		);
	}
}
