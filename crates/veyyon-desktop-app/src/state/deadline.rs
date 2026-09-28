//! Deadlines: a request the host leaves unanswered fails at its deadline the
//! way a refusal does, so the control that sent it stops waiting and offers
//! its retry.
//!
//! One timer runs while a request is in flight, pointed at the registry's
//! next expiry; with nothing in flight no timer runs.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use veyyon_desktop_model::{BackendError, ErrorScope, HostEvent, InFlightRequest, RequestId};
use veyyon_gpui::{App, Context, Task};

use super::AppState;

/// How long a request may stay in flight before it fails as unanswered.
pub const REQUEST_TIMEOUT_MS: u64 = 30_000;

/// The error code of a request that outlived its deadline.
pub const UNANSWERED: &str = "unanswered";

/// The error code of a request dropped because too many were in flight.
pub const EVICTED: &str = "evicted";

/// The timer that fails the next request to outlive its deadline.
pub(super) struct Deadline {
	/// The registry millisecond the timer fires at.
	at_ms:  u64,
	_timer: Task<()>,
}

/// Milliseconds on the executor's clock since `epoch`, which the first
/// reading sets. The executor's clock is the one a test advances.
pub(super) fn clock_ms(epoch: &mut Option<Instant>, cx: &App) -> u64 {
	let now = cx.background_executor().now();
	let epoch = *epoch.get_or_insert(now);
	u64::try_from(now.saturating_duration_since(epoch).as_millis()).unwrap_or(u64::MAX)
}

impl AppState {
	/// Fails each request the registry pruned at `now_ms`: one past its
	/// deadline as unanswered, one inside it as evicted.
	pub(super) fn fail_pruned(
		&mut self,
		pruned: Vec<(RequestId, InFlightRequest)>,
		now_ms: u64,
		cx: &mut Context<Self>,
	) {
		if pruned.is_empty() {
			return;
		}
		let occurred_at_ms = wall_ms();
		let events = pruned
			.into_iter()
			.map(|(request, held)| {
				let overdue = now_ms.saturating_sub(held.issued_at_ms) > held.timeout_ms;
				let (code, message) = if overdue {
					(UNANSWERED, format!("The host did not answer within {} s.", held.timeout_ms / 1000))
				} else {
					(EVICTED, "Too many requests were in flight; this one was dropped.".to_owned())
				};
				HostEvent::RequestFailed {
					request,
					error: BackendError {
						scope: ErrorScope::Connection,
						code: Some(code.to_owned()),
						message,
						retryable: true,
						request: Some(request),
						occurred_at_ms,
					},
				}
			})
			.collect();
		self.apply(events, cx);
	}

	/// Points the deadline timer at the registry's next expiry, and drops it
	/// while nothing is in flight.
	pub(super) fn arm_deadline(&mut self, cx: &Context<Self>) {
		let next = self.registry.next_expiry_ms();
		if self.deadline.as_ref().map(|armed| armed.at_ms) == next {
			return;
		}
		self.deadline = next.map(|at_ms| {
			let wait = Duration::from_millis(at_ms.saturating_sub(clock_ms(&mut self.clock_epoch, cx)));
			let timer = cx.spawn(async move |this, cx| {
				cx.background_executor().timer(wait).await;
				this.update(cx, |state, cx| state.expire(cx)).ok();
			});
			Deadline { at_ms, _timer: timer }
		});
	}

	/// Fails every request past its deadline and re-arms for the next.
	fn expire(&mut self, cx: &mut Context<Self>) {
		self.deadline = None;
		let now_ms = clock_ms(&mut self.clock_epoch, cx);
		let pruned = self.registry.prune_stale(now_ms);
		self.fail_pruned(pruned, now_ms, cx);
		self.arm_deadline(cx);
	}
}

/// The wall clock in milliseconds since the Unix epoch, the clock the host
/// stamps its errors and announcements with.
pub(super) fn wall_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}
