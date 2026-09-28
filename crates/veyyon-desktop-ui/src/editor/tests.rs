//! Text buffer contracts: grapheme-safe deletion and motion, word stops,
//! undo grouping and redo invalidation.

use super::{EditKind, Motion, TextBuffer, Unit};

/// Man, zero-width joiner, woman, zero-width joiner, girl: one grapheme.
const FAMILY: &str = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";

/// An `e` followed by a combining acute accent: one grapheme, three bytes.
const E_ACUTE: &str = "e\u{301}";

#[test]
fn backspace_removes_a_whole_emoji_zwj_sequence() {
	let mut buffer = TextBuffer::with_text(format!("a{FAMILY}"));
	assert!(buffer.delete_backward(Unit::Grapheme));
	assert_eq!(buffer.text(), "a");
	assert_eq!(buffer.cursor(), 1);

	let mut buffer = TextBuffer::with_text(format!("{FAMILY}b"));
	buffer.move_to(0, false);
	assert!(buffer.delete_forward(Unit::Grapheme));
	assert_eq!(buffer.text(), "b");
}

#[test]
fn a_combining_mark_deletes_and_moves_with_its_base() {
	let mut buffer = TextBuffer::with_text(format!("x{E_ACUTE}y"));
	buffer.move_to(1 + E_ACUTE.len(), false);
	assert!(buffer.delete_backward(Unit::Grapheme));
	assert_eq!(buffer.text(), "xy");

	let mut buffer = TextBuffer::with_text(format!("{E_ACUTE}!"));
	buffer.move_caret(Motion::DocStart, false);
	buffer.move_caret(Motion::Right, false);
	assert_eq!(buffer.cursor(), E_ACUTE.len(), "the caret steps over the mark");
	buffer.move_to(1, false);
	assert_eq!(buffer.cursor(), 0, "an offset inside the cluster floors to its start");
	assert!(buffer.delete_forward(Unit::Grapheme));
	assert_eq!(buffer.text(), "!");
}

/// Collects the caret offsets `motion` visits from `start` until it stops
/// moving.
fn stops(text: &str, start: usize, motion: Motion) -> Vec<usize> {
	let mut buffer = TextBuffer::with_text(text);
	buffer.move_to(start, false);
	let mut stops = Vec::new();
	loop {
		let before = buffer.cursor();
		buffer.move_caret(motion, false);
		if buffer.cursor() == before {
			return stops;
		}
		stops.push(buffer.cursor());
	}
}

#[test]
fn word_motion_stops_at_each_word_and_each_punctuation_run() {
	let text = "foo.bar(baz)  qux";
	assert_eq!(stops(text, 0, Motion::WordRight), [3, 4, 7, 8, 11, 12, 17]);
	assert_eq!(stops(text, text.len(), Motion::WordLeft), [14, 11, 8, 7, 4, 3, 0]);
	assert_eq!(stops("a::b", 0, Motion::WordRight), [1, 3, 4]);
	assert_eq!(stops("snake_case!", 0, Motion::WordRight), [10, 11]);
}

#[test]
fn word_deletion_removes_one_word_or_one_punctuation_run() {
	let mut buffer = TextBuffer::with_text("call(arg)");
	assert!(buffer.delete_backward(Unit::Word));
	assert_eq!(buffer.text(), "call(arg");
	assert!(buffer.delete_backward(Unit::Word));
	assert_eq!(buffer.text(), "call(");
}

#[test]
fn consecutive_typing_undoes_as_one_step() {
	let mut buffer = TextBuffer::new();
	for ch in ["h", "e", "l", "l", "o", " ", "w"] {
		buffer.insert(ch);
	}
	buffer.move_caret(Motion::Left, false);
	buffer.insert("X");
	assert_eq!(buffer.text(), "hello Xw");

	assert!(buffer.undo(), "a caret motion closes the typing step");
	assert_eq!(buffer.text(), "hello w");
	assert!(buffer.undo());
	assert_eq!(buffer.text(), "");
	assert!(!buffer.undo());
}

#[test]
fn consecutive_backspaces_undo_as_one_step_and_restore_the_selection() {
	let mut buffer = TextBuffer::with_text("abcd");
	assert!(buffer.delete_backward(Unit::Grapheme));
	assert!(buffer.delete_backward(Unit::Grapheme));
	assert_eq!(buffer.text(), "ab");
	assert!(buffer.undo());
	assert_eq!(buffer.text(), "abcd");
	assert_eq!(buffer.cursor(), 4);
}

#[test]
fn a_composition_and_its_commit_undo_as_one_step() {
	let mut buffer = TextBuffer::with_text("a");
	let marked = buffer.edit(1..1, "n", EditKind::Composition);
	let marked = buffer.edit(marked, "ni", EditKind::Composition);
	buffer.edit(marked, "\u{4f60}", EditKind::Composition);
	assert_eq!(buffer.text(), "a\u{4f60}");
	assert!(buffer.undo());
	assert_eq!(buffer.text(), "a");
}

#[test]
fn an_edit_after_undo_discards_redo() {
	let mut buffer = TextBuffer::new();
	buffer.insert("a");
	buffer.move_caret(Motion::DocEnd, false);
	buffer.insert("b");
	assert!(buffer.undo());
	assert!(buffer.redo(), "redo reapplies the undone step");
	assert_eq!(buffer.text(), "ab");

	assert!(buffer.undo());
	buffer.insert("c");
	assert!(!buffer.redo(), "the new edit discarded the undone step");
	assert_eq!(buffer.text(), "ac");
}

#[test]
fn line_and_column_map_through_graphemes() {
	let buffer = TextBuffer::with_text(format!("ab\n{E_ACUTE}z\n"));
	let z = 3 + E_ACUTE.len();
	assert_eq!(buffer.line_column(z), (1, 1));
	assert_eq!(buffer.offset_for_line_column(1, 1), z);
	assert_eq!(buffer.offset_for_line_column(0, 9), 2, "a column past the end clamps");
	assert_eq!(buffer.line_column(buffer.len()), (2, 0));
	assert_eq!(buffer.line_count(), 3);
}
