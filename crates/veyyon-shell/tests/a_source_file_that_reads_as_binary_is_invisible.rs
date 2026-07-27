//! A source file must survive a text scan.
//!
//! WHAT WENT WRONG. `crates/veyyon-text/src/lib.rs` carried two raw 0x00 bytes
//! inside a doc comment. The author meant to name the NUL byte and wrote it as
//! itself instead of spelling it. `rustc` does not care: a NUL inside a comment
//! is whitespace to the lexer, so the crate built and its tests passed.
//!
//! WHY IT MATTERS ANYWAY. `rg` and `grep` classify a file containing a NUL as
//! BINARY and skip it. A 2679-line source file therefore dropped out of every
//! repo-wide text scan without saying anything: `rg` printed
//! "binary file matches" instead of the lines, `grep -c` returned nothing, and
//! a coverage survey that counted `#[test]` per file reported the file as
//! having ZERO tests when it had nine. Every audit built on searching the tree
//! silently excluded it, including the source-scanning locks in this same
//! directory. A file that cannot be searched cannot be reviewed, and nothing in
//! the build would ever have told anyone.
//!
//! WHAT THIS PINS. No `.rs` file under `crates/` contains a control character
//! that a text tool treats as a binary marker. Tab, newline and carriage return
//! are ordinary source bytes and are allowed; everything else below 0x20, plus
//! the 0x7f delete, is not. The rule is deliberately about the FILE rather than
//! about string literals, because the corruption was in a comment, where no
//! lint and no formatter looks.
//!
//! Write the byte's NAME (`NUL`, `ESC`, `0x1b`) in prose, and use an escape
//! (`'\0'`, `"\x1b"`) in code. Both are ASCII text and neither trips the
//! classifier.

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

/// Every `.rs` file under `crates/`, as RAW BYTES.
///
/// Bytes and not a `String`, which is the whole point: `fs::read_to_string`
/// succeeds on a file containing a NUL, because a NUL is valid UTF-8, so a
/// scanner built on it cannot see this defect at all. The corruption is a
/// property of the byte stream and has to be read as one.
///
/// The vendored trees are excluded. They are read-only snapshots of other
/// people's code and are not ours to reformat.
fn workspace_source_bytes() -> Vec<(PathBuf, Vec<u8>)> {
	let mut found = Vec::new();
	collect(&workspace_root().join("crates"), &mut found);
	found
}

