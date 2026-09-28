//! A refusal of what the page sent is stated in the words the host gave for
//! that request, whatever else the host refused meanwhile; a refusal of no
//! request the window sent is announced, in every scope, and held by no
//! control.
//!
//! WHY: the host announces every refusal, and a page that read the newest
//! announcement instead of its own request's stated another control's
//! sentence, or an earlier one of its own, whenever that one was stamped
//! later. A refusal nothing recorded has no control to land on, and one the
//! window dropped for want of a control is lost to everyone. The first test
//! refuses an unrelated request with the latest stamp and two of the page's
//! requests out of stamp order, and reads the page's error line alone, since
//! the window's announcements draw the same sentences; the second sweeps
//! `ErrorScope::iter()`, so a new scope is swept with no edit here.
//!
//! Gap: a refusal of a request the page sent before it was shown again is
//! not stated on the page, by design (`SettingsView::show` forgets the page's
//! requests); which toast is drawn first when more than `Toasts::LIMIT` are
//! raised is the workspace suite's.

use std::time::{SystemTime, UNIX_EPOCH};

use gpui::TestAppContext;
use strum::IntoEnumIterator as _;
use veyyon_desktop_model::{BackendError, ErrorScope, HostEvent, RequestId};

use super::harness::{refused, settings, window};

/// The wall clock in milliseconds. A refusal stamped from it stays announced
/// for its lifetime, so the stack holds every refusal the test raised
/// rather than only the last.
fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|elapsed| u64::try_from(elapsed.as_millis()).expect("the clock fits in u64"))
		.expect("the clock is past the epoch")
}

#[gpui::test]
fn a_refusal_is_stated_in_the_words_given_for_the_request_the_page_sent(app: &mut TestAppContext) {
	let now = now_ms();
	let mut w = window(app, vec![settings()]);
	w.open("general#context");
	w.sent();
	let unrelated = "Another control was refused";
	w.apply(vec![refused(RequestId(900), "OTHER", unrelated, now + 50)]);
	assert_eq!(w.error(), None, "a refusal of a request the page never sent");

	w.click("settings.control:toggle-retry.enabled");
	let flip = w.one();
	w.submit("compaction.threshold", "42");
	let threshold = w.one();
	let managed = "compaction.threshold is managed by the workspace";
	w.apply(vec![refused(threshold.id, "SETTING_MANAGED", managed, now + 9)]);
	assert!(w.draws(unrelated), "the unrelated refusal is still announced");
	assert_eq!(w.error().as_deref(), Some(managed), "not the refusal stamped later");

	let locked = "retry.enabled is locked by the project";
	w.apply(vec![refused(flip.id, "SETTING_LOCKED", locked, now + 3)]);
	assert_eq!(w.error().as_deref(), Some(locked), "the last request refused, stamped earlier");
}

#[gpui::test]
fn a_refusal_of_no_request_the_window_sent_is_announced_in_every_scope(app: &mut TestAppContext) {
	let mut w = window(app, vec![settings()]);
	w.open("general");
	w.sent();
	let now = now_ms();
	for (at, scope) in (10_000..).zip(ErrorScope::iter()) {
		let message = format!("The host failed in the {scope:?} scope");
		let error = BackendError {
			scope,
			code: Some("UNSENT".to_owned()),
			message: message.clone(),
			retryable: true,
			request: None,
			occurred_at_ms: now,
		};
		w.apply(vec![HostEvent::RequestFailed { request: RequestId(at), error }]);
		assert!(w.draws(&message), "a {scope:?} refusal nothing sent is announced");
		assert_eq!(w.error(), None, "and stated on no page");
		let (held, raised) = w.state.read_with(&*w.cx, |state, _| {
			let store = state.store();
			let raised: Vec<String> = store
				.notifications
				.raised()
				.iter()
				.map(|held| held.key.clone())
				.collect();
			(store.retries.refused().count(), raised)
		});
		assert_eq!(held, 0, "no control holds a {scope:?} refusal nothing sent");
		w.state.update(w.cx, |state, cx| {
			for key in &raised {
				state.dismiss_notification(key, cx);
			}
		});
		w.cx.run_until_parked();
	}
}
