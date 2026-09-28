//! A request the host leaves unanswered fails at its deadline the way a
//! refusal does: the control that sent it stops drawing it as in flight, its
//! retry sends it again, and one announcement states that the host did not
//! answer. A request the registry drops for capacity fails the same way.
//!
//! WHY: the registry pruned an overdue request only when another request was
//! registered, and dropped it without a word. A drawer refresh the host never
//! answered drew its spinner, and requested an animation frame every frame,
//! until some other control happened to send something. The suite drives
//! `AppState::dispatch` on the executor's clock, the one a test advances,
//! through the deadline, past an answer, and through the capacity ceiling.
//!
//! Gap: every action has the same deadline, so an action the host
//! legitimately takes longer than `REQUEST_TIMEOUT_MS` to answer fails early.

use std::{cell::RefCell, rc::Rc, time::Duration};

use veyyon_desktop_app::{
	AppState, StoreEvent,
	state::{EVICTED, REQUEST_TIMEOUT_MS, UNANSWERED},
};
use veyyon_desktop_model::{HostAction, HostActionKind, HostEvent, RequestId, Store, SurfaceId};
use veyyon_gpui::{AppContext as _, Entity, TestAppContext};

/// How many requests the registry holds in flight before it drops the
/// oldest.
const CAPACITY: usize = 1024;

/// The fields drop in declaration order, and the context checks for leaked
/// handles as it drops, so the entity goes before the context.
struct Window {
	state: Entity<AppState>,
	seen:  Rc<RefCell<Vec<StoreEvent>>>,
	cx:    TestAppContext,
}

impl Window {
	fn new() -> Self {
		let cx = TestAppContext::single();
		let state = cx.update(|app| app.new(|_| AppState::new(Store::new())));
		let seen: Rc<RefCell<Vec<StoreEvent>>> = Rc::default();
		cx.update(|app| {
			let seen = Rc::clone(&seen);
			app.subscribe(&state, move |_, event: &StoreEvent, _| seen.borrow_mut().push(event.clone()))
				.detach();
		});
		Self { state, seen, cx }
	}

	fn refresh(&self) -> RequestId {
		self.cx.update(|app| {
			self.state.update(app, |state, cx| {
				state.dispatch(HostAction::RefreshProcesses, SurfaceId::GlobalTitlebarLine, cx)
			})
		})
	}

	fn answer(&self, request: RequestId) {
		self.cx.update(|app| {
			self.state.update(app, |state, cx| {
				state.apply(vec![HostEvent::RequestSucceeded { request }], cx);
			});
		});
	}

	/// Moves the executor's clock `ms` forward and runs what came due.
	fn advance(&self, ms: u64) {
		self.cx.executor().advance_clock(Duration::from_millis(ms));
		self.cx.run_until_parked();
	}

	/// The requests finished since the last call, and whether each was taken.
	fn finished(&self) -> Vec<(RequestId, bool)> {
		self.seen
			.take()
			.into_iter()
			.filter_map(|event| match event {
				StoreEvent::RequestFinished { request, ok } => Some((request, ok)),
				_ => None,
			})
			.collect()
	}

	fn pending(&self) -> bool {
		self.cx
			.update(|app| self.state.read(app).panel_pending(HostActionKind::RefreshProcesses))
	}

	/// The key and title of every announcement raised.
	fn announced(&self) -> Vec<(String, String)> {
		self.cx.update(|app| {
			self.state
				.read(app)
				.store()
				.notifications
				.raised()
				.iter()
				.map(|held| (held.key.clone(), held.title.clone()))
				.collect()
		})
	}

	fn retry(&self) -> Option<HostAction> {
		self.cx.update(|app| {
			self.state
				.read(app)
				.store()
				.retries
				.peek(&SurfaceId::GlobalTitlebarLine)
				.cloned()
		})
	}
}

#[test]
fn a_request_left_unanswered_fails_at_its_deadline_and_offers_its_retry() {
	let window = Window::new();
	let request = window.refresh();
	window.seen.take();

	window.advance(REQUEST_TIMEOUT_MS);
	assert!(window.pending(), "in flight through the last millisecond of its deadline");
	assert_eq!(window.finished(), Vec::new());

	window.advance(1);
	assert!(!window.pending(), "the control stops drawing it as in flight");
	assert_eq!(window.finished(), vec![(request, false)]);
	assert!(window.cx.update(|app| window.state.read(app).registry().is_empty()));
	assert_eq!(window.retry(), Some(HostAction::RefreshProcesses), "its retry sends it again");
	assert_eq!(window.announced(), vec![(
		format!("request-failed:Connection:{UNANSWERED}"),
		"The host did not answer within 30 s.".to_owned(),
	)]);

	// Nothing is left to fail: a long wait finishes nothing more and raises
	// nothing more.
	window.advance(10 * REQUEST_TIMEOUT_MS);
	assert_eq!(window.finished(), Vec::new());
	assert_eq!(window.announced().len(), 1);
}

#[test]
fn a_request_answered_in_time_does_not_fail_when_its_deadline_passes() {
	let window = Window::new();
	let early = window.refresh();
	window.advance(REQUEST_TIMEOUT_MS / 2);
	let late = window.refresh();
	window.seen.take();

	window.answer(early);
	assert_eq!(window.finished(), vec![(early, true)]);

	// The first request's deadline passes; the second's has not.
	window.advance(REQUEST_TIMEOUT_MS / 2 + 1);
	assert_eq!(window.finished(), Vec::new());
	assert!(window.pending(), "the later request is still in flight");

	// The timer re-armed for the later request fails it at its own deadline.
	window.advance(REQUEST_TIMEOUT_MS / 2);
	assert_eq!(window.finished(), vec![(late, false)]);
	assert!(!window.pending());

	window.answer(late);
	window.advance(10 * REQUEST_TIMEOUT_MS);
	assert_eq!(window.announced().len(), 1, "one unanswered request, one announcement");
}

#[test]
fn a_request_dropped_past_the_capacity_ceiling_fails_as_evicted() {
	let window = Window::new();
	let first = window.refresh();
	for _ in 0..CAPACITY {
		window.refresh();
	}
	assert_eq!(window.finished(), vec![(first, false)], "the oldest fails, the rest stay");
	assert_eq!(window.cx.update(|app| window.state.read(app).registry().len()), CAPACITY);
	assert_eq!(window.announced(), vec![(
		format!("request-failed:Connection:{EVICTED}"),
		"Too many requests were in flight; this one was dropped.".to_owned(),
	)]);
}
