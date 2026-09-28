//! The workspace draws the announcement queue as toasts, a banner while the
//! host link is not up, and the empty state while no session is open.
//!
//! WHY: the queue is the single definition of an announcement's lifetime. A
//! toast that outlives its announcement, or a closed toast whose announcement
//! stays queued, draws a stack that disagrees with the store; a toast that
//! times out on a clock of its own drops an urgent announcement nobody read,
//! and a stack drawn under the resting pointer pauses and never times out.
//! A link that is down with no banner leaves the window looking attached, and
//! a banner button that sends the wrong request cannot bring the link back. A
//! window with no session open that draws an empty thread gives nothing to
//! start from.
//!
//! Gap: toast tone, the banner's wording and the drawn pixels are not
//! asserted. A new connection state fails to compile in `remedy` but is swept
//! only once a state of it is added to `every_state`. Deadlines are stamped a
//! minute ahead of the wall clock and the timer runs on the executor's clock,
//! so a run that stalls a minute between stamping and arming misreads.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gpui::{
	AnyView, AppContext as _, Context, EmptyView, Entity, IntoElement, Modifiers, Render,
	TestAppContext, VisualTestContext, Window, div, prelude::*,
};
use veyyon_desktop_app::{
	AppState,
	workspace::{Regions, Workspace},
};
use veyyon_desktop_model::{
	ConnectionState, HostAction, HostEvent, Notification, NotificationPriority as Priority,
	NotificationSource as Source, PanelsStore, SessionId, SessionStatus, SessionSummary,
	SnapshotSection, Store, Versioned,
};
use veyyon_desktop_ui::theme::{Appearance, Theme};

/// The thread region, found by its selector.
struct Thread;

impl Render for Thread {
	fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
		div().debug_selector(|| "thread-region".to_owned()).size_full()
	}
}

/// A workspace over an empty store, under reduced motion so a toast goes the
/// moment it is taken down.
fn open(cx: &mut TestAppContext) -> (Entity<AppState>, Entity<Workspace>, &mut VisualTestContext) {
	cx.update(|cx| Theme::install(Appearance::Dark, cx)).expect("the dark palette parses");
	cx.update(|cx| cx.set_reduce_motion(true));
	let app = cx.update(|cx| cx.new(|_| AppState::new(Store::new())));
	let state = app.clone();
	let (workspace, cx) = cx.add_window_view(move |window, cx| {
		let thread = AnyView::from(cx.new(|_| Thread));
		let mut empty = || AnyView::from(cx.new(|_| EmptyView));
		let regions = Regions {
			sidebar: empty(),
			thread,
			panel: empty(),
			drawer: empty(),
			palette: empty(),
			settings: empty(),
		};
		Workspace::new(state, regions, PanelsStore::default(), window, cx)
	});
	cx.run_until_parked();
	(app, workspace, cx)
}

/// A minute past the wall clock, the instant every announcement is raised at.
fn raised_at() -> u64 {
	let now = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.expect("the wall clock is past the epoch");
	u64::try_from(now.as_millis()).expect("the wall clock fits in u64 milliseconds") + 60_000
}

fn note(key: &str, source: Source, priority: Priority, title: &str, at: u64) -> Notification {
	Notification {
		key: key.to_owned(),
		source,
		priority,
		title: title.to_owned(),
		detail: None,
		raised_at_ms: at,
	}
}

fn announce(app: &Entity<AppState>, cx: &mut VisualTestContext, notification: Notification) {
	app.update(cx, |app, cx| {
		app.announce(notification, cx);
	});
	cx.run_until_parked();
}

/// The messages of the drawn toasts, top to bottom.
fn titles(workspace: &Entity<Workspace>, cx: &mut VisualTestContext) -> Vec<String> {
	workspace.read_with(cx, |workspace, cx| {
		let toasts = workspace.toasts().read(cx);
		toasts.toasts().map(|(_, toast)| toast.message().to_string()).collect()
	})
}

/// The keys on the queue, most urgent first.
fn queued(app: &Entity<AppState>, cx: &mut VisualTestContext) -> Vec<String> {
	app.read_with(cx, |app, _| {
		let queue = app.store().notifications.raised();
		queue.iter().map(|held| held.key.clone()).collect()
	})
}

