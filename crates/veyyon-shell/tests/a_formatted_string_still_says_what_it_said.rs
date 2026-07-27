//! The formatter must not change what a string literal SAYS.
//!
//! WHAT WENT WRONG. This workspace sets `format_strings = true` in
//! `rustfmt.toml`, so rustfmt breaks any string literal wider than `max_width`
//! across source lines. Its splitting is escape-unaware: given a literal
//! containing `\n\n`, it can put the break BETWEEN the `\` and the `n` of the
//! second escape, and it then writes the orphaned backslash as `\\`. That
//! leaves a source line ending in `\\` inside a string literal, and `\\` is an
//! ESCAPED BACKSLASH, not a line continuation. The newline that follows it
//! therefore goes into the string raw, along with the indentation of the next
//! line, and the leftover `n` becomes a plain letter.
//!
//! A gradle fixture in `src/minimizer/filters/jvm.rs` was corrupted exactly
//! this way. Where gradle prints a blank line and then a rule of dashes, the
//! fixture held a backslash, a newline, three tabs, a space and then `n------`.
//! NOTHING FAILED. The assertions on it were `contains` probes, so a fixture
//! that no longer resembled gradle output still satisfied every one of them,
//! and the corruption survived in the tree until somebody hit the same
//! formatter break in a test whose assertion was exact.
//!
//! WHY A SOURCE SCAN. The compiler is happy with the corrupted form: it is a
//! valid literal, just not the one anybody wrote. `cargo fmt --check` is happy
//! too, because the corrupted form IS the formatter's output and running it
//! again is a no-op. No existing gate can see this, which is why it needs one
//! of its own.
//!
//! WHAT IS AND IS NOT A VIOLATION. A source line ending with an ODD number of
//! backslashes inside a string literal is rustfmt's ordinary, correct
//! continuation: the last backslash escapes the newline and the leading
//! whitespace of the next line is discarded. A line ending with an EVEN number
//! of backslashes, two or more, is the defect: the backslashes pair off into
//! literal backslashes and nothing escapes the newline. An intentional
//! multi-line literal, which this repository uses for terminal-output fixtures,
//! ends its lines with no backslash at all and is untouched by this rule.
//!
//! THE FIX FOR A FLAGGED LINE is never to re-wrap the literal by hand, because
//! the next `cargo fmt` will re-split it in the same place. Write the value as
//! one array element per line joined with `"\n"`, so every element stays under
//! `max_width` and there is nothing for the formatter to split.

use std::{
	fs,
	path::{Path, PathBuf},
};

/// The workspace root, from this crate's own manifest directory.
fn workspace_root() -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR"))
		.parent()
		.and_then(Path::parent)
		.expect("the crate lives two levels under the workspace root")
		.to_path_buf()
}

/// One backslash, as source text, built here so no literal in this file ends in
/// one.
///
/// The snippets below have to CONTAIN the defect in order to prove the scanner
/// sees it, and a snippet written the obvious way would put `\\` at the end of
/// a line of this very file, making the scanner flag its own test data.
/// Composing the needles from this constant keeps every literal here one line
/// long and lets this file be scanned along with every other, rather than
/// excluded from its own rule.
const BS: &str = "\\";

/// Where a raw newline sits inside a non-raw string literal directly after an
/// escaped backslash: the signature of a split escape.
///
/// This is a small Rust lexer rather than a regex, and it has to be. The
/// question "is this newline inside a string literal" cannot be answered by
/// looking at a line: it depends on every quote, comment, raw string and
/// character literal before it. A regex over lines would flag a `\\` at the end
/// of a comment and miss one inside a literal that opened three lines earlier.
///
/// Returns 1-based line numbers, so a failure names the line a reader can open.
fn split_escapes(source: &str) -> Vec<usize> {
	let bytes: Vec<char> = source.chars().collect();
	let mut hits = Vec::new();
	let mut i = 0usize;
	let mut line = 1usize;
	while i < bytes.len() {
		// A line comment runs to the newline, which the outer loop then counts.
		if bytes[i] == '/' && bytes.get(i + 1) == Some(&'/') {
			while i < bytes.len() && bytes[i] != '\n' {
				i += 1;
			}
			continue;
		}
		// Block comments nest in Rust, so this counts depth rather than scanning for
		// the first `*/`.
		if bytes[i] == '/' && bytes.get(i + 1) == Some(&'*') {
			let mut depth = 1usize;
			i += 2;
			while i < bytes.len() && depth > 0 {
				if bytes[i] == '/' && bytes.get(i + 1) == Some(&'*') {
					depth += 1;
					i += 2;
				} else if bytes[i] == '*' && bytes.get(i + 1) == Some(&'/') {
					depth -= 1;
					i += 2;
				} else {
					if bytes[i] == '\n' {
						line += 1;
					}
					i += 1;
				}
			}
			continue;
		}
		if let Some(next) = raw_string_end(&bytes, i, &mut line) {
			i = next;
			continue;
		}
		if let Some(next) = normal_string_end(&bytes, i, &mut line, &mut hits) {
			i = next;
			continue;
		}
		if bytes[i] == '\n' {
			line += 1;
		}
		i += 1;
	}
	hits
}

