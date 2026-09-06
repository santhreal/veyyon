//! Pure text buffer with grapheme-aligned selection and bounded undo history
//! (§8.25).

use std::ops::Range;

pub mod grapheme;
pub mod selection;
pub mod undo;

pub use grapheme::{
	line_col_for_offset, line_end_offset, line_start_offset, next_grapheme_offset, next_word_offset,
	offset_for_line_col, prev_grapheme_offset, prev_word_offset, snap_to_grapheme, word_range_at,
};
pub use selection::Selection;
pub use undo::{MAX_UNDO_STACK, UndoEntry, UndoStack};

/// Pure text buffer maintaining text content, grapheme-aligned selection, and
/// undo history.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TextBuffer {
	text:      String,
	selection: Selection,
	undo:      UndoStack,
}

impl TextBuffer {
	/// Creates a new empty text buffer with caret at offset 0.
	#[must_use]
	pub fn new() -> Self {
		Self {
			text:      String::new(),
			selection: Selection::default(),
			undo:      UndoStack::new(),
		}
	}

	/// Creates a text buffer initialized with text content, caret at the end.
	#[must_use]
	pub fn with_text(text: impl Into<String>) -> Self {
		let text = text.into();
		let len = text.len();
		Self { text, selection: Selection::collapsed(len), undo: UndoStack::new() }
	}

	/// Returns a reference to the buffer string content.
	#[must_use]
	pub fn text(&self) -> &str {
		&self.text
	}

	/// Returns current grapheme-aligned selection.
	#[must_use]
	pub const fn selection(&self) -> Selection {
		self.selection
	}

	/// Sets selection, snapping anchor and head to valid grapheme cluster
	/// boundaries.
	pub fn set_selection(&mut self, selection: Selection) {
		let anchor = snap_to_grapheme(&self.text, selection.anchor);
		let head = snap_to_grapheme(&self.text, selection.head);
		self.selection = Selection::new(anchor, head);
	}

	/// Returns the text slice spanned by the current selection.
	#[must_use]
	pub fn selected_text(&self) -> &str {
		let range = self.selection.range();
		&self.text[range]
	}

	/// Returns true if buffer contains no text characters.
	#[must_use]
	pub fn is_empty(&self) -> bool {
		self.text.is_empty()
	}

	/// Returns total byte length of buffer text.
	#[must_use]
	pub fn len(&self) -> usize {
		self.text.len()
	}

	/// Inserts text at the current selection, replacing any selected range.
	pub fn insert(&mut self, text: &str) {
		let range = self.selection.range();
		self.undo.push(self.text.clone(), self.selection);

		self.text.replace_range(range.clone(), text);
		let new_offset = range.start + text.len();
		self.selection = Selection::collapsed(new_offset);
	}

	/// Replaces text within the specified byte range with new text.
	pub fn replace_range(&mut self, range: Range<usize>, text: &str) {
		let start = snap_to_grapheme(&self.text, range.start);
		let end = snap_to_grapheme(&self.text, range.end).max(start);
		self.undo.push(self.text.clone(), self.selection);

		self.text.replace_range(start..end, text);
		let new_offset = start + text.len();
		self.selection = Selection::collapsed(new_offset);
	}

	/// Deletes preceding grapheme cluster or active selection.
	pub fn delete_backward(&mut self) -> bool {
		if !self.selection.is_collapsed() {
			let range = self.selection.range();
			self.undo.push(self.text.clone(), self.selection);
			self.text.replace_range(range.clone(), "");
			self.selection = Selection::collapsed(range.start);
			return true;
		}

		let head = self.selection.head;
		if head == 0 || self.text.is_empty() {
			return false;
		}

		let prev = prev_grapheme_offset(&self.text, head);
		self.undo.push(self.text.clone(), self.selection);
		self.text.replace_range(prev..head, "");
		self.selection = Selection::collapsed(prev);
		true
	}

