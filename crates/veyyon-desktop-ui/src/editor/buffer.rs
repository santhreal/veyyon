//! A UTF-8 text buffer with a grapheme-aligned selection and an undo history.
//!
//! The buffer has no notion of wrapping or of pixels. Line motion here is by
//! logical line (text between line breaks); the editor view moves by visual
//! row when it has a layout.

use std::ops::Range;

use super::{
	history::{EditKind, History, Step},
	motion::{
		ceil_char, floor_char, line_column, line_end, line_start, next_grapheme, next_word,
		offset_for_line_column, prev_grapheme, prev_word, snap_to_grapheme, word_range_at,
	},
};

/// A selection as an anchor and a head. The head is the caret.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Selection {
	/// The end that stays put while the selection is extended.
	pub anchor: usize,
	/// The end that moves: the caret.
	pub head:   usize,
}

impl Selection {
	/// A collapsed selection at `offset`.
	pub const fn caret(offset: usize) -> Self {
		Self { anchor: offset, head: offset }
	}

	/// The selected byte range, start before end.
	pub fn range(self) -> Range<usize> {
		self.anchor.min(self.head)..self.anchor.max(self.head)
	}

	/// True when nothing is selected.
	pub const fn is_empty(self) -> bool {
		self.anchor == self.head
	}

	/// True when the head is before the anchor.
	pub const fn is_reversed(self) -> bool {
		self.head < self.anchor
	}
}

/// A caret motion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Motion {
	/// One grapheme back.
	Left,
	/// One grapheme forward.
	Right,
	/// To the start of the previous word.
	WordLeft,
	/// To the end of the next word.
	WordRight,
	/// To the start of the line.
	LineStart,
	/// To the end of the line.
	LineEnd,
	/// One logical line up, keeping the column.
	Up,
	/// One logical line down, keeping the column.
	Down,
	/// To the start of the text.
	DocStart,
	/// To the end of the text.
	DocEnd,
}

/// How much a delete removes when the selection is empty.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unit {
	/// One grapheme.
	Grapheme,
	/// To the word boundary.
	Word,
	/// To the line boundary, or the line break when already on it.
	Line,
}

/// Text, selection and undo history.
#[derive(Clone, Debug, Default)]
pub struct TextBuffer {
	text:      String,
	selection: Selection,
	history:   History,
	revision:  u64,
	/// The grapheme column logical up and down motion returns to.
	goal:      Option<usize>,
}

impl TextBuffer {
	/// An empty buffer.
	pub fn new() -> Self {
		Self::default()
	}

	/// A buffer holding `text`, the caret at its end and no history.
	pub fn with_text(text: impl Into<String>) -> Self {
		let text = text.into();
		let selection = Selection::caret(text.len());
		Self { text, selection, ..Self::default() }
	}

	/// The text.
	pub fn text(&self) -> &str {
		&self.text
	}

	/// The length in bytes.
	pub const fn len(&self) -> usize {
		self.text.len()
	}

	/// True when the text is empty.
	pub const fn is_empty(&self) -> bool {
		self.text.is_empty()
	}

	/// A counter that changes whenever the text changes.
	pub const fn revision(&self) -> u64 {
		self.revision
	}

	/// The selection.
	pub const fn selection(&self) -> Selection {
		self.selection
	}

	/// The caret offset: the selection head.
	pub const fn cursor(&self) -> usize {
		self.selection.head
	}

	/// The selected text.
	pub fn selected_text(&self) -> &str {
		&self.text[self.selection.range()]
	}

	/// Selects from `anchor` to `head`, both floored to grapheme boundaries.
	/// Closes the open undo step.
	pub fn set_selection(&mut self, anchor: usize, head: usize) {
		let anchor = snap_to_grapheme(&self.text, anchor);
		let head = snap_to_grapheme(&self.text, head);
		self.select_within_edit(anchor, head);
		self.history.close();
	}

	/// Selects from `anchor` to `head`, floored to char boundaries, without
	/// closing the open undo step, for an input method that moves its caret
	/// inside the text it is composing.
	pub fn select_within_edit(&mut self, anchor: usize, head: usize) {
		let anchor = floor_char(&self.text, anchor);
		let head = floor_char(&self.text, head);
		self.selection = Selection { anchor, head };
		self.goal = None;
	}

	/// Moves the caret to `offset`; `extend` keeps the anchor.
	pub fn move_to(&mut self, offset: usize, extend: bool) {
		let head = snap_to_grapheme(&self.text, offset);
		let anchor = if extend { self.selection.anchor } else { head };
		self.set_selection(anchor, head);
	}

	/// Applies `motion` to the caret; `extend` keeps the anchor. A plain left
	/// or right motion over a selection collapses it to that side.
	pub fn move_caret(&mut self, motion: Motion, extend: bool) {
		let text = self.text.as_str();
		let selection = self.selection;
		let head = selection.head;
		let collapse = !extend && !selection.is_empty();
		let target = match motion {
			Motion::Left if collapse => selection.range().start,
			Motion::Right if collapse => selection.range().end,
			Motion::Left => prev_grapheme(text, head),
			Motion::Right => next_grapheme(text, head),
			Motion::WordLeft => prev_word(text, head),
			Motion::WordRight => next_word(text, head),
			Motion::LineStart => line_start(text, head),
			Motion::LineEnd => line_end(text, head),
			Motion::DocStart => 0,
			Motion::DocEnd => text.len(),
			Motion::Up | Motion::Down => {
				let (line, column) = line_column(text, head);
				let goal = self.goal.unwrap_or(column);
				let target = match (motion, line) {
					(Motion::Up, 0) => 0,
					(Motion::Up, _) => offset_for_line_column(text, line - 1, goal),
					_ => offset_for_line_column(text, line + 1, goal),
				};
				self.move_to(target, extend);
				self.goal = Some(goal);
				return;
			},
		};
		self.move_to(target, extend);
	}

