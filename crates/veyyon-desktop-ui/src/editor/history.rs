//! Undo and redo steps, and how consecutive edits merge into one step.

use std::collections::VecDeque;

use super::buffer::Selection;

/// Undo steps kept; the oldest step is dropped past this count.
pub const UNDO_LIMIT: usize = 500;

/// How an edit groups into undo steps. Consecutive edits of one kind that
/// continue each other merge into one step; [`EditKind::Replace`] never
/// merges.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditKind {
	/// Typed text, appended at the caret.
	Typing,
	/// Backspace.
	DeleteBackward,
	/// Forward delete.
	DeleteForward,
	/// An input method composition, which replaces its own marked text.
	Composition,
	/// Any other replacement: paste, cut, line break, programmatic text.
	Replace,
}

/// One undo step: `deleted` at `start` was replaced by `inserted`.
#[derive(Clone, Debug)]
pub struct Step {
	pub start:    usize,
	pub deleted:  String,
	pub inserted: String,
	pub before:   Selection,
	pub after:    Selection,
	pub kind:     EditKind,
}

impl Step {
	/// Folds `next` into this step when it continues it.
	fn merge(&mut self, next: &Self) -> bool {
		let deletes = self.inserted.is_empty() && next.inserted.is_empty();
		let continues = match next.kind {
			EditKind::Typing => {
				next.deleted.is_empty() && next.start == self.start + self.inserted.len()
			},
			EditKind::DeleteBackward => {
				let next_end = next.start + next.deleted.len();
				deletes && next_end == self.start
			},
			EditKind::DeleteForward => deletes && next.start == self.start,
			EditKind::Composition => {
				let replaces_marked = next.deleted == self.inserted;
				next.start == self.start && replaces_marked
			},
			EditKind::Replace => false,
		};
		if !continues {
			return false;
		}
		match next.kind {
			EditKind::Typing => self.inserted.push_str(&next.inserted),
			EditKind::DeleteBackward => {
				self.start = next.start;
				self.deleted.insert_str(0, &next.deleted);
			},
			EditKind::DeleteForward => self.deleted.push_str(&next.deleted),
			EditKind::Composition => self.inserted.clone_from(&next.inserted),
			EditKind::Replace => {},
		}
		self.after = next.after;
		true
	}
}

/// The undo and redo stacks.
#[derive(Clone, Debug, Default)]
pub struct History {
	undo: VecDeque<Step>,
	redo: Vec<Step>,
	/// The last undo step accepts a continuing edit of its kind.
	open: bool,
}

impl History {
	/// Records a new edit: clears redo, then merges `step` into the open step
	/// or pushes it.
	pub fn record(&mut self, step: Step) {
		self.redo.clear();
		if self.open
			&& let Some(last) = self.undo.back_mut()
			&& last.kind == step.kind
			&& last.merge(&step)
		{
			return;
		}
		self.open = step.kind != EditKind::Replace;
		self.push_undo(step);
	}

	/// Stops the last step from merging with the next edit.
	pub const fn close(&mut self) {
		self.open = false;
	}

	/// Removes the step to undo.
	pub fn take_undo(&mut self) -> Option<Step> {
		self.open = false;
		self.undo.pop_back()
	}

	/// Removes the step to redo.
	pub fn take_redo(&mut self) -> Option<Step> {
		self.open = false;
		self.redo.pop()
	}

	/// Keeps an undone step for redo.
	pub fn push_redo(&mut self, step: Step) {
		self.redo.push(step);
	}

	/// Pushes a step, dropping the oldest past [`UNDO_LIMIT`].
	pub fn push_undo(&mut self, step: Step) {
		if self.undo.len() == UNDO_LIMIT {
			self.undo.pop_front();
		}
		self.undo.push_back(step);
	}
}