	/// Deletes succeeding grapheme cluster or active selection.
	pub fn delete_forward(&mut self) -> bool {
		if !self.selection.is_collapsed() {
			let range = self.selection.range();
			self.undo.push(self.text.clone(), self.selection);
			self.text.replace_range(range.clone(), "");
			self.selection = Selection::collapsed(range.start);
			return true;
		}

		let head = self.selection.head;
		if head >= self.text.len() || self.text.is_empty() {
			return false;
		}

		let next = next_grapheme_offset(&self.text, head);
		self.undo.push(self.text.clone(), self.selection);
		self.text.replace_range(head..next, "");
		self.selection = Selection::collapsed(head);
		true
	}

	/// Deletes backward to previous word boundary or active selection.
	pub fn delete_word_backward(&mut self) -> bool {
		if !self.selection.is_collapsed() {
			return self.delete_backward();
		}

		let head = self.selection.head;
		if head == 0 || self.text.is_empty() {
			return false;
		}

		let prev = prev_word_offset(&self.text, head);
		self.undo.push(self.text.clone(), self.selection);
		self.text.replace_range(prev..head, "");
		self.selection = Selection::collapsed(prev);
		true
	}

	/// Deletes forward to next word boundary or active selection.
	pub fn delete_word_forward(&mut self) -> bool {
		if !self.selection.is_collapsed() {
			return self.delete_forward();
		}

		let head = self.selection.head;
		if head >= self.text.len() || self.text.is_empty() {
			return false;
		}

		let next = next_word_offset(&self.text, head);
		self.undo.push(self.text.clone(), self.selection);
		self.text.replace_range(head..next, "");
		self.selection = Selection::collapsed(head);
		true
	}

	/// Deletes text from start of current line to cursor position.
	pub fn delete_to_line_start(&mut self) -> bool {
		if !self.selection.is_collapsed() {
			return self.delete_backward();
		}

		let head = self.selection.head;
		if head == 0 || self.text.is_empty() {
			return false;
		}

		let line_start = line_start_offset(&self.text, head);
		if line_start == head {
			return self.delete_backward();
		}

		self.undo.push(self.text.clone(), self.selection);
		self.text.replace_range(line_start..head, "");
		self.selection = Selection::collapsed(line_start);
		true
	}

	/// Deletes text from cursor position to end of current line.
	pub fn delete_to_line_end(&mut self) -> bool {
		if !self.selection.is_collapsed() {
			return self.delete_forward();
		}

		let head = self.selection.head;
		if head >= self.text.len() || self.text.is_empty() {
			return false;
		}

		let line_end = line_end_offset(&self.text, head);
		let target_end = if line_end == head {
			next_grapheme_offset(&self.text, head)
		} else {
			line_end
		};

		self.undo.push(self.text.clone(), self.selection);
		self.text.replace_range(head..target_end, "");
		self.selection = Selection::collapsed(head);
		true
	}

	/// Moves cursor left by one grapheme cluster, optionally extending
	/// selection.
	pub fn move_left(&mut self, select: bool) {
		if !select && !self.selection.is_collapsed() {
			self.selection = Selection::collapsed(self.selection.min());
			return;
		}

		let new_head = prev_grapheme_offset(&self.text, self.selection.head);
		self.selection = if select {
			Selection::new(self.selection.anchor, new_head)
		} else {
			Selection::collapsed(new_head)
		};
	}

	/// Moves cursor right by one grapheme cluster, optionally extending
	/// selection.
	pub fn move_right(&mut self, select: bool) {
		if !select && !self.selection.is_collapsed() {
			self.selection = Selection::collapsed(self.selection.max());
			return;
		}

		let new_head = next_grapheme_offset(&self.text, self.selection.head);
		self.selection = if select {
			Selection::new(self.selection.anchor, new_head)
		} else {
			Selection::collapsed(new_head)
		};
	}

