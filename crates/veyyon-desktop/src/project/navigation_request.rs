//! A requested tab layout is committed only by its matching host
//! acknowledgement.

use veyyon_desktop_model::{RequestId, RequestRegistry, persistence::NavigationStore};

struct Pending {
	request:   RequestId,
	candidate: NavigationStore,
}

#[derive(Default)]
pub struct NavigationRequest {
	pending: Option<Pending>,
}

impl NavigationRequest {
	#[must_use]
	pub const fn is_pending(&self) -> bool {
		self.pending.is_some()
	}

	/// Rejects a second request instead of losing the first request's candidate.
	pub fn begin(&mut self, request: RequestId, candidate: NavigationStore) -> bool {
		if self.pending.is_some() {
			return false;
		}
		self.pending = Some(Pending { request, candidate });
		true
	}

	/// Failure leaves the committed layout unchanged; unrelated replies do
	/// nothing.
	pub fn finish(
		&mut self,
		request: RequestId,
		succeeded: bool,
		committed: &mut NavigationStore,
	) -> bool {
		if self
			.pending
			.as_ref()
			.is_none_or(|pending| pending.request != request)
		{
			return false;
		}
		if let Some(pending) = self.pending.take()
			&& succeeded
		{
			*committed = pending.candidate;
		}
		true
	}

	/// Uses the same deadline as the request registry, including removal by its
	/// capacity bound.
	pub fn expire(&mut self, registry: &mut RequestRegistry, now_ms: u64) -> bool {
		let Some(pending) = &self.pending else {
			return false;
		};
		let expired = registry
			.get(&pending.request)
			.is_none_or(|request| now_ms.saturating_sub(request.issued_at_ms) > request.timeout_ms);
		if expired {
			self.cancel(registry);
		}
		expired
	}

	pub fn cancel(&mut self, registry: &mut RequestRegistry) {
		if let Some(pending) = self.pending.take() {
			registry.complete(&pending.request);
		}
	}
}
