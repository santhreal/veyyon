//! A draft, its queue mode and its attached files are left in a thread and
//! found there again, and a peek at another thread's transcript changes
//! neither the thread on screen nor a draft.
//!
//! WHY: one composer serves every thread, saving the draft it leaves and
//! showing the one it arrives at. A switch that saved after taking the next
//! thread wrote one thread's prompt into another, and one that restored only
//! the text lost the queue mode and the files. The host switches threads too,
//! by stating another session active, and that switch loses the draft unless
//! it takes the same path as a row click. A peeked transcript the store took
//! for the live one replaced the thread on screen and the draft typed there.
//!
//! Gap: pasted images are `paste`'s; the peek's own drawing in the sidebar and
//! the agents panel, and resuming a peeked thread, are the sidebar's and the
//! panel's suites'.

use std::fs;

use gpui::TestAppContext;
use veyyon_desktop_model::{
	HostAction, HostEvent, MessageRole, QueueMode, SessionHeaderView, SessionId,
	SessionTranscriptView, SnapshotSection, Versioned,
};
use veyyon_test_scratch::scratch_dir;

use super::{Win, entry, other, sid, streamed, window};

/// The host stating `session` active.
fn host_shows(session: SessionId) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
		revision: 1,
		value:    SessionHeaderView {
			id:             session,
			schema_version: 1,
			title:          None,
			title_source:   None,
			parent:         None,
			created_at_ms:  0,
			cwd:            "/w".to_owned(),
			mode:           None,
		},
	}))
}

/// Shows another thread in the window.
type Switch = fn(&mut Win<'_>, SessionId);

/// Each way the window comes to show another thread: a click on its row,
/// and the host stating it active.
const SWITCHES: [(&str, Switch); 2] = [
	("a row click", |w, session| w.show(session)),
	("the host's header", |w, session| w.apply(vec![host_shows(session)])),
];

fn queue_mode(w: &Win<'_>) -> QueueMode {
	w.composer
		.read_with(&*w.cx, |composer, _| composer.queue_mode())
}

#[test]
fn each_thread_gets_back_its_own_text_queue_mode_and_files_however_the_window_switches() {
	let tree = scratch_dir("drafts-follow-their-thread");
	let notes = tree.join("notes.txt");
	fs::write(&notes, b"a note").expect("the scratch directory is writable");
	for (how, switch) in SWITCHES {
		let mut app = TestAppContext::single();
		let mut w = window(&mut app, vec![streamed(2)]);
		w.write("Half a prompt");
		w.focus();
		w.keys("alt-q");
		w.attach(vec![notes.clone()]);
		let left = ("Half a prompt".to_owned(), QueueMode::Queue, vec![(
			"notes.txt".to_owned(),
			b"a note".to_vec(),
		)]);

		switch(&mut w, other());
		let arrived = (w.draft(), queue_mode(&w), w.tray());
		assert_eq!(arrived, (String::new(), QueueMode::Steer, Vec::new()), "{how}: t starts empty");
		w.write("Another thread's words");

		switch(&mut w, sid());
		assert_eq!((w.draft(), queue_mode(&w), w.tray()), left, "{how}: s is as it was left");
		switch(&mut w, other());
		assert_eq!(w.draft(), "Another thread's words", "{how}: t is as it was left");
		assert_eq!(w.tray(), Vec::new(), "{how}: s's files stay with s");
	}
}

#[gpui::test]
fn a_peek_at_another_threads_transcript_leaves_the_thread_on_screen_and_its_draft(
	app: &mut TestAppContext,
) {
	let mut w = window(app, Vec::new());
	w.write("Unfinished prompt");
	w.drain();
	let kept = |w: &Win<'_>| {
		w.state.read_with(&*w.cx, |state, _| {
			let store = state.store();
			(store.persisted.clone(), store.transcripts.clone())
		})
	};
	let before = kept(&w);
	assert!(w.drew("Index the repo."));

	w.apply(vec![HostEvent::Snapshot(SnapshotSection::SessionTranscript(SessionTranscriptView {
		session:    SessionId::from("peeked"),
		transcript: Versioned {
			revision: 3,
			value:    vec![entry("p-0", MessageRole::User, "An earlier prompt", 3)],
		},
	}))]);
	let shown = w
		.state
		.read_with(&*w.cx, |state, _| state.active_session().cloned());
	assert_eq!(shown, Some(sid()), "a peek opens nothing");
	w.cx.update(|window, _| window.refresh());
	w.cx.run_until_parked();
	assert!(w.drew("Index the repo.") && !w.drew("An earlier prompt"), "the thread draws s");
	assert_eq!(w.draft(), "Unfinished prompt");
	assert_eq!(
		kept(&w),
		before,
		"a peek writes neither what the window keeps nor a live transcript"
	);
	let sent = w.sent();
	assert!(
		!sent
			.iter()
			.any(|action| matches!(action, HostAction::OpenSession { .. })),
		"a peek asks the host to open nothing: {sent:?}"
	);
}
