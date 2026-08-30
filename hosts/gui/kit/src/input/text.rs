//! Editing over `&str`, with no window and no state.
//!
//! Every offset here is a byte offset, every returned offset is on a character
//! boundary, and every function is total: an offset past the end or inside a
//! multi-byte character is clamped rather than a panic, because these offsets
//! arrive from a mouse, an IME and a model, and none of the three can be
//! trusted to know where a grapheme starts.

use std::ops::Range;

use unicode_segmentation::UnicodeSegmentation;

/// The nearest character boundary at or before `offset`, within the string.
pub fn clamp(text: &str, offset: usize) -> usize {
	let mut offset = offset.min(text.len());
	while offset > 0 && !text.is_char_boundary(offset) {
		offset -= 1;
	}
	offset
}

/// The grapheme boundary before `offset`, or 0.
pub fn previous_boundary(text: &str, offset: usize) -> usize {
	let offset = clamp(text, offset);
	text
		.grapheme_indices(true)
		.rev()
		.find_map(|(at, _)| (at < offset).then_some(at))
		.unwrap_or(0)
}

/// The grapheme boundary after `offset`, or the end.
pub fn next_boundary(text: &str, offset: usize) -> usize {
	let offset = clamp(text, offset);
	text
		.grapheme_indices(true)
		.find_map(|(at, _)| (at > offset).then_some(at))
		.unwrap_or(text.len())
}

/// The start of the word before `offset`, skipping the whitespace between.
pub fn word_left(text: &str, offset: usize) -> usize {
	let offset = clamp(text, offset);
	let mut candidate = 0;
	for (at, word) in text.split_word_bound_indices() {
		if at >= offset {
			break;
		}
		if !word.trim().is_empty() {
			candidate = at;
		}
	}
	candidate
}

/// The end of the word after `offset`, skipping the whitespace between.
pub fn word_right(text: &str, offset: usize) -> usize {
	let offset = clamp(text, offset);
	for (at, word) in text.split_word_bound_indices() {
		let end = at + word.len();
		if end > offset && !word.trim().is_empty() {
			return end;
		}
	}
	text.len()
}

/// The word containing `offset`, for a double click.
pub fn word_at(text: &str, offset: usize) -> (usize, usize) {
	let offset = clamp(text, offset);
	for (at, word) in text.split_word_bound_indices() {
		let end = at + word.len();
		if offset >= at && offset <= end && !word.trim().is_empty() {
			return (at, end);
		}
	}
	(offset, offset)
}

/// `text` with `range` replaced, and where the caret lands.
pub fn replace(text: &str, range: Range<usize>, with: &str) -> (String, usize) {
	let start = clamp(text, range.start);
	let end = clamp(text, range.end).max(start);
	let mut out = String::with_capacity(text.len() - (end - start) + with.len());
	out.push_str(&text[..start]);
	out.push_str(with);
	out.push_str(&text[end..]);
	(out, start + with.len())
}

/// A byte offset as a utf16 offset, which is what a platform IME counts in.
pub fn offset_to_utf16(text: &str, offset: usize) -> usize {
	let offset = clamp(text, offset);
	text[..offset].chars().map(char::len_utf16).sum()
}

/// A utf16 offset back to a byte offset.
pub fn offset_from_utf16(text: &str, offset: usize) -> usize {
	let mut utf16 = 0;
	let mut bytes = 0;
	for character in text.chars() {
		if utf16 >= offset {
			break;
		}
		utf16 += character.len_utf16();
		bytes += character.len_utf8();
	}
	bytes
}
