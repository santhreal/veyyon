//! The diff tab parses the working tree's changes, and the files tab splits
//! and highlights the viewed file, once per host answer of that domain: an
//! answer of its own is derived again even when it repeats the last one, and
//! nothing else the store emits derives anything. The lines the viewer draws
//! are only ever split from the answer for the file it shows.
//!
//! WHY: the retired window derived both again on every host batch, so a
//! streamed turn over a large working tree spent each delta parsing the diff
//! and highlighting the open file again. The rebuilt viewer keyed its lines
//! on the answer alone, so opening another file drew the previous file's text
//! under the new name until the host answered, and for good when it refused
//! the read. The sweep emits every `StoreEvent`, the domain events read from
//! `SnapshotSectionKind`, and visits every `PanelTab`: a view that derives on
//! an event that answers nothing new turns it red, as does one that keys its
//! derivation on the answer's value, on its count alone, or on nothing.
//!
//! Gap: the cost is a timing property no test here measures. The diff's
//! per-file highlights and word alignment, derived lazily on first draw, are
//! held by the parse they hang off rather than counted on their own.

use gpui::TestAppContext;
use strum::IntoEnumIterator as _;
use veyyon_desktop_app::{StoreEvent, actions::panel::OpenFile, panel::PanelTab};
use veyyon_desktop_model::{
	FileContentView, HostAction, HostEvent, RequestId, SessionId, SnapshotSection,
	SnapshotSectionKind,
};

use super::{
	changes,
	harness::{SESSION, answer, delta, open_file, opened, refused, window},
};

/// The file the viewer shows.
const VIEWED: &str = "src/lib.rs";

/// The host's answer for the text of `path`.
fn content(path: &str, text: &str) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::FileContent(FileContentView {
		path:       path.to_owned(),
		content:    text.to_owned(),
		size_bytes: text.len() as u64,
		truncated:  false,
		binary:     false,
	}))
}

/// One of every event the store emits. The domain events are read from
/// `SnapshotSectionKind`; an event added to the store fails to compile in
/// `decided` until it is listed here.
fn every_event() -> Vec<StoreEvent> {
	let session = SessionId::from(SESSION);
	let others = [
		StoreEvent::SessionsChanged,
		StoreEvent::ActiveSessionChanged,
		StoreEvent::TranscriptReset { session: session.clone() },
		StoreEvent::TranscriptSpliced { session: session.clone(), range: 0..1, count: 1 },
		StoreEvent::StreamingChanged { session: session.clone() },
		StoreEvent::InteractionsChanged { session },
		StoreEvent::NotificationsChanged,
		StoreEvent::ConnectionChanged,
		StoreEvent::RequestFinished { request: RequestId(u64::MAX), ok: true },
		StoreEvent::Remembered,
		StoreEvent::OutboxReady,
	];
	SnapshotSectionKind::iter()
		.map(StoreEvent::DomainChanged)
		.chain(others)
		.inspect(decided)
		.collect()
}

/// Every kind of event the store emits, listed in `every_event`.
const fn decided(event: &StoreEvent) {
	match event {
		StoreEvent::SessionsChanged
		| StoreEvent::ActiveSessionChanged
		| StoreEvent::TranscriptReset { .. }
		| StoreEvent::TranscriptSpliced { .. }
		| StoreEvent::StreamingChanged { .. }
		| StoreEvent::InteractionsChanged { .. }
		| StoreEvent::DomainChanged(_)
		| StoreEvent::NotificationsChanged
		| StoreEvent::ConnectionChanged
		| StoreEvent::RequestFinished { .. }
		| StoreEvent::Remembered
		| StoreEvent::OutboxReady => {},
	}
}

#[gpui::test]
fn each_view_derives_once_per_answer_of_its_own_and_nothing_else_derives(app: &mut TestAppContext) {
	let mut events = opened(SESSION);
	events.push(changes());
	let mut w = window(app, events);
	w.open(PanelTab::Files);
	let asked = w.requests();
	answer(&mut w, asked);
	open_file(&mut w, VIEWED);
	let asked = w.requests();
	answer(&mut w, asked);
	w.apply(vec![content(VIEWED, "fn kept() {}\n")]);
	assert!(w.draws("fn kept() {}"), "the viewer draws the answer: {:?}", w.texts());
	let held = w.derivations();

	for event in every_event() {
		w.emit(event.clone());
		w.requests();
		assert_eq!(w.derivations(), held, "{event:?} derived what no answer replaced");
	}
	for tab in PanelTab::ALL {
		w.click(&format!("panel.tab:{}", tab.name()));
		w.requests();
		assert_eq!(w.derivations(), held, "a visit to {tab:?} derived before the host answered");
	}
	w.apply((1..=40).map(delta).collect());
	assert_eq!(w.derivations(), held, "a streamed turn derived");

	w.click("panel.tab:files");
	w.cx
		.dispatch_action(OpenFile { path: VIEWED.to_owned(), line: Some(1) });
	w.cx.run_until_parked();
	w.requests();
	assert_eq!(w.derivations(), held, "a link to the viewed file derived before the host answered");
	assert!(w.draws("fn kept() {}"), "and the viewer draws what it holds: {:?}", w.texts());

	w.apply(vec![changes()]);
	assert_eq!(
		w.derivations(),
		[held[0] + 1, held[1]],
		"the diff parses a repeated answer of its own, and the viewer does not"
	);
	w.apply(vec![content(VIEWED, "fn kept() {}\n")]);
	assert_eq!(
		w.derivations(),
		[held[0] + 1, held[1] + 1],
		"the viewer splits a repeated answer of its own, and the diff does not"
	);
}

#[gpui::test]
fn a_file_opened_over_another_draws_none_of_the_other_files_lines(app: &mut TestAppContext) {
	let mut w = window(app, opened(SESSION));
	w.open(PanelTab::Files);
	w.requests();
	open_file(&mut w, "src/a.rs");
	w.requests();
	w.apply(vec![content("src/a.rs", "fn only_in_a() {}\n")]);
	assert!(w.draws("fn only_in_a() {}"), "{:?}", w.texts());

	open_file(&mut w, "src/b.rs");
	let read = w
		.requests()
		.into_iter()
		.find(|request| request.action == HostAction::ReadFile { path: "src/b.rs".to_owned() })
		.expect("the link reads the file it names");
	assert!(w.draws("src/b.rs"), "the viewer shows the file the link names: {:?}", w.texts());
	assert!(!w.draws("fn only_in_a() {}"), "and none of the other file's lines: {:?}", w.texts());
	w.apply(vec![refused(read.id, "src/b.rs is not readable", false)]);
	assert!(w.draws("src/b.rs is not readable"), "{:?}", w.texts());
	assert!(!w.draws("fn only_in_a() {}"), "a refused read draws none of the other file's lines");

	w.apply(vec![content("src/b.rs", "fn only_in_b() {}\n")]);
	assert!(w.draws("fn only_in_b() {}"), "{:?}", w.texts());
	open_file(&mut w, "src/a.rs");
	w.requests();
	assert!(!w.draws("fn only_in_b() {}"), "going back draws none of b's lines: {:?}", w.texts());
}
