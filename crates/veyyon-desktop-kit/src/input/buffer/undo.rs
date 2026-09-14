//! Bounded undo and redo history stack for text buffer (§8.25).

use std::collections::VecDeque;

use super::selection::Selection;

/// Maximum number of undo states retained in history before evicting oldest.
pub const MAX_UNDO_STACK: usize = 256;

/// Snapshot of buffer content and selection for undo history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UndoEntry {
	/// Text snapshot.
	pub text:      String,
	/// Selection snapshot.
	pub selection: Selection,
}

/// Bounded undo/redo history manager.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UndoStack {
	undo_stack: VecDeque<UndoEntry>,
	redo_stack: VecDeque<UndoEntry>,
	max_depth:  usize,
}

impl Default for UndoStack {
	fn default() -> Self {
		Self::new()
	}
}

impl UndoStack {
	/// Creates a new empty undo stack with default bound.
	#[must_use]
	pub const fn new() -> Self {
		Self { undo_stack: VecDeque::new(), redo_stack: VecDeque::new(), max_depth: MAX_UNDO_STACK }
	}

	/// Records an edit snapshot, pushing to undo stack and clearing redo
	/// history.
	pub fn push(&mut self, text: String, selection: Selection) {
		if self.undo_stack.len() >= self.max_depth {
			self.undo_stack.pop_front();
		}
		self.undo_stack.push_back(UndoEntry { text, selection });
		self.redo_stack.clear();
	}

	/// Performs an undo operation, returning previous state and capturing
	/// current in redo stack.
	pub fn undo(&mut self, current_text: &str, current_sel: Selection) -> Option<UndoEntry> {
		let prev = self.undo_stack.pop_back()?;
		if self.redo_stack.len() >= self.max_depth {
			self.redo_stack.pop_front();
		}
		self
			.redo_stack
			.push_back(UndoEntry { text: current_text.to_string(), selection: current_sel });
		Some(prev)
	}

	/// Performs a redo operation, returning next state and capturing current in
	/// undo stack.
	pub fn redo(&mut self, current_text: &str, current_sel: Selection) -> Option<UndoEntry> {
		let next = self.redo_stack.pop_back()?;
		if self.undo_stack.len() >= self.max_depth {
			self.undo_stack.pop_front();
		}
		self
			.undo_stack
			.push_back(UndoEntry { text: current_text.to_string(), selection: current_sel });
		Some(next)
	}

	/// Clears all undo and redo history.
	pub fn clear(&mut self) {
		self.undo_stack.clear();
		self.redo_stack.clear();
	}

	/// Returns number of undo steps available.
	#[must_use]
	pub fn undo_len(&self) -> usize {
		self.undo_stack.len()
	}

	/// Returns number of redo steps available.
	#[must_use]
	pub fn redo_len(&self) -> usize {
		self.redo_stack.len()
	}
}
