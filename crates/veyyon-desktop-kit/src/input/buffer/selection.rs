//! Grapheme-aligned selection state for text buffer (§8.25).

use std::ops::Range;

/// Byte offset selection range with anchor and head indices.
///
/// When `anchor == head`, the selection is collapsed to a caret.
/// When `anchor != head`, the selection spans between anchor and head.
/// A reversed selection has `head < anchor`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Selection {
	/// Anchor byte offset where selection started.
	pub anchor: usize,
	/// Head byte offset representing active cursor position.
	pub head:   usize,
}

impl Selection {
	/// Creates a new selection between anchor and head byte offsets.
	#[must_use]
	pub const fn new(anchor: usize, head: usize) -> Self {
		Self { anchor, head }
	}

	/// Creates a collapsed selection at the given byte offset.
	#[must_use]
	pub const fn collapsed(offset: usize) -> Self {
		Self { anchor: offset, head: offset }
	}

	/// Returns true if selection is collapsed with no range.
	#[must_use]
	pub const fn is_collapsed(&self) -> bool {
		self.anchor == self.head
	}

	/// Returns true if selection head precedes anchor.
	#[must_use]
	pub const fn is_reversed(&self) -> bool {
		self.head < self.anchor
	}

	/// Returns the smaller byte offset of anchor and head.
	#[must_use]
	pub const fn min(&self) -> usize {
		if self.anchor <= self.head {
			self.anchor
		} else {
			self.head
		}
	}

	/// Returns the larger byte offset of anchor and head.
	#[must_use]
	pub const fn max(&self) -> usize {
		if self.anchor >= self.head {
			self.anchor
		} else {
			self.head
		}
	}

	/// Returns the normalized byte offset range.
	#[must_use]
	pub fn range(&self) -> Range<usize> {
		self.min()..self.max()
	}

	/// Returns the byte length of the selection.
	#[must_use]
	pub const fn len(&self) -> usize {
		self.max() - self.min()
	}

	/// Returns true if the selection covers zero bytes.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.is_collapsed()
	}
}
