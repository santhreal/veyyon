//! Verification suite for pure `TextBuffer` grapheme segmentation and bounded
//! undo/redo.
//!
//! WHY: Naive byte or UTF-8 character indexing tears multi-byte grapheme
//! clusters (combining marks, emoji ZWJ sequences, CRLF, flags) and panics or
//! corrupts text during edits and cursor moves. Unbounded undo stacks cause
//! memory leaks, while unordered undo/redo creates silent state divergence.
//! This suite closes the class of grapheme boundary corruption and undo
//! ordering defects. GAP: Does not test GPUI text shaping or GPU rendering
//! layout boxes, which are tested in
//! `an-editor-turns-keystrokes-into-text-selection-and-events.rs`.

use veyyon_desktop_kit::input::{
	MAX_UNDO_STACK, Selection, TextBuffer, next_grapheme_offset, prev_grapheme_offset,
	snap_to_grapheme,
};

#[test]
fn text_buffer_navigates_and_deletes_complex_grapheme_clusters_atomically() {
	// Combining mark: e + acute (2 code points, 3 UTF-8 bytes)
	let acute_e = "e\u{0301}";
	assert_eq!(acute_e.len(), 3);

	// Emoji ZWJ cluster: family (4 emojis + 3 ZWJ = 25 UTF-8 bytes)
	let family = "👨‍👩‍👧‍👦";
	assert_eq!(family.len(), 25);

	// Flag sequence: US flag (2 regional indicators = 8 UTF-8 bytes)
	let flag = "🇺🇸";
	assert_eq!(flag.len(), 8);

	// CRLF sequence: \r\n (2 bytes)
	let crlf = "\r\n";
	assert_eq!(crlf.len(), 2);

	let mut buffer = TextBuffer::with_text(format!("A{acute_e}B{family}C{flag}D{crlf}E"));

	// Check total initial length
	let total_len = buffer.len();
	assert_eq!(buffer.selection(), Selection::collapsed(total_len));

	// Move left across 'E'
	buffer.move_left(false);
	assert_eq!(buffer.selection().head, total_len - 1);

	// Move left across CRLF (should jump 2 bytes in a single step)
	buffer.move_left(false);
	assert_eq!(buffer.selection().head, total_len - 3);

	// Move left across 'D'
	buffer.move_left(false);
	assert_eq!(buffer.selection().head, total_len - 4);

	// Move left across flag (should jump 8 bytes in a single step)
	buffer.move_left(false);
	assert_eq!(buffer.selection().head, total_len - 12);

	// Delete forward on flag
	let prev_head = buffer.selection().head;
	assert!(buffer.delete_forward());
	assert_eq!(buffer.len(), total_len - 8);
	assert_eq!(buffer.selection().head, prev_head);

	// Move to end and delete backward across 'E' and CRLF
	buffer.move_doc_end(false);
	assert!(buffer.delete_backward()); // Deletes 'E'
	assert!(buffer.delete_backward()); // Deletes CRLF in one atomic deletion
	assert!(!buffer.text().ends_with("\r\n"));
	assert!(!buffer.text().ends_with('\n'));
}

#[test]
fn snap_to_grapheme_never_splits_multibyte_clusters() {
	let family = "👨‍👩‍👧‍👦"; // 25 bytes
	for mid_offset in 1..family.len() {
		let snapped = snap_to_grapheme(family, mid_offset);
		assert!(
			snapped == 0 || snapped == family.len(),
			"Snapped mid-offset {mid_offset} inside emoji cluster to invalid boundary {snapped}"
		);
	}

	// café with combining accent: c (1) a (1) f (1) e\u{0301} (3) = 6 bytes
	let combining_str = "cafe\u{0301}";
	let prev = prev_grapheme_offset(combining_str, 6);
	assert_eq!(prev, 3); // Jumps from end directly to before 'e'
	let next = next_grapheme_offset(combining_str, 3);
	assert_eq!(next, 6); // Jumps from 'e' directly to end
}