fn advance(cx: &mut VisualTestContext, by: Duration) {
	cx.executor().advance_clock(by);
	cx.run_until_parked();
}

/// Redraws every view, cached or not, so each selector reads the frame.
fn drawn(cx: &mut VisualTestContext, selector: &'static str) -> bool {
	cx.update(|window, _| window.refresh());
	cx.debug_bounds(selector).is_some()
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
	cx.update(|window, _| window.refresh());
	let bounds = cx
		.debug_bounds(selector)
		.unwrap_or_else(|| panic!("`{selector}` is drawn"));
	cx.simulate_click(bounds.center(), Modifiers::none());
	cx.run_until_parked();
}

fn sent(app: &Entity<AppState>, cx: &mut VisualTestContext) -> Vec<HostAction> {
	let requests = app.update(cx, |app, _| app.drain_outbox());
	requests.into_iter().map(|request| request.action).collect()
}

#[test]
fn an_announcement_is_drawn_until_the_queue_takes_it_down() {
	let mut cx = TestAppContext::single();
	let (app, workspace, cx) = open(&mut cx);
	let at = raised_at();
	announce(&app, cx, note("saved", Source::Extension, Priority::Low, "saved", at));
	announce(&app, cx, note("ask", Source::DecisionWaiting, Priority::Urgent, "decision", at));
	assert_eq!(titles(&workspace, cx), ["saved", "decision"]);
	let viewport = cx.update(|window, _| window.viewport_size());
	cx.update(|window, _| window.refresh());
	let close = cx.debug_bounds("toast-close").expect("a toast's close button is drawn");
	assert!(
		close.center().x > viewport.width / 2. && close.center().y > viewport.height / 2.,
		"the stack sits in the bottom right corner, clear of the pointer at the origin"
	);

	advance(cx, Duration::from_secs(63));
	assert_eq!(titles(&workspace, cx), ["saved", "decision"], "both drawn before the low one's time");
	advance(cx, Duration::from_secs(2));
	assert_eq!(queued(&app, cx), ["ask"], "the timer expired the queue at the low one's deadline");
	assert_eq!(titles(&workspace, cx), ["decision"], "its toast went with it");
	advance(cx, Duration::from_secs(3600));
	assert_eq!(titles(&workspace, cx), ["decision"], "an urgent announcement never times out");

	app.update(cx, |app, cx| app.dismiss_notification("ask", cx));
	cx.run_until_parked();
	assert!(titles(&workspace, cx).is_empty(), "dismissing it on the queue takes its toast down");
}

#[test]
fn a_restated_announcement_is_redrawn_and_closing_its_toast_dismisses_it() {
	let mut cx = TestAppContext::single();
	let (app, workspace, cx) = open(&mut cx);
	let at = raised_at();
	announce(&app, cx, note("refused", Source::RequestFailed, Priority::Normal, "refused", at));
	announce(&app, cx, note("refused", Source::RequestFailed, Priority::Normal, "refused again", at));
	assert_eq!(titles(&workspace, cx), ["refused again"]);

	click(cx, "toast-close");
	assert!(queued(&app, cx).is_empty(), "closing the toast took its announcement off the queue");
	assert!(titles(&workspace, cx).is_empty());
}

#[test]
fn only_the_most_urgent_announcements_the_stack_holds_are_drawn() {
	let mut cx = TestAppContext::single();
	let (app, workspace, cx) = open(&mut cx);
	let at = raised_at();
	for key in ["a", "b", "c"] {
		announce(&app, cx, note(key, Source::Extension, Priority::Low, key, at));
	}
	assert_eq!(titles(&workspace, cx), ["a", "b", "c"]);
	announce(&app, cx, note("d", Source::Extension, Priority::Urgent, "d", at));
	assert_eq!(titles(&workspace, cx), ["a", "b", "d"], "the least urgent gives way");
	app.update(cx, |app, cx| app.dismiss_notification("a", cx));
	cx.run_until_parked();
	assert_eq!(titles(&workspace, cx), ["b", "d", "c"], "a freed place draws the next one queued");
}

