//! Grapheme, word and line boundaries over UTF-8 text.
//!
//! Every offset is a byte offset. Every offset returned is a grapheme boundary,
//! so a caret never lands inside a combining sequence, an emoji ZWJ sequence
//! or a regional-indicator pair.

use std::ops::Range;

use unicode_segmentation::{GraphemeCursor, UnicodeSegmentation};

/// The class a grapheme belongs to for word motion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Class {
	/// Spaces, tabs and line breaks.
	Space,
	/// Letters, digits and the underscore.
	Word,
	/// Everything else: punctuation, symbols, emoji.
	Punct,
}

fn class_of(grapheme: &str) -> Class {
	match grapheme.chars().next() {
		Some(c) if c.is_whitespace() => Class::Space,
		Some(c) if c.is_alphanumeric() || c == '_' => Class::Word,
		_ => Class::Punct,
	}
}

/// Floors `offset` to a char boundary inside `text`.
pub fn floor_char(text: &str, offset: usize) -> usize {
	let mut offset = offset.min(text.len());
	while !text.is_char_boundary(offset) {
		offset -= 1;
	}
	offset
}

/// Ceils `offset` to a char boundary inside `text`.
pub fn ceil_char(text: &str, offset: usize) -> usize {
	let mut offset = offset.min(text.len());
	while !text.is_char_boundary(offset) {
		offset += 1;
	}
	offset
}

/// Floors `offset` to the grapheme boundary at or before it.
pub fn snap_to_grapheme(text: &str, offset: usize) -> usize {
	let offset = floor_char(text, offset);
	if GraphemeCursor::new(offset, text.len(), true).is_boundary(text, 0) == Ok(true) {
		return offset;
	}
	GraphemeCursor::new(offset, text.len(), true)
		.prev_boundary(text, 0)
		.ok()
		.flatten()
		.unwrap_or(0)
}

/// The grapheme boundary after `offset`, or the end of the text.
pub fn next_grapheme(text: &str, offset: usize) -> usize {
	let offset = snap_to_grapheme(text, offset);
	GraphemeCursor::new(offset, text.len(), true)
		.next_boundary(text, 0)
		.ok()
		.flatten()
		.unwrap_or(text.len())
}

/// The grapheme boundary before `offset`, or zero.
pub fn prev_grapheme(text: &str, offset: usize) -> usize {
	let offset = snap_to_grapheme(text, offset);
	GraphemeCursor::new(offset, text.len(), true)
		.prev_boundary(text, 0)
		.ok()
		.flatten()
		.unwrap_or(0)
}

/// The end of the next word after `offset`: whitespace is skipped, then one
/// run of word graphemes or one run of punctuation.
pub fn next_word(text: &str, offset: usize) -> usize {
	let start = snap_to_grapheme(text, offset);
	let mut run = None;
	for (index, grapheme) in text[start..].grapheme_indices(true) {
		let class = class_of(grapheme);
		match run {
			None if class == Class::Space => {},
			None => run = Some(class),
			Some(current) if current == class => {},
			Some(_) => return start + index,
		}
	}
	text.len()
}

/// The start of the word before `offset`, mirroring [`next_word`].
pub fn prev_word(text: &str, offset: usize) -> usize {
	let end = snap_to_grapheme(text, offset);
	let mut run = None;
	for (index, grapheme) in text[..end].grapheme_indices(true).rev() {
		let class = class_of(grapheme);
		match run {
			None if class == Class::Space => {},
			None => run = Some(class),
			Some(current) if current == class => {},
			Some(_) => return index + grapheme.len(),
		}
	}
	0
}

/// The run of same-class graphemes around `offset`, for a double click.
pub fn word_range_at(text: &str, offset: usize) -> Range<usize> {
	let offset = snap_to_grapheme(text, offset);
	let probe = if offset == text.len() { prev_grapheme(text, offset) } else { offset };
	let Some(grapheme) = text[probe..].graphemes(true).next() else {
		return offset..offset;
	};
	let class = class_of(grapheme);
	let mut start = probe;
	for (index, grapheme) in text[..probe].grapheme_indices(true).rev() {
		if class_of(grapheme) != class {
			break;
		}
		start = index;
	}
	let mut end = probe;
	for (index, grapheme) in text[probe..].grapheme_indices(true) {
		if class_of(grapheme) != class {
			break;
		}
		end = probe + index + grapheme.len();
	}
	start..end
}

/// The offset after the line break that starts the line holding `offset`.
pub fn line_start(text: &str, offset: usize) -> usize {
	let offset = floor_char(text, offset);
	text[..offset].rfind('\n').map_or(0, |index| index + 1)
}

/// The offset of the line break that ends the line holding `offset`, or the
/// end of the text.
pub fn line_end(text: &str, offset: usize) -> usize {
	let offset = floor_char(text, offset);
	text[offset..].find('\n').map_or(text.len(), |index| offset + index)
}

/// The zero-based line and grapheme column of `offset`.
pub fn line_column(text: &str, offset: usize) -> (usize, usize) {
	let offset = snap_to_grapheme(text, offset);
	let start = line_start(text, offset);
	let line = text[..start].matches('\n').count();
	(line, text[start..offset].graphemes(true).count())
}

/// The offset of grapheme `column` on line `line`, clamped to the end of that
/// line; a line past the last one is the end of the text.
pub fn offset_for_line_column(text: &str, line: usize, column: usize) -> usize {
	let mut start = 0;
	for _ in 0..line {
		match text[start..].find('\n') {
			Some(index) => start += index + 1,
			None => return text.len(),
		}
	}
	let end = line_end(text, start);
	text[start..end]
		.grapheme_indices(true)
		.nth(column)
		.map_or(end, |(index, _)| start + index)
}
