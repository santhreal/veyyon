//! A draft, its queue mode and its attached files are left in a thread and
//! found there again, a prompt the host refuses comes back to the thread that
//! sent it, an open the host refuses returns to the thread left, and a peek
//! at another thread's transcript changes neither the thread on screen nor a
//! draft.
//!
//! WHY: one composer serves every thread, saving the draft it leaves and
//! showing the one it arrives at. A switch that saved after taking the next
//! thread wrote one thread's prompt into another, and one that restored only
//! the text lost the queue mode and the files. The host switches threads too,
//! by stating another session active, and that switch loses the draft unless
//! it takes the same path as a row click. The window shows a clicked thread
//! before the host opens it, so a refused open returns to the thread left,
//! which must find its own draft, not the words typed meanwhile. Send empties
//! the draft before the host answers, so a composer that forgot the prompt in
//! flight when the window left its thread lost a refused prompt and its files
//! outright, and one that put it in the draft on screen sent it from the
//! wrong thread. A peeked transcript the store took for the live one replaced
//! the thread on screen and the draft typed there.
//!
//! Gap: pasted images are `paste`'s, and a refusal that arrives before a
//! pasted image's file is written is not driven; the peek's own drawing in
//! the sidebar and the agents panel, and resuming a peeked thread, are the
//! sidebar's and the panel's suites'.

use std::fs;

use gpui::TestAppContext;
use veyyon_desktop_app::actions::composer::Submit;
use veyyon_desktop_model::{
	HostAction, HostEvent, InputModality, MessageRole, ModelRef, ModelView, ModelsView, QueueMode,
	SessionHeaderView, SessionId, SessionTranscriptView, SnapshotSection, Versioned,
};
use veyyon_test_scratch::scratch_dir;

use super::{Win, entry, other, refused, sid, streamed, window};

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

/// A catalog whose one model takes text, so a file goes out with a prompt.
fn takes_text() -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Models(ModelsView {
		models:          vec![ModelView {
			provider:       "anthropic".to_owned(),
			id:             "claude".to_owned(),
			name:           "Claude".to_owned(),
			reasoning:      false,
			context_window: 200_000,
			max_output:     64_000,
			input:          vec![InputModality::Text],
		}],
		current:         Some(ModelRef {
			provider: "anthropic".to_owned(),
			id:       "claude".to_owned(),
		}),
		thinking_level:  None,
		thinking_levels: Vec::new(),
	}))
}

/// How the host answers the prompt, and what `s`'s draft holds by then.
const ANSWERS: [(&str, bool, Option<&str>); 3] = [
	("refused, the draft left empty", false, None),
	("refused, the draft rewritten", false, Some("Second thought")),
	("accepted", true, None),
];

#[test]
fn a_prompt_the_host_answers_comes_back_to_the_thread_that_sent_it_and_no_other() {
	let tree = scratch_dir("an-answer-follows-its-thread");
	let notes = tree.join("notes.txt");
	fs::write(&notes, b"a note").expect("the scratch directory is writable");
	let file = vec![("notes.txt".to_owned(), b"a note".to_vec())];
	for (how, switch) in SWITCHES {
		for left_first in [false, true] {
			for (answer, ok, rewritten) in ANSWERS {
				let case = format!("{how}, {answer}, answered after leaving: {left_first}");
				let mut app = TestAppContext::single();
				let mut w = window(&mut app, vec![takes_text()]);
				w.write("Summarise the notes.");
				w.attach(vec![notes.clone()]);
				w.dispatch(Submit);
				let request = w
					.requests()
					.into_iter()
					.find(|request| matches!(request.action, HostAction::SubmitPrompt { .. }))
					.map_or_else(
						|| panic!("{case}: the prompt and its file were sent"),
						|request| request.id,
					);
				if let Some(text) = rewritten {
					w.write(text);
				}
				let answered = if ok {
					HostEvent::RequestSucceeded { request }
				} else {
					refused(request)
				};
				if left_first {
					switch(&mut w, other());
					w.write("Another thread's words");
					w.apply(vec![answered]);
				} else {
					w.apply(vec![answered]);
					switch(&mut w, other());
					w.write("Another thread's words");
				}
				assert_eq!(
					(w.draft(), w.tray(), w.drew("Not sent")),
					("Another thread's words".to_owned(), Vec::new(), false),
					"{case}: the thread on screen keeps its own draft",
				);

				let back = match (ok, rewritten) {
					(_, Some(text)) => text,
					(true, None) => "",
					(false, None) => "Summarise the notes.",
				};
				let paths = if ok {
					Vec::new()
				} else {
					vec![notes.display().to_string()]
				};
				let saved = w
					.saved(&sid())
					.map(|draft| (draft.draft_text, draft.attachments))
					.unwrap_or_default();
				assert_eq!(
					saved,
					(back.to_owned(), paths),
					"{case}: s's saved draft holds what came back",
				);
				switch(&mut w, sid());
				let tray = if ok { Vec::new() } else { file.clone() };
				assert_eq!(
					(w.draft(), w.tray(), w.drew("Not sent")),
					(back.to_owned(), tray, !ok),
					"{case}: s gets back the prompt and the file the host refused, offered again",
				);
			}
		}
	}
}

#[gpui::test]
fn an_open_the_host_refuses_returns_to_the_thread_left_and_its_draft(app: &mut TestAppContext) {
	let mut w = window(app, Vec::new());
	w.write("Half a prompt");
	w.drain();
	w.show(other());
	let open = w
		.requests()
		.into_iter()
		.find(|request| matches!(request.action, HostAction::OpenSession { .. }))
		.map(|request| request.id)
		.expect("the open was asked for");
	w.write("Words for t");

	w.apply(vec![refused(open)]);
	let shown = w
		.state
		.read_with(&*w.cx, |state, _| state.active_session().cloned());
	assert_eq!(
		(shown, w.draft()),
		(Some(sid()), "Half a prompt".to_owned()),
		"the window is back on s with its own draft",
	);
	assert_eq!(
		w.saved(&other()).map(|draft| draft.draft_text),
		Some("Words for t".to_owned()),
		"what was typed while t was shown stays t's",
	);
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
