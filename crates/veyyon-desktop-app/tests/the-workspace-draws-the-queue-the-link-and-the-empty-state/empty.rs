//! With no session open the empty state holds the thread's place, and a new
//! window reopens the session the last one displayed while the host lists it.
//!
//! WHY: a window with no session open that draws an empty thread gives nothing
//! to start from. A new window that never asks for the session the last one
//! displayed draws its header over an empty transcript, and one that keeps a
//! session the host no longer lists draws a thread that is gone.
//!
//! Gap: the binary calls `reopen_remembered` once, on the first session list;
//! that trigger is outside this crate and is not exercised here.

use std::{cell::RefCell, rc::Rc};

use gpui::TestAppContext;
use veyyon_desktop_app::StoreEvent;
use veyyon_desktop_model::{
	HostAction, HostEvent, SessionId, SessionSummary, SnapshotSection, Versioned,
};

use super::{click, drawn, listing, open, open_over, remembering, sent, summary};

#[test]
fn the_empty_state_holds_the_threads_place_until_a_session_opens() {
	let mut cx = TestAppContext::single();
	let (app, _, cx) = open(&mut cx);
	assert!(!drawn(cx, "thread-region"), "no thread is drawn while no session is open");
	click(cx, "empty-new-thread");
	assert_eq!(sent(&app, cx), [HostAction::CreateSession { workspace: None, title: None }]);

	let listing: Vec<SessionSummary> = (0..7)
		.map(|ix| summary(&format!("s{ix}"), 100 + ix))
		.collect();
	app.update(cx, |app, cx| {
		let listing =
			SnapshotSection::Sessions(Versioned { revision: 1, value: listing }, Vec::new());
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

#[test]
fn a_new_window_asks_the_host_for_the_session_the_last_one_displayed() {
	let mut cx = TestAppContext::single();
	let (app, _, cx) = open_over(&mut cx, remembering("s1"));
	assert!(drawn(cx, "thread-region"), "the remembered thread is drawn before the host answers");
	assert_eq!(sent(&app, cx), Vec::new(), "nothing is asked for before the host lists its threads");

	app.update(cx, |app, cx| {
		app.apply(vec![listing()], cx);
		app.reopen_remembered(cx);
	});
	cx.run_until_parked();
	assert_eq!(sent(&app, cx), [HostAction::OpenSession { session: SessionId::from("s1") }]);
	assert!(drawn(cx, "thread-region"));
}

#[test]
fn a_session_the_host_no_longer_lists_is_dropped_for_the_empty_state() {
	let mut cx = TestAppContext::single();
	let (app, _, cx) = open_over(&mut cx, remembering("gone"));
	app.update(cx, |app, cx| app.apply(vec![listing()], cx));
	let heard = Rc::new(RefCell::new(Vec::new()));
	let sink = Rc::clone(&heard);
	let _heard = cx.update(|_, cx| {
		cx.subscribe(&app, move |_, event: &StoreEvent, _| sink.borrow_mut().push(event.clone()))
	});
	app.update(cx, |app, cx| app.reopen_remembered(cx));
	cx.run_until_parked();
	assert_eq!(sent(&app, cx), Vec::new(), "a session that is gone is not asked for");
	let (active, remembered) = app.read_with(cx, |app, _| {
		(app.active_session().cloned(), app.store().persisted.shell.active_session.clone())
	});
	assert_eq!((active, remembered), (None, None), "nor displayed, nor remembered");
	assert_eq!(*heard.borrow(), [StoreEvent::ActiveSessionChanged], "every region hears it");
	assert!(!drawn(cx, "thread-region"));
	assert!(drawn(cx, "empty-new-thread"), "the empty state takes its place");
}
