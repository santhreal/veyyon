//! Keyboard actions and cursor stepping for the picker primitive.
//!
//! A picker owns the keyboard contract across every surface that lists things:
//! move, page, home/end, accept, accept-alternate, and dismiss. No surface
//! re-implements cursor arithmetic or motion dispatch.

/// A discrete keyboard or pointer navigation command on a picker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PickerAction {
	/// Move cursor up by one row.
	MoveUp,
	/// Move cursor down by one row.
	MoveDown,
	/// Move cursor up by a page of rows.
	PageUp,
	/// Move cursor down by a page of rows.
	PageDown,
	/// Jump to the first row.
	Home,
	/// Jump to the last row.
	End,
	/// Accept the row under the cursor.
	Accept,
	/// Accept the row under the cursor with the alternate action.
	AcceptAlternate,
	/// Dismiss the picker overlay.
	Dismiss,
}

impl PickerAction {
	/// Every action variant in canonical declaration order for runtime sweeps.
	pub const ALL: [Self; 9] = [
		Self::MoveUp,
		Self::MoveDown,
		Self::PageUp,
		Self::PageDown,
		Self::Home,
		Self::End,
		Self::Accept,
		Self::AcceptAlternate,
		Self::Dismiss,
	];
	/// The default number of rows a page step traverses.
	pub const PAGE_SIZE: usize = 8;

	/// Whether this action changes the cursor index.
	pub const fn is_cursor_motion(self) -> bool {
		matches!(
			self,
			Self::MoveUp | Self::MoveDown | Self::PageUp | Self::PageDown | Self::Home | Self::End
		)
	}

	/// Whether this action accepts the selection.
	pub const fn is_accept(self) -> bool {
		matches!(self, Self::Accept | Self::AcceptAlternate)
	}

	/// Whether this action dismisses the picker.
	pub const fn is_dismiss(self) -> bool {
		matches!(self, Self::Dismiss)
	}

	/// Computes the next cursor index given the current index and item count.
	///
	/// Returns `None` if the action is not a cursor motion, or `Some(new_index)`
	/// clamped to `0..total`. When `total == 0`, returns `Some(0)`.
	pub fn step(self, current: usize, total: usize, page_size: usize) -> Option<usize> {
		if !self.is_cursor_motion() {
			return None;
		}
		if total == 0 {
			return Some(0);
		}
		let step = page_size.max(1);
		let max_idx = total.saturating_sub(1);
		let next = match self {
			Self::MoveUp => current.saturating_sub(1),
			Self::MoveDown => (current + 1).min(max_idx),
			Self::PageUp => current.saturating_sub(step),
			Self::PageDown => (current + step).min(max_idx),
			Self::Home => 0,
			Self::End => max_idx,
			Self::Accept | Self::AcceptAlternate | Self::Dismiss => current,
		};
		Some(next)
	}
}