fn collect(dir: &Path, found: &mut Vec<(PathBuf, Vec<u8>)>) {
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
			&& let Ok(bytes) = fs::read(&path)
		{
			found.push((path, bytes));
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

/// The bytes a text tool reads as a binary marker: any control byte that is not
/// tab, newline or carriage return, plus delete.
///
/// This is the classification `grep` and `rg` apply, and it is why the rule is
/// worth having: the set is not "unprintable characters I dislike", it is the
/// set that makes a file disappear from a search.
const fn is_binary_marker(byte: u8) -> bool {
	(byte < 0x20 && byte != b'\t' && byte != b'\n' && byte != b'\r') || byte == 0x7f
}

/// Report every offending byte in `bytes` as `(1-based line, byte value)`.
fn binary_markers(bytes: &[u8]) -> Vec<(usize, u8)> {
	let mut hits = Vec::new();
	let mut line = 1usize;
	for byte in bytes {
		if *byte == b'\n' {
			line += 1;
			continue;
		}
		if is_binary_marker(*byte) {
			hits.push((line, *byte));
		}
	}
	hits
}

/// THE RULE: no workspace source file reads as binary.
///
/// The file count is asserted first. A scan that stopped finding files would
/// otherwise pass by having nothing to check, which is the failure mode every
/// source-scanning gate has, and this gate exists precisely because a file went
/// missing from a scan.
#[test]
fn no_workspace_source_reads_as_binary() {
	let sources = workspace_source_bytes();
	assert!(
		sources.len() > 100,
		"the scan must reach the whole tree, found {} files",
		sources.len()
	);

	let mut offenders = Vec::new();
	for (path, bytes) in &sources {
		for (line, byte) in binary_markers(bytes) {
			offenders.push(format!("{}:{line} holds byte {byte:#04x}", relative(path)));
		}
	}

	assert!(
		offenders.is_empty(),
		"these files are invisible to rg/grep; spell the byte's name in prose or use an escape in \
		 code:\n{}",
		offenders.join("\n")
	);
}

/// The file that carried the defect is REACHED by this scan.
///
/// Named explicitly, because "no file offends" is satisfied by a walker that
/// never opens the one file that did. It is also the largest source file in its
/// crate, so a scan that finds it is reaching past the shallow entries.
#[test]
fn the_file_that_carried_the_defect_is_scanned() {
	let sources = workspace_source_bytes();
	let target = sources
		.iter()
		.find(|(path, _)| relative(path) == "crates/veyyon-text/src/lib.rs")
		.expect("the text crate's source must be part of the scan");

	assert!(target.1.len() > 50_000, "the whole file must be read, got {} bytes", target.1.len());
	assert!(
		binary_markers(&target.1).is_empty(),
		"the file that started this rule must satisfy it: {:?}",
		binary_markers(&target.1)
	);
}

/// The detector finds a NUL wherever it sits, including in a comment, which is
/// where the real one was and where no lint looks.
#[test]
fn a_nul_is_reported_from_a_comment_or_a_literal() {
	let commented = b"fn main() {}\n// a nul \x00 here\n";
	assert_eq!(binary_markers(commented), vec![(2, 0x00)]);

	let in_literal = b"const A: &str = \" \x00 \";\n";
	assert_eq!(binary_markers(in_literal), vec![(1, 0x00)]);

	// Line numbers are 1-based and count only newlines, so a marker on the first
	// line reports 1 and one after two newlines reports 3.
	let later = b"a\nb\nc \x00\n";
	assert_eq!(binary_markers(later), vec![(3, 0x00)]);
}

/// A raw ESC is caught too, and it is the one most likely to arrive by
/// accident: pasting terminal output into a doc comment or a test fixture
/// brings real escape sequences with it.
#[test]
fn a_raw_escape_byte_is_reported() {
	let pasted = b"/// pasted: \x1b[31mred\x1b[0m\n";
	assert_eq!(binary_markers(pasted), vec![(1, 0x1b), (1, 0x1b)]);

	// The delete byte counts as well.
	assert_eq!(binary_markers(b"x \x7f\n"), vec![(1, 0x7f)]);
}

/// THE NEGATIVE HALF: the three whitespace controls that belong in source are
/// not reported, and neither is ordinary text or an ESCAPED byte.
///
/// The escaped forms matter most. `"\0"` and `"\x1b"` are the correct way to
/// write these bytes, they are what most of this workspace already contains,
/// and a rule that flagged them would be unusable.
#[test]
fn tabs_newlines_carriage_returns_and_escapes_are_not_markers() {
	assert!(binary_markers(b"fn main() {\n\tlet x = 1;\r\n}\n").is_empty());
	assert!(binary_markers(br"let nul = '\0';").is_empty());
	assert!(binary_markers(br#"let esc = "\x1b[0m";"#).is_empty());
	assert!(binary_markers("let s = \"héllo ☃ 🎉\";\n".as_bytes()).is_empty());
	assert!(binary_markers(b"").is_empty());
}

/// The classifier's boundary, stated as values rather than inferred from the
/// cases above: 0x00 through 0x1f are markers except the three whitespace ones,
/// 0x20 and everything above it up to 0x7e is not, and 0x7f is.
#[test]
fn the_classifier_boundary_is_exact() {
	for byte in 0u8..=0x1f {
		let allowed = byte == b'\t' || byte == b'\n' || byte == b'\r';
		assert_eq!(is_binary_marker(byte), !allowed, "for byte {byte:#04x}");
	}
	for byte in 0x20u8..=0x7e {
		assert!(!is_binary_marker(byte), "printable {byte:#04x} must be allowed");
	}
	assert!(is_binary_marker(0x7f), "delete must be a marker");
	// Bytes above 0x7f are UTF-8 continuation and lead bytes; a text tool reads
	// them as text and so does this rule.
	for byte in [0x80u8, 0xc3, 0xe2, 0xf0, 0xff] {
		assert!(!is_binary_marker(byte), "high byte {byte:#04x} must be allowed");
	}
}
