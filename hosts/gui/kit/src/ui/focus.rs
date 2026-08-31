//! Fixed focus containment and restoration for modal surfaces.
//!
//! The overlay registers focus handles in visual order at event setup. `enter`
//! moves focus to the first control, `cycle` handles Tab/Shift-Tab without
//! escaping the surface, and `leave` restores the trigger. The fixed sixteen
//! slots cover dialogs without allocating in key handling.

use gpui::{App, FocusHandle, Window};

pub const MAX_FOCUS_STOPS: usize = 16;

pub struct FocusScope {
	restore: FocusHandle,
	stops:   [Option<FocusHandle>; MAX_FOCUS_STOPS],
	len:     usize,
}

impl FocusScope {
	pub fn new(restore: FocusHandle) -> Self {
		Self { restore, stops: std::array::from_fn(|_| None), len: 0 }
	}

	pub fn push(&mut self, handle: FocusHandle) -> bool {
		if self.len == MAX_FOCUS_STOPS {
			return false;
		}
		self.stops[self.len] = Some(handle);
		self.len += 1;
		true
	}

	pub fn enter(&self, window: &mut Window, cx: &mut App) -> bool {
		let Some(first) = self.stops.first().and_then(Option::as_ref) else {
			return false;
		};
		window.focus(first, cx);
		true
	}

	pub fn cycle(&self, forward: bool, window: &mut Window, cx: &mut App) -> bool {
		if self.len == 0 {
			return false;
		}
		let current = self.stops[..self.len].iter().position(|slot| {
			slot
				.as_ref()
				.is_some_and(|handle| handle.is_focused(window))
		});
		let next = match (current, forward) {
			(Some(index), true) => (index + 1) % self.len,
			(Some(0), false) | (None, false) => self.len - 1,
			(Some(index), false) => index - 1,
			(None, true) => 0,
		};
		if let Some(handle) = self.stops[next].as_ref() {
			window.focus(handle, cx);
			return true;
		}
		false
	}

	pub fn leave(&self, window: &mut Window, cx: &mut App) {
		window.focus(&self.restore, cx);
	}

	pub const fn len(&self) -> usize {
		self.len
	}

	pub const fn is_empty(&self) -> bool {
		self.len == 0
	}
}