	/// Selects the whole text.
	pub fn select_all(&mut self) {
		self.set_selection(0, self.text.len());
	}

	/// Selects the word, whitespace run or punctuation run at `offset`.
	pub fn select_word_at(&mut self, offset: usize) {
		let range = word_range_at(&self.text, offset);
		self.set_selection(range.start, range.end);
	}

	/// Selects the logical line at `offset`, without its line break.
	pub fn select_line_at(&mut self, offset: usize) {
		let start = line_start(&self.text, offset);
		self.set_selection(start, line_end(&self.text, offset));
	}

	/// Types `text` over the selection.
	pub fn insert(&mut self, text: &str) {
		self.edit(self.selection.range(), text, EditKind::Typing);
	}

	/// Replaces the whole text with `text`, as one undo step, the caret at its
	/// end.
	pub fn set_text(&mut self, text: &str) {
		self.edit(0..self.text.len(), text, EditKind::Replace);
	}

	/// Replaces `range` with `text` as its own undo step and returns the range
	/// the new text occupies. The caret lands after it.
	pub fn replace_range(&mut self, range: Range<usize>, text: &str) -> Range<usize> {
		self.edit(range, text, EditKind::Replace)
	}

	/// Replaces `range` (widened to char boundaries and clamped to the text)
	/// with `text`, grouping the undo step by `kind`. Returns the range the new
	/// text occupies; the caret lands at its end.
	pub fn edit(&mut self, range: Range<usize>, text: &str, kind: EditKind) -> Range<usize> {
		let start = floor_char(&self.text, range.start.min(range.end));
		let end = ceil_char(&self.text, range.end.max(range.start));
		if start == end && text.is_empty() {
			return start..start;
		}
		let before = self.selection;
		let deleted = self.text[start..end].to_owned();
		self.text.replace_range(start..end, text);
		let inserted = start..start + text.len();
		self.selection = Selection::caret(inserted.end);
		self.goal = None;
		self.revision += 1;
		self.history.record(Step {
			start,
			deleted,
			inserted: text.to_owned(),
			before,
			after: self.selection,
			kind,
		});
		inserted
	}

	/// Deletes the selection, or `unit` before the caret. Returns false when
	/// there was nothing to delete.
	pub fn delete_backward(&mut self, unit: Unit) -> bool {
		if !self.selection.is_empty() {
			self.edit(self.selection.range(), "", EditKind::Replace);
			return true;
		}
		let head = self.selection.head;
		let text = self.text.as_str();
		let start = match unit {
			Unit::Grapheme => prev_grapheme(text, head),
			Unit::Word => prev_word(text, head),
			Unit::Line if line_start(text, head) == head => prev_grapheme(text, head),
			Unit::Line => line_start(text, head),
		};
		if start == head {
			return false;
		}
		self.edit(start..head, "", EditKind::DeleteBackward);
		true
	}

	/// Deletes the selection, or `unit` after the caret. Returns false when
	/// there was nothing to delete.
	pub fn delete_forward(&mut self, unit: Unit) -> bool {
		if !self.selection.is_empty() {
			self.edit(self.selection.range(), "", EditKind::Replace);
			return true;
		}
		let head = self.selection.head;
		let text = self.text.as_str();
		let end = match unit {
			Unit::Grapheme => next_grapheme(text, head),
			Unit::Word => next_word(text, head),
			Unit::Line if line_end(text, head) == head => next_grapheme(text, head),
			Unit::Line => line_end(text, head),
		};
		if end == head {
			return false;
		}
		self.edit(head..end, "", EditKind::DeleteForward);
		true
	}

	/// Reverts the last undo step. Returns false when there is none.
	pub fn undo(&mut self) -> bool {
		let Some(step) = self.history.take_undo() else {
			return false;
		};
		let end = step.start + step.inserted.len();
		self.text.replace_range(step.start..end, &step.deleted);
		self.selection = step.before;
		self.after_history();
		self.history.push_redo(step);
		true
	}

	/// Reapplies the last undone step. Returns false when there is none.
	pub fn redo(&mut self) -> bool {
		let Some(step) = self.history.take_redo() else {
			return false;
		};
		let end = step.start + step.deleted.len();
		self.text.replace_range(step.start..end, &step.inserted);
		self.selection = step.after;
		self.after_history();
		self.history.push_undo(step);
		true
	}

	/// The zero-based logical line and grapheme column of `offset`.
	pub fn line_column(&self, offset: usize) -> (usize, usize) {
		line_column(&self.text, offset)
	}

	/// The offset of grapheme `column` on logical line `line`, clamped.
	pub fn offset_for_line_column(&self, line: usize, column: usize) -> usize {
		offset_for_line_column(&self.text, line, column)
	}

	/// The number of logical lines; an empty text has one.
	pub fn line_count(&self) -> usize {
		self.text.matches('\n').count() + 1
	}

	const fn after_history(&mut self) {
		self.goal = None;
		self.revision += 1;
	}
}
