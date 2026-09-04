//! `veyyon_iso::parse_git_diff`: splitting `git diff` output into per-file entries.
//!
//! WHY THIS IS WORTH FUZZING. Isolation's git mode runs `git diff --no-color HEAD`, hands the raw
//! stdout to this parser, and treats what comes back as the authoritative list of what changed
//! inside a sandbox. Everything downstream, including anything that applies a patch, trusts two
//! things about each entry: that its `diff` text is the original slice unmodified, so `git apply`
//! reproduces the change byte for byte, and that a binary block arrived as `diff: None` rather than
//! as bytes pretending to be text. Both are properties of a hand-written line scanner over output
//! this process did not produce, which is exactly the shape a fuzzer is for. The input is also
//! genuinely adversarial in production: the paths inside a diff header come from the repository, so
//! a filename containing a space, a newline, or the literal text `diff --git ` is a file a user can
//! create rather than a case a fuzzer invented.
//!
//! WHAT IS CHECKED, in order of strength.
//!
//! 1. It never panics, and it never allocates unboundedly: the emitted text cannot exceed the input.
//! 2. Every text entry is a verbatim substring of the input and begins with its own `diff --git `
//!    header. That is the slicing contract stated in the parser's own doc comment, and it is what
//!    makes an entry applicable on its own.
//! 3. Re-parsing a single entry's text yields exactly that entry again, with the same path and the
//!    same change kind. This is the round trip that matters, because splitting a blob into pieces is
//!    only correct if each piece is a whole blob. It also catches the specific failure where a
//!    filename smuggles a header into the middle of an entry: if that ever happened, re-parsing the
//!    entry would return two entries instead of one.
//! 4. Entries never outnumber the `diff --git ` headers in the input, so the parser cannot invent a
//!    file that the diff did not mention.

#![no_main]

use libfuzzer_sys::fuzz_target;
use veyyon_iso::{FileChange, parse_git_diff};

/// Count of lines that open a new file block, which bounds the entry count.
fn header_count(text: &str) -> usize {
	text.split_inclusive('\n')
		.filter(|line| line.starts_with("diff --git "))
		.count()
}

fuzz_target!(|data: &[u8]| {
	let entries = parse_git_diff(data);

	let Ok(text) = std::str::from_utf8(data) else {
		// Invalid UTF-8 is refused wholesale rather than parsed partially: a half-decoded diff
		// would produce entries whose text is not what `git` emitted.
		assert!(entries.is_empty(), "non-UTF-8 input must parse to nothing");
		return;
	};

	assert!(
		entries.len() <= header_count(text),
		"parser emitted {} entries for {} headers",
		entries.len(),
		header_count(text)
	);

	let mut emitted_bytes = 0usize;
	for entry in &entries {
		let Some(diff) = &entry.diff else { continue };
		emitted_bytes += diff.len();

		assert!(
			diff.starts_with("diff --git "),
			"entry for {:?} does not begin with its own header",
			entry.path
		);
		assert!(
			text.contains(diff.as_str()),
			"entry for {:?} is not a verbatim slice of the input",
			entry.path
		);

		let reparsed = parse_git_diff(diff.as_bytes());
		assert_eq!(
			reparsed.len(),
			1,
			"re-parsing one entry for {:?} produced {} entries",
			entry.path,
			reparsed.len()
		);
		let round_tripped: &FileChange = &reparsed[0];
		assert_eq!(round_tripped.path, entry.path, "path changed on re-parse");
		assert_eq!(round_tripped.op, entry.op, "change kind changed on re-parse");
		assert_eq!(
			round_tripped.diff.as_deref(),
			Some(diff.as_str()),
			"text changed on re-parse"
		);
	}

	assert!(
		emitted_bytes <= data.len(),
		"emitted {emitted_bytes} bytes of diff text from a {}-byte input",
		data.len()
	);
});
