//! What a control sends again when the host refuses it (§4.4).
//!
//! A `Retry` the window draws under a control means one thing: the request
//! that failed there, sent a second time. Nothing else knows what that
//! request was -- the in-flight registry keeps the action's kind, not the
//! prompt text, the session or the attachments it carried -- so the window
//! records each request it sends against the control it came from, the
//! reducer moves that record onto the control when the host answers with a
//! failure, and the control's retry takes it back out.
//!
//! A request the host accepts is forgotten at once: a control with no
//! recorded failure has nothing to send again, and its retry falls back to
//! the action the control would send at rest.

use std::collections::BTreeMap;

use crate::{action::HostAction, connection::RequestId, surface::SurfaceId};

/// Requests remembered while in flight, matching the in-flight registry's own
/// ceiling.
const SENT_CEILING: usize = 1024;
/// Controls remembered as failed. A control holds one error at a time and
/// clears it on retry or dismissal, so this bounds a window whose host
/// refuses everything rather than ordinary use.
const FAILED_CEILING: usize = 256;

/// The request each control would send again, and the requests still in
/// flight that could become one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RetryMemory {
	sent:   BTreeMap<RequestId, (SurfaceId, HostAction)>,
	failed: BTreeMap<SurfaceId, HostAction>,
}

impl RetryMemory {
	/// Creates an empty memory.
	#[must_use]
	pub const fn new() -> Self {
		Self { sent: BTreeMap::new(), failed: BTreeMap::new() }
	}

	/// Records the request a control just sent.
	pub fn record(&mut self, id: RequestId, surface: SurfaceId, action: HostAction) {
		self.sent.insert(id, (surface, action));
		while self.sent.len() > SENT_CEILING {
			self.sent.pop_first();
		}
	}

	/// Forgets a request the host answered with a success.
	pub fn forget(&mut self, id: RequestId) {
		self.sent.remove(&id);
	}

	/// Moves the request the host refused onto the control that sent it, and
	/// answers with that control. A request nothing recorded -- one the host
	/// failed twice, or one raised by the transport rather than by a control
	/// -- moves nothing and answers `None`.
	pub fn fail(&mut self, id: RequestId) -> Option<SurfaceId> {
		let (surface, action) = self.sent.remove(&id)?;
		self.failed.insert(surface.clone(), action);
		while self.failed.len() > FAILED_CEILING {
			self.failed.pop_first();
		}
		Some(surface)
	}

	/// Takes the request a control would send again, leaving it with none.
	pub fn take(&mut self, surface: &SurfaceId) -> Option<HostAction> {
		self.failed.remove(surface)
	}

	/// The request a control would send again, without taking it.
	#[must_use]
	pub fn peek(&self, surface: &SurfaceId) -> Option<&HostAction> {
		self.failed.get(surface)
	}
}