	/// Moves cursor backward to previous word boundary, optionally extending
	/// selection.
	pub fn move_word_left(&mut self, select: bool) {
		let new_head = prev_word_offset(&self.text, self.selection.head);
		self.selection = if select {
			Selection::new(self.selection.anchor, new_head)
		} else {
			Selection::collapsed(new_head)
		};
	}

	/// Moves cursor forward to next word boundary, optionally extending
	/// selection.
	pub fn move_word_right(&mut self, select: bool) {
		let new_head = next_word_offset(&self.text, self.selection.head);
		self.selection = if select {
			Selection::new(self.selection.anchor, new_head)
		} else {
			Selection::collapsed(new_head)
		};
	}

	/// Moves cursor to start of current line, optionally extending selection.
	pub fn move_line_start(&mut self, select: bool) {
		let new_head = line_start_offset(&self.text, self.selection.head);
		self.selection = if select {
			Selection::new(self.selection.anchor, new_head)
		} else {
			Selection::collapsed(new_head)
		};
	}

	/// Moves cursor to end of current line, optionally extending selection.
	pub fn move_line_end(&mut self, select: bool) {
		let new_head = line_end_offset(&self.text, self.selection.head);
		self.selection = if select {
			Selection::new(self.selection.anchor, new_head)
		} else {
			Selection::collapsed(new_head)
		};
	}

	/// Moves cursor to start of entire document, optionally extending selection.
	pub fn move_doc_start(&mut self, select: bool) {
		self.selection = if select {
			Selection::new(self.selection.anchor, 0)
		} else {
			Selection::collapsed(0)
		};
	}

	/// Moves cursor to end of entire document, optionally extending selection.
	pub fn move_doc_end(&mut self, select: bool) {
		let end = self.text.len();
		self.selection = if select {
			Selection::new(self.selection.anchor, end)
		} else {
			Selection::collapsed(end)
		};
	}

	/// Moves cursor to specified byte offset, optionally extending selection.
	pub fn move_to(&mut self, offset: usize, select: bool) {
		let snapped = snap_to_grapheme(&self.text, offset);
		self.selection = if select {
			Selection::new(self.selection.anchor, snapped)
		} else {
			Selection::collapsed(snapped)
		};
	}

	/// Selects all text in the buffer.
	pub fn select_all(&mut self) {
		self.selection = Selection::new(0, self.text.len());
	}

	/// Selects word at specified byte offset.
	pub fn select_word_at(&mut self, offset: usize) {
		let range = word_range_at(&self.text, offset);
		self.selection = Selection::new(range.start, range.end);
	}

	/// Returns (0-indexed line, 0-indexed column) for byte offset.
	#[must_use]
	pub fn line_col(&self, offset: usize) -> (usize, usize) {
		line_col_for_offset(&self.text, offset)
	}

	/// Returns byte offset for (0-indexed line, 0-indexed column).
	#[must_use]
	pub fn offset_of(&self, line: usize, col: usize) -> usize {
		offset_for_line_col(&self.text, line, col)
	}

	/// Reverts buffer to previous state from undo history.
	pub fn undo(&mut self) -> bool {
		if let Some(entry) = self.undo.undo(&self.text, self.selection) {
			self.text = entry.text;
			self.selection = entry.selection;
			true
		} else {
			false
		}
	}

	/// Re-applies undone state from redo history.
	pub fn redo(&mut self) -> bool {
		if let Some(entry) = self.undo.redo(&self.text, self.selection) {
			self.text = entry.text;
			self.selection = entry.selection;
			true
		} else {
			false
		}
	}

	/// Replaces entire buffer text and positions cursor at the end.
	pub fn set_text(&mut self, text: impl Into<String>) {
		self.undo.push(self.text.clone(), self.selection);
		self.text = text.into();
		self.selection = Selection::collapsed(self.text.len());
	}

	/// Clears all text from buffer, returning previous content.
	pub fn clear(&mut self) -> String {
		self.undo.push(self.text.clone(), self.selection);
		let previous = std::mem::take(&mut self.text);
		self.selection = Selection::collapsed(0);
		previous
	}
}
