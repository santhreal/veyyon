//! The thread draws what a session's extensions set: their statuses beside
//! the run state in the header, and their working message in place of the
//! streaming tail's own working text while a turn streams.
//!
//! WHY: an `ExtensionUi` section arrives as a domain change, not as a stream
//! frame. A tail that reads the working message only when the stream moves
//! keeps drawing its own text until the next delta, and a turn waiting on a
//! tool sends none. A header that draws only the session's own chips drops
//! the statuses an extension states. The suite drives the real `ThreadView`
//! over an `AppState` fed host events and reads the text the frame drew.
//!
//! Gap: widgets and completions are the composer's and are not drawn here;
//! the order of statuses is the host's (by key) and is not re-sorted.

use gpui::{AppContext as _, Entity, TestAppContext, VisualTestContext, px, size};
use veyyon_desktop_app::{AppState, driver, thread::ThreadView};
use veyyon_desktop_model::{
	ContentBlock, EntryId, HostEvent, MessageRole, SessionHeaderView, SessionId, SnapshotSection,
	Store, StreamingMessageState, TranscriptEntry, Versioned,
	domain::{ExtensionStatusView, ExtensionUiView},
};
use veyyon_desktop_ui::theme::{Appearance, Theme};

fn entry(id: &str, role: MessageRole, text: &str, revision: u64) -> TranscriptEntry {
	TranscriptEntry {
		id: EntryId::from(id),
		parent: None,
		revision,
		timestamp_ms: revision,
		role,
		content: vec![ContentBlock::Text { text: text.to_owned() }],
		meta: None,
		raw_discriminator: String::new(),
		raw: serde_json::Value::Null,
	}
}

/// Session `s` open with the operator's prompt.
fn opened() -> Vec<HostEvent> {
	let header = SessionHeaderView {
		id:             SessionId::from("s"),
		schema_version: 1,
		title:          None,
		title_source:   None,
		parent:         None,
		created_at_ms:  0,
		cwd:            "/w/s".to_owned(),
		mode:           None,
	};
	vec![
		HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
			revision: 1,
			value:    header,
		})),
		HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
			revision: 1,
			value:    vec![entry("s-0", MessageRole::User, "Index the repo.", 1)],
		})),
	]
}

/// The agent's turn so far: `text` written and `tool` running.
fn streamed(text: &str, tool: Option<&str>, revision: u64) -> HostEvent {
	HostEvent::StreamingChanged(Some(StreamingMessageState {
		entry: EntryId::from("stream-1"),
		tool: tool.map(str::to_owned),
		accumulating: entry("stream-1", MessageRole::Assistant, text, revision),
		revision,
	}))
}

/// What the extensions of session `s` set.
fn extension_ui(statuses: &[(&str, &str)], working: Option<&str>) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::ExtensionUi {
		session: SessionId::from("s"),
		ui:      ExtensionUiView {
			statuses:        statuses
				.iter()
				.map(|(key, text)| ExtensionStatusView {
					key:  (*key).to_owned(),
					text: (*text).to_owned(),
				})
				.collect(),
			working_message: working.map(str::to_owned),
			widgets:         Vec::new(),
			completes:       false,
		},
	})
}

fn thread(app: &mut TestAppContext) -> (Entity<AppState>, &mut VisualTestContext) {
	driver::enable();
	app.update(|cx| {
		Theme::install(Appearance::Dark, cx).expect("the dark palette parses");
		veyyon_desktop_app::init(cx);
	});
	let state = app.new(|_| AppState::new(Store::new()));
	state.update(app, |state, cx| state.apply(opened(), cx));
	let view_state = state.clone();
	let (_, cx) = app.add_window_view(|window, cx| ThreadView::new(view_state, window, cx));
	cx.simulate_resize(size(px(1000.0), px(600.0)));
	cx.run_until_parked();
	(state, cx)
}

fn apply(state: &Entity<AppState>, cx: &mut VisualTestContext, events: Vec<HostEvent>) {
	state.update(cx, |state, cx| state.apply(events, cx));
	cx.run_until_parked();
}

/// The text runs the last frame drew.
fn texts(cx: &mut VisualTestContext) -> Vec<String> {
	cx.update(|window, _| {
		window
			.rendered_text_runs()
			.iter()
			.map(|run| run.text.to_string())
			.collect()
	})
}

fn drew(cx: &mut VisualTestContext, text: &str) -> bool {
	texts(cx).iter().any(|run| run == text)
}

#[gpui::test]
fn the_header_states_the_extensions_statuses_one_space_apart_in_the_hosts_order(
	app: &mut TestAppContext,
) {
	let (state, cx) = thread(app);
	apply(&state, cx, vec![extension_ui(&[("a-tests", "tests 3/3"), ("b-lint", "lint ok")], None)]);
	assert!(drew(cx, "tests 3/3 lint ok"), "the statuses are drawn: {:?}", texts(cx));

	apply(&state, cx, vec![extension_ui(&[("b-lint", "lint failed")], None)]);
	assert!(drew(cx, "lint failed"), "a restated set replaces the last: {:?}", texts(cx));
	assert!(!texts(cx).iter().any(|run| run.contains("tests 3/3")), "a dropped status goes");

	apply(&state, cx, vec![extension_ui(&[], None)]);
	assert!(!texts(cx).iter().any(|run| run.contains("lint")), "an empty set draws nothing");
}

#[gpui::test]
fn an_extensions_working_message_replaces_the_tails_own_while_a_turn_streams(
	app: &mut TestAppContext,
) {
	let (state, cx) = thread(app);
	apply(&state, cx, vec![streamed("", None, 2)]);
	assert!(drew(cx, "Thinking…"), "a turn with no prose yet states it works: {:?}", texts(cx));

	// No stream frame follows: the section alone redraws the tail.
	apply(&state, cx, vec![extension_ui(&[], Some("Indexing the repo"))]);
	assert!(drew(cx, "Indexing the repo"), "the extension's message is drawn: {:?}", texts(cx));
	assert!(!drew(cx, "Thinking…"), "in place of the tail's own");

	apply(&state, cx, vec![streamed("", Some("bash"), 3)]);
	assert!(drew(cx, "Indexing the repo"), "a running tool keeps the extension's message");
	assert!(!drew(cx, "Running bash…"), "in place of the tool's line");

	apply(&state, cx, vec![extension_ui(&[], None)]);
	assert!(drew(cx, "Running bash…"), "a cleared message restores the tail's own: {:?}", texts(cx));
	assert!(!drew(cx, "Indexing the repo"));

	apply(&state, cx, vec![
		extension_ui(&[], Some("Indexing the repo")),
		streamed("Done.", None, 4),
	]);
	assert!(!drew(cx, "Indexing the repo"), "prose replaces working text, the extension's too");
}
