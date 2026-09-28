//! The flat display order of a transcript tree and the splice arithmetic a
//! batch reports against it.

use std::{collections::HashMap, ops::Range};

use veyyon_desktop_model::{EntryId, TranscriptTree};

/// The entries of a transcript's active branch, oldest first, with each
/// entry's index.
///
/// A tree with an active leaf is read back along its parent chain; a tree
/// without one is read along its roots, which is the shape of a transcript
/// that never branched.
#[derive(Debug, Default)]
pub struct DisplayOrder {
	ids:       Vec<EntryId>,
	positions: HashMap<EntryId, usize>,
}

impl DisplayOrder {
	/// Reads the active branch of `tree` from scratch.
	pub fn rebuild(tree: &TranscriptTree) -> Self {
		let mut order = Self::default();
		if tree.active_leaf.is_some() {
			order.follow_leaf(tree);
		} else {
			for id in tree.root_entries.iter().filter(|id| tree.get(id).is_some()) {
				order.push(id.clone());
			}
		}
		order
	}

	/// Brings the order to the active leaf of `tree` and returns the index
	/// range of the previous order it replaced; the new items start at the
	/// range's start and run to the end of the order.
	///
	/// The walk goes up from the leaf to the first entry already in the
	/// order, so an append costs the entries it adds and a branch costs the
	/// entries it cuts. A tree whose leaf chain meets no known entry replaces
	/// the whole order. Returns `None` when nothing moved.
	pub fn follow_leaf(&mut self, tree: &TranscriptTree) -> Option<Range<usize>> {
		let leaf = tree.active_leaf.as_ref()?;
		let mut fresh = Vec::new();
		let mut anchor = None;
		let mut cursor = Some(leaf);
		while let Some(id) = cursor {
			if let Some(&ix) = self.positions.get(id) {
				anchor = Some(ix);
				break;
			}
			let Some(entry) = tree.get(id) else {
				break;
			};
			fresh.push(id.clone());
			// A chain visits each entry once, so a parent link that closes a
			// loop ends the walk.
			if fresh.len() >= tree.len() {
				break;
			}
			cursor = entry.parent.as_ref();
		}
		let start = anchor.map_or(0, |ix| ix + 1);
		let range = start..self.ids.len();
		if range.is_empty() && fresh.is_empty() {
			return None;
		}
		for id in self.ids.drain(start..) {
			self.positions.remove(&id);
		}
		for id in fresh.into_iter().rev() {
			self.push(id);
		}
		Some(range)
	}

	fn push(&mut self, id: EntryId) {
		self.positions.insert(id.clone(), self.ids.len());
		self.ids.push(id);
	}

	/// The entries in display order.
	pub fn ids(&self) -> &[EntryId] {
		&self.ids
	}

	/// The number of entries in the order.
	pub const fn len(&self) -> usize {
		self.ids.len()
	}

	/// The entry at display index `ix`.
	pub fn get(&self, ix: usize) -> Option<&EntryId> {
		self.ids.get(ix)
	}

	/// The display index of `id`, or `None` for an entry off the active
	/// branch.
	pub fn position(&self, id: &EntryId) -> Option<usize> {
		self.positions.get(id).copied()
	}
}

/// The union of the splices one batch made to one display order, reported
/// as a single splice against the order the batch started from.
///
/// The window holds the unchanged prefix (`start`) and the unchanged suffix
/// (`tail`), which every later splice can only shrink.
#[derive(Debug, Clone, Copy)]
pub struct SpliceWindow {
	start:   usize,
	tail:    usize,
	old_len: usize,
}

impl SpliceWindow {
	/// Opens a window at the batch's first splice of `range` in an order of
	/// `len_before` items.
	pub const fn new(range: &Range<usize>, len_before: usize) -> Self {
		Self { start: range.start, tail: len_before.saturating_sub(range.end), old_len: len_before }
	}

	/// Widens the window by a later splice of `range` in an order of
	/// `len_before` items.
	pub fn record(&mut self, range: &Range<usize>, len_before: usize) {
		self.start = self.start.min(range.start);
		self.tail = self.tail.min(len_before.saturating_sub(range.end));
	}

	/// The splice from the starting order to an order of `len` items: the
	/// replaced range and the number of items now in its place.
	pub const fn finish(&self, len: usize) -> (Range<usize>, usize) {
		let end = self.old_len.saturating_sub(self.tail);
		(self.start..end, len.saturating_sub(self.tail).saturating_sub(self.start))
	}
}
