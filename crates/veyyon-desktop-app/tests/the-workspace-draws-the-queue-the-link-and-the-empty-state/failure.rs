//! A link that is not up is stated once, by the banner, with the banner's one
//! way out, and never restated by a toast.
//!
//! WHY: a fatal transport state was once stated three times at once, by the
//! banner, an attention strip and a dialog, two of them with a re-attach
//! button of their own. The rebuilt window draws the announcement queue as
//! toasts beside the banner, so the class closed here is the queue becoming a
//! second surface for the link: every connection state `every_state` holds,
//! and the fatal protocol error that reaches `Fatal` without one, is applied
//! through the store and must leave the queue and the stack empty while the
//! banner states it. A control announcement proves the stack is observable.
//!
//! Gap: a new connection state is swept only once `every_state` holds one of
//! it. A banner that draws a second button under another selector, or states
//! the failure twice in its own words, is not observed; the banner's single
//! optional remedy is its construction, and its request per state is
//! `the_banner_states_a_link_that_is_not_up_and_its_button_sends_the_remedy`'s
//! subject.

use gpui::{Entity, TestAppContext, VisualTestContext};
use veyyon_desktop_app::{AppState, workspace::Workspace};
use veyyon_desktop_model::{ConnectionState, HostAction, HostEvent};

use super::{
	Priority, Source, announce, click, drawn, every_state, note, open, queued, raised_at, sent,
	titles,
};

/// Whether the frame on screen draws a toast, read without a redraw.
fn toast_drawn(cx: &mut VisualTestContext) -> bool {
	cx.debug_bounds("toast-close").is_some()
}

/// The link's failure is stated by the banner and by nothing on the stack.
fn stated_by_the_banner_alone(
	app: &Entity<AppState>,
	workspace: &Entity<Workspace>,
	cx: &mut VisualTestContext,
	what: &str,
) {
	assert!(drawn(cx, "connection-banner"), "{what}: the banner states the link");
	assert_eq!(queued(app, cx), Vec::<String>::new(), "{what}: nothing is announced");
	assert_eq!(titles(workspace, cx), Vec::<String>::new(), "{what}: no toast is pushed");
	assert!(!toast_drawn(cx), "{what}: no toast is drawn");
}

#[test]
fn a_fatal_link_is_stated_by_the_banner_alone_and_its_one_control_sends_one_retry() {
	let arrivals = [
		HostEvent::FatalProtocolError { message: "frame too large".to_owned() },
		HostEvent::ConnectionChanged(ConnectionState::Fatal {
			message: "protocol mismatch".to_owned(),
		}),
	];
	for arrival in arrivals {
		let what = arrival.tag();
		let mut cx = TestAppContext::single();
		let (app, workspace, cx) = open(&mut cx);
		app.update(cx, |app, cx| app.apply(vec![arrival], cx));
		cx.run_until_parked();

		stated_by_the_banner_alone(&app, &workspace, cx, what);
		click(cx, "connection-banner-button");
		assert_eq!(sent(&app, cx), [HostAction::RetryConnection], "{what}: one way out");
		stated_by_the_banner_alone(&app, &workspace, cx, what);
	}
}

#[test]
fn no_connection_state_is_restated_by_a_toast() {
	let mut cx = TestAppContext::single();
	let (app, workspace, cx) = open(&mut cx);
	for state in every_state() {
		let what = format!("{state:?}");
		app.update(cx, |app, cx| app.apply(vec![HostEvent::ConnectionChanged(state)], cx));
		cx.run_until_parked();
		assert_eq!(queued(&app, cx), Vec::<String>::new(), "{what}: nothing is announced");
		assert_eq!(titles(&workspace, cx), Vec::<String>::new(), "{what}: no toast is pushed");
		assert!(!drawn(cx, "toast-close"), "{what}: no toast is drawn");
	}

	announce(&app, cx, note("control", Source::Extension, Priority::Low, "control", raised_at()));
	assert!(toast_drawn(cx), "an announcement is drawn as a toast in this window");
}