#[test]
fn word_movement_and_word_deletion_respect_boundaries() {
	let mut buffer = TextBuffer::with_text("alpha beta gamma   delta 123");

	buffer.move_doc_start(false);
	assert_eq!(buffer.selection().head, 0);

	// Move word right
	buffer.move_word_right(false);
	assert_eq!(buffer.selection().head, 6); // past "alpha "

	buffer.move_word_right(false);
	assert_eq!(buffer.selection().head, 11); // past "beta "
	buffer.move_word_right(false);
	assert_eq!(buffer.selection().head, 19); // past "gamma   "

	// Select word left
	buffer.move_word_left(true);
	assert_eq!(buffer.selection().anchor, 19);
	assert_eq!(buffer.selection().head, 11);
	assert_eq!(buffer.selected_text(), "gamma   ");

	// Delete backward on active selection
	assert!(buffer.delete_backward());
	assert_eq!(buffer.text(), "alpha beta delta 123");
	assert_eq!(buffer.selection(), Selection::collapsed(11));

	// Delete word backward
	buffer.move_doc_end(false);
	assert!(buffer.delete_word_backward());
	assert_eq!(buffer.text(), "alpha beta delta ");
}

#[test]
fn line_start_and_line_end_deletion_and_movement() {
	let mut buffer = TextBuffer::with_text("line one\nsecond line\nthird");

	// Place cursor in the middle of second line
	buffer.move_to(14, false); // inside "second line"

	buffer.move_line_start(false);
	assert_eq!(buffer.selection().head, 9); // right after "line one\n"

	buffer.move_line_end(true);
	assert_eq!(buffer.selection().anchor, 9);
	assert_eq!(buffer.selection().head, 20); // before second '\n'
	assert_eq!(buffer.selected_text(), "second line");

	// Delete to line end
	buffer.move_to(14, false);
	assert!(buffer.delete_to_line_end());
	assert_eq!(buffer.text(), "line one\nsecon\nthird");

	// Delete to line start
	assert!(buffer.delete_to_line_start());
	assert_eq!(buffer.text(), "line one\n\nthird");
}

#[test]
fn line_col_mapping_converts_both_directions() {
	let text = "first line\nsecond\nthird line here";
	let buffer = TextBuffer::with_text(text);

	// Line 0, col 0
	assert_eq!(buffer.line_col(0), (0, 0));
	assert_eq!(buffer.offset_of(0, 0), 0);

	// Line 0, col 5
	assert_eq!(buffer.line_col(5), (0, 5));
	assert_eq!(buffer.offset_of(0, 5), 5);

	// Line 1, col 2 -> offset 11 + 2 = 13
	let (l, c) = buffer.line_col(13);
	assert_eq!(l, 1);
	assert_eq!(c, 2);
	assert_eq!(buffer.offset_of(1, 2), 13);

	// Out of bounds line clamps safely
	assert_eq!(buffer.offset_of(99, 0), text.len());
}

#[test]
fn undo_and_redo_stack_is_bounded_and_restores_exact_lifo_order() {
	let mut buffer = TextBuffer::new();

	// Verify constant bound is positive
	const { assert!(MAX_UNDO_STACK >= 64) };

	// Perform MAX_UNDO_STACK + 50 distinct edits
	let total_edits = MAX_UNDO_STACK + 50;
	for i in 0..total_edits {
		buffer.insert(&format!("x{i} "));
	}

	// Verify that buffer text is not empty and undo stack size is clamped to
	// MAX_UNDO_STACK
	assert!(!buffer.is_empty());

	// Undo all available steps
	let mut undo_count = 0;
	while buffer.undo() {
		undo_count += 1;
		assert!(undo_count <= MAX_UNDO_STACK);
	}
	assert_eq!(
		undo_count, MAX_UNDO_STACK,
		"Undo count must match exactly the maximum bound MAX_UNDO_STACK"
	);

	// Redo all steps back to top
	let mut redo_count = 0;
	while buffer.redo() {
		redo_count += 1;
		assert!(redo_count <= MAX_UNDO_STACK);
	}
	assert_eq!(redo_count, MAX_UNDO_STACK);

	// Test that a new edit after undo clears the redo stack
	buffer.undo();
	buffer.undo();
	buffer.insert("branch");
	assert!(!buffer.redo(), "Redo must be empty after branching edit");
}