/// Consume a raw string starting at `at`, if one starts there.
///
/// Raw strings have no escapes at all, so a newline inside one is always
/// deliberate and never this defect. They are skipped whole, including the
/// `b` prefix of a raw byte string and any number of `#` delimiters.
fn raw_string_end(chars: &[char], at: usize, line: &mut usize) -> Option<usize> {
	let mut i = at;
	if chars.get(i) == Some(&'b') {
		i += 1;
	}
	if chars.get(i) != Some(&'r') {
		return None;
	}
	i += 1;
	let mut hashes = 0usize;
	while chars.get(i) == Some(&'#') {
		hashes += 1;
		i += 1;
	}
	if chars.get(i) != Some(&'"') {
		return None;
	}
	i += 1;
	loop {
		if i >= chars.len() {
			return Some(i);
		}
		if chars[i] == '"' && chars[i + 1..].iter().take(hashes).all(|c| *c == '#') {
			return Some(i + 1 + hashes);
		}
		if chars[i] == '\n' {
			*line += 1;
		}
		i += 1;
	}
}

/// Consume a normal (escaped) string starting at `at`, if one starts there,
/// recording every split escape found inside it.
///
/// The one interesting branch is the escape: `\` plus a newline is the LEGAL
/// continuation and is consumed as a unit, while `\` plus anything else is a
/// two-character escape, and if the character AFTER that escape is a newline
/// then the escape was `\\` and the newline is raw. That is the defect, and it
/// is the only place this function records anything.
fn normal_string_end(
	chars: &[char],
	at: usize,
	line: &mut usize,
	hits: &mut Vec<usize>,
) -> Option<usize> {
	let mut i = at;
	if chars.get(i) == Some(&'b') {
		i += 1;
	}
	if chars.get(i) != Some(&'"') {
		return None;
	}
	i += 1;
	while i < chars.len() {
		match chars[i] {
			'\\' => {
				if chars.get(i + 1) == Some(&'\n') {
					*line += 1;
					i += 2;
					continue;
				}
				i += 2;
				if chars.get(i) == Some(&'\n') {
					hits.push(*line);
				}
			},
			'"' => return Some(i + 1),
			'\n' => {
				*line += 1;
				i += 1;
			},
			_ => i += 1,
		}
	}
	Some(i)
}

