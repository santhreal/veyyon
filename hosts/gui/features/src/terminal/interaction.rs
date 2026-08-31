//! Terminal selection-menu request invalidation.
//!
//! Native selection menus may resolve asynchronously. A newer selection,
//! focus loss, Escape, pointer cancellation, or a presentation move invalidates
//! the old request so its delayed result cannot act or steal focus.

/// Identity of one asynchronous selection-menu request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SelectionRequest(u64);

/// Allocation-free generation guard for selection-menu results.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct SelectionRequestGuard {
	generation: u64,
}

impl SelectionRequestGuard {
	pub fn issue(&mut self) -> SelectionRequest {
		self.generation = self.generation.wrapping_add(1).max(1);
		SelectionRequest(self.generation)
	}

	pub fn is_current(self, request: SelectionRequest) -> bool {
		request.0 != 0 && request.0 == self.generation
	}

	/// Invalidate the current menu without starting another one.
	pub fn cancel(&mut self) {
		self.generation = self.generation.wrapping_add(1).max(1);
	}
}
