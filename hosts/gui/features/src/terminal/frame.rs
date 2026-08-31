//! One pending presentation frame for bursty terminal and output arrival.
//!
//! This value does not run a clock. The first arrival requests a frame through
//! its caller; later arrivals before that frame only update retained buffers.

/// Result of registering newly arrived renderer data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameRequest {
	/// No frame was pending, so the caller requests the next window frame.
	Schedule,
	/// A frame is already pending; no additional request is made.
	Coalesced,
}

/// Edge-triggered, allocation-free frame request state.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct FrameCoalescer {
	pending: bool,
}

impl FrameCoalescer {
	/// Register terminal cells, output bytes, or a resize arriving from state.
	pub fn arrive(&mut self) -> FrameRequest {
		if self.pending {
			FrameRequest::Coalesced
		} else {
			self.pending = true;
			FrameRequest::Schedule
		}
	}

	/// Consume the pending edge at frame begin.
	///
	/// Arrival during or after this frame can request the following frame.
	pub fn begin_frame(&mut self) -> bool {
		std::mem::take(&mut self.pending)
	}

	/// Cancel a pending request when its viewport is no longer presented.
	pub fn cancel(&mut self) {
		self.pending = false;
	}

	pub fn is_pending(self) -> bool {
		self.pending
	}
}
