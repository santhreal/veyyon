//! A refusal is drawn on the frame it is stated on, and the host's reports of
//! its own status that follow leave it drawn.
//!
//! WHY: a field's refusal once requested no frame, so it appeared only when
//! something else repainted, and the host's status reports overwrote a
//! refusal the window stated. The rebuilt window states a refusal as an
//! announcement on its stack, from two writers: the host refusing a request,
//! and the window failing a request the host left unanswered. For each
//! writer the frame on screen is read without a redraw, so a refusal that
//! does not make the window draw is not seen; then each status report is
//! applied and the refusal must still be queued, pushed and drawn.
//!
//! Gap: the status reports are the link coming up and restating itself, the
//! host naming its machine and listing its threads, not every section the
//! host sends. A refusal stated under its own control (a settings field, a
//! panel row) is the suite of the region that draws it. How long a refusal
//! stays up is the queue's contract, asserted in `main.rs`. A frame that
//! reuses a cached view registers none of its selectors, so after a status
//! report the toast is read from a redraw of every view, beside the stack's
//! own record of what it pushed.

use std::time::Duration;

use gpui::{Entity, TestAppContext, VisualTestContext};
use veyyon_desktop_app::{
	AppState,
	state::{REQUEST_TIMEOUT_MS, UNANSWERED},
};
use veyyon_desktop_model::{
	BackendError, ConnectionState, ErrorScope, HostAction, HostEvent, HostView, RequestId,
	SnapshotSection, SurfaceId,
};

use super::{drawn, listing, open, queued, raised_at, titles};

/// The host's sentence for the refusal it states.
const REFUSED: &str = "The profile is read-only.";

/// Who states the refusal.
#[derive(Clone, Copy, Debug)]
enum Writer {
	/// The host, answering a request with a refusal.
	Host,
	/// The window, failing a request the host left unanswered.
	Window,
}

/// Whether the frame on screen draws a toast, read without a redraw.
fn toast_on_screen(cx: &mut VisualTestContext) -> bool {
	cx.debug_bounds("toast-close").is_some()
}

/// Has `writer` state a refusal.
fn refuse(writer: Writer, app: &Entity<AppState>, cx: &mut VisualTestContext) {
	match writer {
		Writer::Host => {
			let request = RequestId(7);
			let error = BackendError {
				scope:          ErrorScope::Settings,
				code:           Some("read_only".to_owned()),
				message:        REFUSED.to_owned(),
				retryable:      false,
				request:        Some(request),
				occurred_at_ms: raised_at(),
			};
			let refusal = HostEvent::RequestFailed { request, error };
			app.update(cx, |app, cx| app.apply(vec![refusal], cx));
		},
		Writer::Window => {
			app.update(cx, |app, cx| {
				let _request =
					app.dispatch(HostAction::RefreshProcesses, SurfaceId::GlobalTitlebarLine, cx);
			});
			cx.run_until_parked();
			assert!(!toast_on_screen(cx), "a request in flight is not refused yet");
			cx.executor()
				.advance_clock(Duration::from_millis(REQUEST_TIMEOUT_MS + 1));
		},
	}
	cx.run_until_parked();
}

/// The host's reports of its own status, each with what it reports.
fn statuses() -> Vec<(&'static str, HostEvent)> {
	let up = || {
		HostEvent::ConnectionChanged(ConnectionState::Connected {
			endpoint: "local".to_owned(),
			protocol: 1,
		})
	};
	let machine = HostView { hostname: "build-01.example".to_owned() };
	vec![
		("the link comes up", up()),
		("the link restates itself", up()),
		("the host names its machine", HostEvent::Snapshot(SnapshotSection::Host(machine))),
		("the host lists its threads", listing()),
	]
}

#[test]
fn a_refusal_is_drawn_on_the_frame_it_is_stated_on_and_status_reports_leave_it_drawn() {
	for writer in [Writer::Host, Writer::Window] {
		let mut cx = TestAppContext::single();
		let (app, workspace, cx) = open(&mut cx);
		assert!(!toast_on_screen(cx), "{writer:?}: an idle window draws no toast");

		refuse(writer, &app, cx);
		assert!(toast_on_screen(cx), "{writer:?}: the refusal is drawn on the frame it is stated on");
		let held = queued(&app, cx);
		let stated = titles(&workspace, cx);
		assert_eq!((held.len(), stated.len()), (1, 1), "{writer:?}: one refusal is stated");
		match writer {
			Writer::Host => assert_eq!(stated, [REFUSED], "the host's sentence is drawn"),
			Writer::Window => {
				assert!(held[0].ends_with(UNANSWERED), "the window states the host did not answer");
			},
		}

		for (what, status) in statuses() {
			app.update(cx, |app, cx| app.apply(vec![status], cx));
			cx.run_until_parked();
			assert_eq!(queued(&app, cx), held, "{writer:?}: {what} left the refusal queued");
			assert_eq!(titles(&workspace, cx), stated, "{writer:?}: {what} left its toast");
			assert!(drawn(cx, "toast-close"), "{writer:?}: {what} left the refusal drawn");
		}
	}
}
