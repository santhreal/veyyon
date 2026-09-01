use std::collections::BTreeMap;

use crate::{action::HostActionKind, connection::RequestId, surface::SurfaceId};

/// Represents an active in-flight request waiting for host acknowledgment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InFlightRequest {
	pub action:       HostActionKind,
	pub surface:      SurfaceId,
	pub issued_at_ms: u64,
	pub timeout_ms:   u64,
}

/// Tracks in-flight asynchronous operations, mapping request identifiers to
/// initiating surfaces.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequestRegistry {
	pending: BTreeMap<RequestId, InFlightRequest>,
}

impl RequestRegistry {
	/// Creates an empty request registry.
	#[must_use]
	pub const fn new() -> Self {
		Self { pending: BTreeMap::new() }
	}

	/// Registers a new in-flight request with timestamp and timeout.
	pub fn register(
		&mut self,
		id: RequestId,
		action: HostActionKind,
		surface: SurfaceId,
		now_ms: u64,
		timeout_ms: u64,
	) {
		self.pending.insert(id, InFlightRequest {
			action,
			surface,
			issued_at_ms: now_ms,
			timeout_ms,
		});
		self.prune_stale(now_ms);
	}

	/// Finds the first pending request identifier associated with a given action
	/// kind.
	#[must_use]
	pub fn find_pending_for_action(&self, action: HostActionKind) -> Option<RequestId> {
		self
			.pending
			.iter()
			.find(|(_, req)| req.action == action)
			.map(|(id, _)| *id)
	}

	/// Removes and returns the in-flight request on completion.
	pub fn complete(&mut self, id: &RequestId) -> Option<InFlightRequest> {
		self.pending.remove(id)
	}

	/// Retrieves a reference to an in-flight request by identifier.
	#[must_use]
	pub fn get(&self, id: &RequestId) -> Option<&InFlightRequest> {
		self.pending.get(id)
	}

	/// Returns the number of currently tracked in-flight requests.
	#[must_use]
	pub fn len(&self) -> usize {
		self.pending.len()
	}

	/// Returns true if no in-flight requests are tracked.
	#[must_use]
	pub fn is_empty(&self) -> bool {
		self.pending.is_empty()
	}

	/// Prunes stale requests exceeding their timeout and enforces the 1024
	/// capacity ceiling.
	pub fn prune_stale(&mut self, now_ms: u64) -> Vec<(RequestId, InFlightRequest)> {
		let mut timed_out = Vec::new();
		self.pending.retain(|id, req| {
			if now_ms.saturating_sub(req.issued_at_ms) > req.timeout_ms {
				timed_out.push((*id, req.clone()));
				false
			} else {
				true
			}
		});

		// Capacity cap: maximum 1024 concurrent requests.
		while self.pending.len() > 1024 {
			if let Some((oldest_id, removed)) = self.pending.pop_first() {
				timed_out.push((oldest_id, removed));
			}
		}

		timed_out
	}
}
