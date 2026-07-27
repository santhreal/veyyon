//! Escaping a pattern so it matches its own bytes is one rule with one owner.
//!
//! WHAT WAS WRONG. Two engines needed it and each had its own spelling.
//! `veyyon-natives` called `regex::escape`. The `grep` shell builtin
//! hand-rolled it:
//!
//! ```text
//! const META: &[char] = &['\\', '.', '+', '*', '?', '(', ')', '|', '[', ']',
//!                         '{', '}', '^', '$', '#', '&', '-', '~'];
//! ```
//!
//! with a comment saying it mirrored `regex::escape`. It did, character for
//! character, on the day it was written. Nothing kept it mirroring.
//!
//! WHY THAT IS A RECALL BUG WAITING TO HAPPEN, not a style nit. `regex-syntax`
//! decides which characters are meta, and it has changed that set before. The
//! day it adds another, the hand-rolled copy stops escaping it while the engine
//! keeps treating it as special, so `grep -F` for text containing that
//! character silently becomes a REGEX search: fewer matches, no error, in the
//! one mode whose entire promise is that the pattern is not a regex. The same
//! drift would hit the literal-demotion path, where a malformed pattern is
//! escaped and searched as text after both engines reject it.
//!
//! THE RULE NOW lives in `veyyon_grep_kernel::escape_literal_pattern`, which
//! delegates to `regex_syntax::escape`, the function `regex::escape` itself
//! calls. The escaping rule is not ours to own; what is ours is having exactly
//! one import for it.
//!
//! These tests do two things a unit test of the function cannot. They pin the
//! BEHAVIOUR against the retired hand-rolled list over every character it could
//! ever see, so the unification is provably not a behaviour change. And they
//! scan the workspace source, because the compiler is perfectly happy with a
//! third copy appearing tomorrow.

use std::{
	fs,
	path::{Path, PathBuf},
};

use veyyon_grep_kernel::escape_literal_pattern;

/// The exact list the `grep` builtin carried, kept here as the retired
/// implementation this change must not have altered.
///
/// It is spelled out rather than imported because the point is to compare
/// against what the code USED to do. If the two ever disagree, one of two
/// things is true: `regex-syntax` changed its mind, which is the drift this
/// unification exists to absorb, or the delegation is wrong. The test message
/// says which to check.
const RETIRED_META: &[char] =
	&['\\', '.', '+', '*', '?', '(', ')', '|', '[', ']', '{', '}', '^', '$', '#', '&', '-', '~'];

/// The retired hand-rolled escaper, byte for byte as it was.
fn retired_escape(pat: &str) -> String {
	let mut out = String::with_capacity(pat.len());
	for ch in pat.chars() {
		if RETIRED_META.contains(&ch) {
			out.push('\\');
		}
		out.push(ch);
	}
	out
}

fn workspace_root() -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR"))
		.parent()
		.and_then(Path::parent)
		.expect("the crate lives two levels under the workspace root")
		.to_path_buf()
}

/// This file's own path, excluded from the source scans below.
///
/// It contains the retired list on purpose, as the thing being compared
/// against, so it would flag itself. Excluding it by name is the honest fix;
/// obfuscating the list so the scan misses it is how a detector quietly stops
/// matching.
const SCANNER: &str = "crates/veyyon-grep-kernel/tests/literal_escaping_has_one_owner.rs";

/// The one module allowed to name the escaping rule.
const OWNER: &str = "crates/veyyon-grep-kernel/src/lib.rs";

fn workspace_sources() -> Vec<(PathBuf, String)> {
	let mut found = Vec::new();
	collect(&workspace_root().join("crates"), &mut found);
	found.retain(|(path, _)| relative(path) != SCANNER);
	found
}

fn collect(dir: &Path, found: &mut Vec<(PathBuf, String)>) {
	let Ok(entries) = fs::read_dir(dir) else {
		return;
	};
	for entry in entries.flatten() {
		let path = entry.path();
		if path.is_dir() {
			if path
				.file_name()
				.is_some_and(|name| name == "vendor" || name == "target")
			{
				continue;
			}
			collect(&path, found);
		} else if path.extension().is_some_and(|ext| ext == "rs")
			&& let Ok(text) = fs::read_to_string(&path)
		{
			found.push((path, text));
		}
	}
}

fn relative(path: &Path) -> String {
	path
		.strip_prefix(workspace_root())
		.unwrap_or(path)
		.to_string_lossy()
		.replace('\\', "/")
}

/// EVERY ASCII character, escaped both ways and compared.
///
/// This is the whole compatibility argument for the change, and it is
/// exhaustive over the range that matters: every meta character in the retired
/// list is ASCII, so if the two agree on all 128 they agree on the
/// classification itself.
#[test]
fn the_new_owner_agrees_with_the_retired_list_on_every_ascii_character() {
	for byte in 0u8..128 {
		let ch = char::from(byte);
		let input = ch.to_string();

		assert_eq!(
			escape_literal_pattern(&input),
			retired_escape(&input),
			"escaping {ch:?} (0x{byte:02x}) changed. Either regex-syntax changed which characters \
			 are meta, which is the drift this unification absorbs and this test should be updated \
			 to record, or the delegation in escape_literal_pattern is wrong."
		);
	}
}

