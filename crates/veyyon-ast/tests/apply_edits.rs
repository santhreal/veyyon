//! `veyyon_ast::ops::apply_edits`, the function that splices rewrite results
//! back into a source file.
//!
//! WHY THIS SUITE EXISTS. `apply_edits` returns `Result`, and every way of
//! giving it a bad edit was supposed to come back as `Err`: overlapping spans,
//! out-of-range spans, replacement text that is not UTF-8. One was not. The
//! function checked that a span was in bounds and correctly ordered and then
//! called `String::replace_range`, which panics when an offset lands inside a
//! multi-byte character. Any source file containing a non-ASCII identifier, a
//! comment in a non-Latin script, or an emoji in a string literal could take
//! the process down instead of reporting a bad edit.
//!
//! It was invisible to the tests that existed because hand-written fixtures are
//! ASCII. `fuzz/fuzz_targets/ast_apply_edits.rs` found it on its first run with
//! `"b\u{df5d7}hhh..."` and an edit deleting one byte at offset 1.
//!
//! Every case below asserts the concrete rewritten string or the concrete
//! error, never merely that the call returned.

use ast_grep_core::source::Edit;
use veyyon_ast::ops::apply_edits;

/// One edit at `position`, deleting `deleted_length` bytes, inserting `text`.
fn edit(position: usize, deleted_length: usize, text: &str) -> Edit<String> {
	Edit::<String> { position, deleted_length, inserted_text: text.as_bytes().to_vec() }
}

mod character_boundaries {
	use super::*;

	/// The exact shape `ast_apply_edits` reported, reduced to its essentials: a
	/// four-byte character at offset 1, and an edit that deletes one byte of it.
	///
	/// The old code panicked here with "end of range should be a character
	/// boundary" from inside `replace_range`. It must be an error.
	#[test]
	fn an_edit_ending_inside_a_multi_byte_character_is_an_error() {
		let source = "b\u{1f600}tail";

		let result = apply_edits(source, &[edit(1, 1, "")]);

		let message = result
			.expect_err("splitting a character must not be accepted")
			.to_string();
		assert!(
			message.contains("splits a multi-byte character"),
			"the error should say what is wrong, got: {message}",
		);
	}

	/// The other half of the same span. A start offset inside a character is
	/// just as invalid, and it fails on a different `is_char_boundary` call.
	#[test]
	fn an_edit_starting_inside_a_multi_byte_character_is_an_error() {
		let source = "b\u{1f600}tail";

		let result = apply_edits(source, &[edit(2, 3, "x")]);

		assert!(result.is_err(), "an edit starting mid-character must be refused");
	}

	/// The error names the offsets, because the caller's next question is which
	/// edit was wrong and a bare "invalid range" does not answer it.
	#[test]
	fn the_error_names_the_offending_range() {
		let message = apply_edits("é", &[edit(0, 1, "e")])
			.expect_err("must fail")
			.to_string();

		assert!(message.contains("0..1"), "the error should name the range, got: {message}");
	}

	/// The control. An edit that lands exactly on both boundaries of a
	/// multi-byte character must still work, so the guard rejects only what is
	/// genuinely invalid rather than refusing all non-ASCII sources.
	#[test]
	fn an_edit_on_the_boundaries_of_a_multi_byte_character_succeeds() {
		let source = "a\u{1f600}b";

		let result = apply_edits(source, &[edit(1, 4, "!")]).expect("aligned edits must apply");

		assert_eq!(result, "a!b");
	}

	/// A multi-byte replacement inserted at a valid offset, with the surrounding
	/// text preserved byte for byte.
	#[test]
	fn a_multi_byte_replacement_is_inserted_verbatim() {
		let result = apply_edits("let x = 1;", &[edit(4, 1, "café")]).expect("must apply");

		assert_eq!(result, "let café = 1;");
	}
}

mod ranges_and_ordering {
	use super::*;

	/// The empty list is the identity. Asserted because a bug that returned the
	/// input unchanged would otherwise satisfy every "did not panic" check.
	#[test]
	fn no_edits_leaves_the_source_untouched() {
		assert_eq!(apply_edits("fn main() {}", &[]).expect("must apply"), "fn main() {}");
	}

	/// Edits apply in reverse position order so earlier offsets stay valid, and
	/// the result is the same whichever order the caller supplies them in.
	#[test]
	fn edits_apply_independently_of_the_order_they_are_given_in() {
		let forward = apply_edits("aXbYc", &[edit(1, 1, "1"), edit(3, 1, "2")]).expect("must apply");
		let reverse = apply_edits("aXbYc", &[edit(3, 1, "2"), edit(1, 1, "1")]).expect("must apply");

		assert_eq!(forward, "a1b2c");
		assert_eq!(reverse, "a1b2c");
	}

	/// An insertion is a zero-length deletion and must not remove anything.
	#[test]
	fn a_zero_length_edit_inserts_without_deleting() {
		assert_eq!(apply_edits("ac", &[edit(1, 0, "b")]).expect("must apply"), "abc");
	}

	/// Two edits over the same span with different replacements are ambiguous
	/// and have to be refused: silently picking one would rewrite a file
	/// differently depending on the order patterns happened to be listed in.
	#[test]
	fn divergent_overlapping_edits_are_refused() {
		let result = apply_edits("abcdef", &[edit(1, 3, "X"), edit(2, 3, "Y")]);

		let message = result.expect_err("overlapping edits must fail").to_string();
		assert!(message.contains("Overlapping"), "got: {message}");
	}

	/// Byte-identical edits are one edit, not an overlap. Several patterns
	/// matching the same node is normal and must not become an error.
	#[test]
	fn identical_edits_collapse_instead_of_colliding() {
		let result = apply_edits("abcdef", &[edit(1, 3, "X"), edit(1, 3, "X")])
			.expect("duplicates must collapse");

		assert_eq!(result, "aXef");
	}

	/// A span past the end of the source is an error, not a truncation.
	#[test]
	fn an_out_of_bounds_span_is_an_error() {
		let message = apply_edits("abc", &[edit(2, 99, "X")])
			.expect_err("must fail")
			.to_string();

		assert!(message.contains("out of bounds"), "got: {message}");
	}

	/// An edit exactly at the end of the source appends.
	#[test]
	fn an_edit_at_the_end_appends() {
		assert_eq!(apply_edits("abc", &[edit(3, 0, "d")]).expect("must apply"), "abcd");
	}

	/// Replacement bytes that are not valid UTF-8 are refused with a message
	/// that says so, rather than producing a `String` that is not text.
	#[test]
	fn non_utf8_replacement_bytes_are_refused() {
		let bad =
			Edit::<String> { position: 0, deleted_length: 1, inserted_text: vec![0xff, 0xfe] };

		let message = apply_edits("abc", &[bad])
			.expect_err("must fail")
			.to_string();

		assert!(message.contains("not valid UTF-8"), "got: {message}");
	}
}
