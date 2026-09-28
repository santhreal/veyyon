//! Each header button sends one request per press the host takes: nothing
//! more while its press is in flight, nothing while the host withholds its
//! capability, and again once the host answers, refuses or lets the
//! deadline pass.

use std::time::Duration;

use gpui::TestAppContext;
use strum::IntoEnumIterator as _;
use veyyon_desktop_app::state::REQUEST_TIMEOUT_MS;
use veyyon_desktop_model::{
	BackendError, ErrorScope, HostAction, HostEvent, RequestId, action_to_capability,
	domain::{ExportFormat, ShareRole},
};

use super::{Win, answered, capability, share, sid, stated, window};

/// Each button the header draws for a host request, and what a press sends
/// with session `s` open, nothing shared and every agent running.
fn buttons() -> [(&'static str, HostAction); 4] {
	[
		("thread.compact", HostAction::CompactSession { session: sid() }),
		("thread.export", HostAction::ExportSession { session: sid(), format: ExportFormat::Html }),
		("thread.share", HostAction::StartShare { read_only: false }),
		("thread.pause", HostAction::PauseAgents),
	]
}

/// How the host answers a request, and the event that answers it.
type Answer = (&'static str, fn(RequestId) -> HostEvent);

/// The host refusing `request` for a reason that holds for it alone.
fn failed(request: RequestId) -> HostEvent {
	HostEvent::RequestFailed {
		request,
		error: BackendError {
			scope:          ErrorScope::Session,
			code:           None,
			message:        "the host is busy".to_owned(),
			retryable:      true,
			request:        Some(request),
			occurred_at_ms: 0,
		},
	}
}

/// Presses `id` and returns the one request it sent, failing with `when`
/// when it sent another number of them.
fn press_one(w: &mut Win<'_>, id: &str, expected: &HostAction, when: &str) -> RequestId {
	w.click(id);
	let requests = w.requests();
	assert_eq!(
		requests
			.iter()
			.map(|request| &request.action)
			.collect::<Vec<_>>(),
		vec![expected],
		"{id} sends one request per press {when}"
	);
	requests[0].id
}

#[gpui::test]
fn each_button_sends_nothing_more_until_its_press_is_answered_either_way(app: &mut TestAppContext) {
	let mut w = window(app, Vec::new());
	let answers: [Answer; 2] = [("answered", answered), ("refused", failed)];
	for (id, action) in buttons() {
		for (how, answer) in answers {
			let request = press_one(&mut w, id, &action, "at rest");
			w.click(id);
			assert_eq!(
				w.sent(),
				Vec::<HostAction>::new(),
				"{id} sends nothing while its press is in flight"
			);
			for (other, other_action) in buttons().into_iter().filter(|(other, _)| *other != id) {
				let other_request =
					press_one(&mut w, other, &other_action, &format!("while {id} is in flight"));
				w.apply(vec![answered(other_request)]);
			}
			w.apply(vec![answer(request)]);
			let again = press_one(&mut w, id, &action, &format!("once its press is {how}"));
			w.apply(vec![answered(again)]);
		}
	}
}

#[gpui::test]
fn a_button_whose_capability_the_host_withholds_sends_nothing_until_granted(
	app: &mut TestAppContext,
) {
	let mut w = window(app, Vec::new());
	for (id, action) in buttons() {
		let request = press_one(&mut w, id, &action, "before the host states its capabilities");
		w.apply(vec![answered(request)]);
		let granted = action_to_capability(action.kind());
		w.apply(vec![capability(granted, Some("this host does not"))]);
		w.click(id);
		assert_eq!(w.sent(), Vec::<HostAction>::new(), "{id} sends nothing {granted:?} withholds");
		w.apply(vec![capability(granted, None)]);
		let request = press_one(&mut w, id, &action, &format!("once {granted:?} is granted"));
		w.apply(vec![answered(request)]);
	}
}

#[gpui::test]
fn the_share_button_sends_the_request_for_the_side_of_the_share_the_window_is_on(
	app: &mut TestAppContext,
) {
	let mut w = window(app, Vec::new());
	for role in ShareRole::iter() {
		w.apply(vec![stated(share(role))]);
		let expected = match role {
			ShareRole::Off => HostAction::StartShare { read_only: false },
			ShareRole::Hosting => HostAction::StopShare,
			ShareRole::Guest => HostAction::LeaveShare,
		};
		let request = press_one(&mut w, "thread.share", &expected, &format!("as {role:?}"));
		w.apply(vec![answered(request)]);
	}
}

#[gpui::test]
fn a_press_the_host_never_answers_frees_its_button_at_the_deadline_and_not_before(
	app: &mut TestAppContext,
) {
	let mut w = window(app, Vec::new());
	for (id, action) in buttons() {
		press_one(&mut w, id, &action, "at rest");
	}
	w.cx
		.executor()
		.advance_clock(Duration::from_millis(REQUEST_TIMEOUT_MS));
	w.cx.run_until_parked();
	for (id, _) in buttons() {
		w.click(id);
		assert_eq!(w.sent(), Vec::<HostAction>::new(), "{id} is held through its deadline");
	}
	w.cx.executor().advance_clock(Duration::from_millis(1));
	w.cx.run_until_parked();
	for (id, action) in buttons() {
		press_one(&mut w, id, &action, "once its deadline passed");
	}
}