/// And on characters OUTSIDE ASCII, which must pass through untouched. A rule
/// that escaped a non-ASCII character would corrupt every non-English literal
/// search.
#[test]
fn non_ascii_characters_pass_through_unescaped() {
	for input in ["café", "日本語", "→", "🙂", "Ω", "ß", "\u{1b}", "\u{0}"] {
		assert_eq!(escape_literal_pattern(input), input, "{input:?} must not be escaped");
		assert_eq!(escape_literal_pattern(input), retired_escape(input));
	}
}

/// The list itself, asserted as OUTPUT rather than as membership: each retired
/// meta character comes back with a backslash in front of it. Without this the
/// two implementations could agree by both escaping nothing.
#[test]
fn every_retired_meta_character_is_still_escaped() {
	for &ch in RETIRED_META {
		let escaped = escape_literal_pattern(&ch.to_string());

		assert_eq!(
			escaped.chars().count(),
			2,
			"{ch:?} should escape to two characters, got {escaped:?}"
		);
		assert_eq!(escaped.chars().next(), Some('\\'));
		assert_eq!(escaped.chars().nth(1), Some(ch));
	}
}

/// A character that is NOT meta stays alone, which is the other half of the
/// classification. `%` is the canonical example: it is escapABLE but not meta,
/// so escaping it would be wrong even though it would still match.
#[test]
fn a_non_meta_character_is_left_alone() {
	for input in ["a", "Z", "0", "%", "/", ":", ",", "<", ">", "=", "!", "@", "\"", "'", "`", ";"] {
		assert_eq!(escape_literal_pattern(input), input, "{input:?} is not a meta character");
	}
}

/// Real patterns, not single characters, so the loop and the buffer are
/// exercised together. These are the shapes an agent actually passes to `-F`: a
/// version number, a call expression, a character class, a path.
#[test]
fn real_patterns_escape_the_way_a_reader_expects() {
	let cases: &[(&str, &str)] = &[
		("1.0.37", r"1\.0\.37"),
		("foo(bar)", r"foo\(bar\)"),
		("a[0-9]+", r"a\[0\-9\]\+"),
		// Source `"C:\\Users"` is the eight-character path `C:\Users`; escaping doubles the one
		// backslash, and the expectation is a raw string so both spellings stay readable.
		("C:\\Users", r"C:\\Users"),
		("^start$", r"\^start\$"),
		("a|b", r"a\|b"),
		("x{2,3}", r"x\{2,3\}"),
		("nothing special here", "nothing special here"),
	];

	for (input, expected) in cases {
		assert_eq!(escape_literal_pattern(input), *expected, "input {input:?}");
		assert_eq!(retired_escape(input), *expected, "the retired list disagrees on {input:?}");
	}
}

/// The empty pattern, which is the boundary every string loop gets wrong once.
#[test]
fn the_empty_pattern_escapes_to_nothing() {
	assert_eq!(escape_literal_pattern(""), "");
}

/// ESCAPING IS NOT IDEMPOTENT, and that is worth pinning so nobody "fixes" it.
/// Escaping an already-escaped pattern doubles the backslashes, because a
/// backslash is itself a meta character. A caller that escaped twice would
/// search for a literal backslash it never asked for.
#[test]
fn escaping_twice_doubles_the_backslash() {
	let once = escape_literal_pattern("a.b");
	assert_eq!(once, r"a\.b");
	assert_eq!(escape_literal_pattern(&once), r"a\\\.b");
}

/// THE STRUCTURAL LOCK: no file outside the owner declares a meta-character
/// list.
///
/// This is what stops the copy coming back. A new engine added tomorrow would
/// most naturally paste the list, and nothing about that would fail to compile.
#[test]
fn no_other_module_declares_a_meta_character_list() {
	let offenders: Vec<String> = workspace_sources()
		.into_iter()
		.filter(|(path, text)| relative(path) != OWNER && text.contains("META: &[char]"))
		.map(|(path, _)| relative(&path))
		.collect();

	assert!(
		offenders.is_empty(),
		"a second meta-character list reappeared. Call veyyon_grep_kernel::escape_literal_pattern \
		 instead: {offenders:?}"
	);
}

/// And no file outside the owner calls `regex::escape` directly, which is the
/// OTHER spelling this unification removed. It is not wrong in itself, but two
/// call sites reaching the rule two ways is how the third one ends up
/// hand-rolled.
#[test]
fn no_other_module_reaches_for_the_escaper_directly() {
	let offenders: Vec<String> = workspace_sources()
		.into_iter()
		.filter(|(path, text)| {
			relative(path) != OWNER
				&& (text.contains("regex::escape(") || text.contains("regex_syntax::escape("))
		})
		.map(|(path, _)| relative(&path))
		.collect();

	assert!(
		offenders.is_empty(),
		"call veyyon_grep_kernel::escape_literal_pattern rather than the crate directly: \
		 {offenders:?}"
	);
}

/// NON-VACUITY for both scans above. Each looks for a string, and a scan that
/// stopped finding files would pass by having nothing to look at.
#[test]
fn the_source_scan_is_actually_reading_the_workspace() {
	let sources = workspace_sources();

	assert!(
		sources.len() > 100,
		"the scan found only {} files, so it is not looking at the workspace",
		sources.len()
	);
	assert!(
		sources.iter().any(|(path, _)| relative(path) == OWNER),
		"the owner itself was not scanned, so the exclusion is matching the wrong path"
	);
	assert!(
		sources
			.iter()
			.any(|(_, text)| text.contains("escape_literal_pattern")),
		"no file mentions the shared escaper, so the repointing did not happen"
	);
}
