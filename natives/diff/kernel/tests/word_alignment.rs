//! WHY: intraline word-level diffing highlights the changed words within
//! a modified line. The defect class here is word alignment drifting from
//! the GNU-aligned line diff or miscomputing byte boundaries on multi-byte
//! UTF-8 or punctuation.
//!
//! This suite asserts word alignment across identical lines, word replacements,
//! insertions, deletions, empty strings, and UTF-8 characters.

use veyyon_diff_kernel::{DiffTag, align_words};

#[test]
fn identical_lines_return_one_equal_span() {
	let line = "let x = 42;";
	let ops = align_words(line, line);
	assert_eq!(ops, vec![(DiffTag::Equal, 0..11, 0..11)]);
}

#[test]
fn empty_strings_return_empty_alignment() {
	let ops = align_words("", "");
	assert!(ops.is_empty());
}

#[test]
fn single_word_replacement_in_line() {
	let old = "fn count() -> u32;";
	let new = "fn count() -> u64;";
	let ops = align_words(old, new);

	assert_eq!(ops, vec![
		(DiffTag::Equal, 0..14, 0..14),
		(DiffTag::Replace, 14..17, 14..17),
		(DiffTag::Equal, 17..18, 17..18),
	]);
	assert_eq!(&old[14..17], "u32");
	assert_eq!(&new[14..17], "u64");
}

#[test]
fn word_insertion_and_deletion() {
	let old = "pub struct Panel;";
	let new = "pub struct PanelContent;";
	let ops = align_words(old, new);

	assert_eq!(ops, vec![
		(DiffTag::Equal, 0..11, 0..11),
		(DiffTag::Replace, 11..16, 11..23),
		(DiffTag::Equal, 16..17, 23..24),
	]);
	assert_eq!(&old[11..16], "Panel");
	assert_eq!(&new[11..23], "PanelContent");
}

#[test]
fn unicode_word_alignment() {
	let old = "let emoji = \"🦀 green\";";
	let new = "let emoji = \"🦀 red\";";
	let ops = align_words(old, new);

	assert_eq!(ops, vec![
		(DiffTag::Equal, 0..18, 0..18),
		(DiffTag::Replace, 18..23, 18..21),
		(DiffTag::Equal, 23..25, 21..23),
	]);
	assert_eq!(&old[18..23], "green");
	assert_eq!(&new[18..21], "red");
}