/// Every `.rs` file under `crates/`, excluding the vendored trees, which are
/// read-only snapshots of other people's code formatted under other rules.
fn workspace_sources() -> Vec<(PathBuf, String)> {
	let mut found = Vec::new();
	collect(&workspace_root().join("crates"), &mut found);
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

/// No source file in the workspace holds a split escape.
///
/// The file count is asserted first, because a scan that stopped finding files
/// would otherwise pass this by having nothing to check, which is the failure
/// mode every source-scanning gate has.
#[test]
fn no_workspace_source_holds_a_split_escape() {
	let sources = workspace_sources();
	assert!(
		sources.len() > 100,
		"the scan found only {} files, so it is not looking at the workspace",
		sources.len()
	);

	let mut offenders = Vec::new();
	for (path, text) in &sources {
		for line in split_escapes(text) {
			offenders.push(format!("{}:{line}", relative(path)));
		}
	}

	assert!(
		offenders.is_empty(),
		"rustfmt split an escape sequence in these literals, so they no longer say what was \
		 written. Rewrite each as one array element per line joined with a newline: {offenders:?}"
	);
}

/// THE REAL CORRUPTION, reconstructed: the gradle fixture as the formatter left
/// it. Without this case the test above passes on a scanner that never matches.
#[test]
fn the_gradle_fixture_as_the_formatter_left_it_is_flagged() {
	let source = format!("let input = \"> Task :app:dependencies{BS}n{BS}{BS}\n\t\t\t n---\";\n");

	assert_eq!(split_escapes(&source), vec![1], "source under test: {source:?}");
}

/// The HARMLESS neighbour of the case above, and the reason the rule counts
/// backslashes rather than looking for `\\` anywhere near a line end.
///
/// A yarn fixture in `src/minimizer/filters/pkg.rs` was split one character
/// further along, leaving THREE backslashes at the end of the line: two pair
/// off into a literal backslash and the third escapes the newline, so the value
/// is exactly what was written. Ugly, but correct, and flagging it would train
/// a reader to ignore this gate.
#[test]
fn three_trailing_backslashes_are_a_valid_continuation() {
	let source = format!("let input = \"react@npm:19.0.0{BS}{BS}{BS}\n\t\t\t n end\";\n");

	assert!(split_escapes(&source).is_empty(), "source under test: {source:?}");
}

/// The ordinary continuation rustfmt writes everywhere: ONE backslash at the
/// end of the line. If this were flagged the gate would fail on most of the
/// workspace.
#[test]
fn one_trailing_backslash_is_the_normal_split() {
	let source = format!("let s = \"a long line that the formatter broke {BS}\n\t\t\t here\";\n");

	assert!(split_escapes(&source).is_empty(), "source under test: {source:?}");
}

/// An intentional multi-line literal, which this repository uses for
/// terminal-output fixtures. It ends its lines with no backslash at all, so the
/// rule leaves it alone.
#[test]
fn an_intentional_multi_line_literal_is_not_a_violation() {
	let source = "let input = \"\\\n✓ a.test.ts > add works\n\n 1 pass\n\";\n";

	assert!(split_escapes(source).is_empty(), "source under test: {source:?}");
}

/// A raw string has no escapes, so a newline inside one cannot be a split
/// escape, and a `\\` inside one is two literal backslashes rather than an
/// escape at all.
#[test]
fn a_raw_string_is_skipped_whole() {
	let source = format!("let s = r#\"a{BS}{BS}\n   nb\"#;\nlet t = r\"c{BS}{BS}\n   nd\";\n");

	assert!(split_escapes(&source).is_empty(), "source under test: {source:?}");
}

/// A quote inside a comment does not open a string literal. Without this, one
/// stray apostrophe or quote in a doc comment would put the lexer inside a
/// literal for the rest of the file and the gate would report nonsense.
#[test]
fn a_quote_in_a_comment_does_not_open_a_literal() {
	let source = format!(
		"// a comment with a \" quote and a trailing {BS}{BS}\nlet s = \"fine\";\n/* block \" */\n"
	);

	assert!(split_escapes(&source).is_empty(), "source under test: {source:?}");
}

/// Block comments nest in Rust, so a `/*` inside a block comment must not end
/// it early and leave the rest of the file scanned as code.
#[test]
fn nested_block_comments_close_at_the_right_place() {
	let source = format!("/* outer /* inner \" */ still comment {BS}{BS}\n*/\nlet s = \"ok\";\n");

	assert!(split_escapes(&source).is_empty(), "source under test: {source:?}");
}

/// A byte string is escaped like a normal string, so it is scanned like one:
/// the same defect in `b"..."` is the same defect.
#[test]
fn a_byte_string_is_scanned_like_a_normal_string() {
	let source = format!("let s = b\"a{BS}n{BS}{BS}\n\t\t\t nb\";\n");

	assert_eq!(split_escapes(&source), vec![1], "source under test: {source:?}");
}

/// The line number a failure reports is the line the literal's defect is ON,
/// not the line the literal started on and not the line after the break. A gate
/// that names the wrong line sends the reader to the wrong place.
#[test]
fn the_reported_line_is_where_the_split_happened() {
	let source = format!(
		"fn main() {{\n\tlet a = 1;\n\tlet s = \"x{BS}n{BS}{BS}\n\t\t\t ny\";\n\tlet b = 2;\n}}\n"
	);

	assert_eq!(split_escapes(&source), vec![3], "source under test: {source:?}");
}

/// Two defects in one file are both reported, so a single `cargo fmt` that
/// broke several literals does not look like one problem.
///
/// The expected lines are 1 and 4, not 1 and 3: each broken literal SPANS two
/// source lines, so the second one starts on line 4. Getting this wrong is easy
/// and is why the line numbers are asserted rather than just the count.
#[test]
fn every_split_escape_in_a_file_is_reported() {
	let source = format!(
		"let a = \"p{BS}n{BS}{BS}\n\t nq\";\nlet b = 1;\nlet c = \"r{BS}n{BS}{BS}\n\t ns\";\n"
	);

	assert_eq!(split_escapes(&source), vec![1, 4], "source under test: {source:?}");
}

/// FOUR trailing backslashes: even, so they all pair off and nothing escapes
/// the newline. The rule is about parity, not about the exact count of two, and
/// a scanner that special-cased `\\` would miss this.
#[test]
fn four_trailing_backslashes_are_also_a_violation() {
	let source = format!("let s = \"a{BS}n{BS}{BS}{BS}{BS}\n\t\t\t nb\";\n");

	assert_eq!(split_escapes(&source), vec![1], "source under test: {source:?}");
}