/// Whether the banner is drawn for `state`, and the request its button
/// sends.
fn remedy(state: &ConnectionState) -> (bool, Option<HostAction>) {
	match state {
		ConnectionState::Detached => (true, Some(HostAction::Attach { endpoint: None })),
		ConnectionState::Connecting { .. } => (true, None),
		ConnectionState::Syncing { .. } | ConnectionState::Connected { .. } => (false, None),
		ConnectionState::Reconnecting { .. } | ConnectionState::Fatal { .. } => {
			(true, Some(HostAction::RetryConnection))
		},
	}
}

fn every_state() -> Vec<ConnectionState> {
	vec![
		ConnectionState::Connected { endpoint: "local".to_owned(), protocol: 1 },
		ConnectionState::Detached,
		ConnectionState::Connecting { attempt: 1 },
		ConnectionState::Connecting { attempt: 3 },
		ConnectionState::Syncing { received: 1, expected: Some(4) },
		ConnectionState::Reconnecting {
			attempt:     2,
			retry_at_ms: 0,
			message:     "reset by peer".to_owned(),
		},
		ConnectionState::Reconnecting { attempt: 1, retry_at_ms: 0, message: String::new() },
		ConnectionState::Fatal { message: "protocol mismatch".to_owned() },
	]
}

#[test]
fn the_banner_states_a_link_that_is_not_up_and_its_button_sends_the_remedy() {
	let mut cx = TestAppContext::single();
	let (app, _, cx) = open(&mut cx);
	for state in every_state() {
		let (shown, request) = remedy(&state);
		app.update(cx, |app, cx| app.apply(vec![HostEvent::ConnectionChanged(state.clone())], cx));
		cx.run_until_parked();
		assert_eq!(drawn(cx, "connection-banner"), shown, "banner for {state:?}");
		assert_eq!(drawn(cx, "connection-banner-button"), request.is_some(), "button for {state:?}");
		if request.is_some() {
			click(cx, "connection-banner-button");
		}
		assert_eq!(sent(&app, cx), request.into_iter().collect::<Vec<_>>(), "request for {state:?}");
	}
}

/// A thread modified at `modified_at_ms`.
fn summary(id: &str, modified_at_ms: u64) -> SessionSummary {
	SessionSummary {
		id: SessionId::from(id),
		workspace: "ws-default".to_owned(),
		path: format!("/sessions/{id}.jsonl"),
		cwd: "/w/alpha".to_owned(),
		title: Some(format!("title {id}")),
		parent_path: None,
		created_at_ms: 0,
		modified_at_ms,
		message_count: 1,
		size_bytes: 1,
		first_message: None,
		searchable_messages: None,
		status: SessionStatus::Complete,
	}
}

#[test]
fn the_empty_state_holds_the_threads_place_until_a_session_opens() {
	let mut cx = TestAppContext::single();
	let (app, _, cx) = open(&mut cx);
	assert!(!drawn(cx, "thread-region"), "no thread is drawn while no session is open");
	click(cx, "empty-new-thread");
	assert_eq!(sent(&app, cx), [HostAction::CreateSession { workspace: None, title: None }]);

	let listing: Vec<SessionSummary> =
		(0..7).map(|ix| summary(&format!("s{ix}"), 100 + ix)).collect();
	app.update(cx, |app, cx| {
		let listing = SnapshotSection::Sessions(Versioned { revision: 1, value: listing }, Vec::new());
		app.apply(vec![HostEvent::Snapshot(listing)], cx);
	});
	cx.run_until_parked();
	let rows = [
		"empty-recent-thread-0",
		"empty-recent-thread-1",
		"empty-recent-thread-2",
		"empty-recent-thread-3",
		"empty-recent-thread-4",
		"empty-recent-thread-5",
	];
	let listed: Vec<bool> = rows.into_iter().map(|row| drawn(cx, row)).collect();
	assert_eq!(listed, [true, true, true, true, true, false], "the five most recent are listed");

	click(cx, "empty-recent-thread-0");
	assert_eq!(sent(&app, cx), [HostAction::OpenSession { session: SessionId::from("s6") }]);
	assert!(drawn(cx, "thread-region"), "the opened thread takes the empty state's place");
	assert!(!drawn(cx, "empty-new-thread"));
}
