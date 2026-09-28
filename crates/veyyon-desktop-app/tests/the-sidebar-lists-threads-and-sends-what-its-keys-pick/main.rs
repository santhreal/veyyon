//! The sidebar lists the host's threads by project, sends what its keys
//! pick, and renders only for the events it draws.
//!
//! WHY: the sidebar re-renders on store events. A sidebar notified for every
//! streamed delta costs one render per token while nothing it draws changed
//! (CONTRACT §2.9), and a key handler that reads the wrong list line opens or
//! deletes a thread other than the one the row shows as selected. The suite
//! drives the real `Sidebar` over a real `AppState` fed host events.
//!
//! Gap: pointer paths (row clicks, the row and profile menus) and the drawn
//! pixels are not asserted here.

use std::collections::HashSet;

use gpui::{AppContext as _, Entity, Focusable as _, TestAppContext, VisualTestContext};
use veyyon_desktop_app::{
	AppState,
	actions::sidebar::{DeleteSelected, OpenSelected, SelectNext, SelectPrev},
	sidebar::{
		Sidebar,
		model::{Item, visible_items},
	},
};
use veyyon_desktop_model::{
	EntryId, HostAction, HostEvent, MessageRole, SessionHeaderView, SessionId, SessionStatus,
	SessionSummary, SnapshotSection, Store, StreamingMessageState, TranscriptEntry, Versioned,
};
use veyyon_desktop_ui::theme::{Appearance, Theme};

fn sid(id: &str) -> SessionId {
	SessionId::from(id)
}

fn entry(id: &str, parent: Option<&str>, revision: u64) -> TranscriptEntry {
	TranscriptEntry {
		id: EntryId::from(id),
		parent: parent.map(EntryId::from),
		revision,
		timestamp_ms: revision,
		role: MessageRole::Assistant,
		content: Vec::new(),
		meta: None,
		raw_discriminator: String::new(),
		raw: serde_json::Value::Null,
	}
}

fn summary(id: &str, cwd: &str, modified_at_ms: u64) -> SessionSummary {
	SessionSummary {
		id: sid(id),
		workspace: "ws-default".to_owned(),
		path: format!("/sessions/{id}.jsonl"),
		cwd: cwd.to_owned(),
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

/// The host listing `a` and `b` under `/w/alpha` and `c` under `/w/beta`,
/// then opening `a`.
fn seeded() -> Vec<HostEvent> {
	let header = SessionHeaderView {
		id:             sid("a"),
		schema_version: 1,
		title:          Some("title a".to_owned()),
		title_source:   None,
		parent:         None,
		created_at_ms:  0,
		cwd:            "/w/alpha".to_owned(),
		mode:           None,
	};
	vec![
		HostEvent::Snapshot(SnapshotSection::Sessions(
			Versioned {
				revision: 1,
				value:    vec![
					summary("a", "/w/alpha", 100),
					summary("b", "/w/alpha", 200),
					summary("c", "/w/beta", 50),
				],
			},
			Vec::new(),
		)),
		HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned { revision: 1, value: header })),
		HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
			revision: 1,
			value:    vec![entry("a-0", None, 1)],
		})),
	]
}

fn delta(revision: u64) -> HostEvent {
	HostEvent::StreamingChanged(Some(StreamingMessageState {
		entry: EntryId::from("a-1"),
		tool: None,
		accumulating: entry("a-1", Some("a-0"), revision),
		revision,
	}))
}

fn sidebar(app: &mut TestAppContext) -> (Entity<AppState>, Entity<Sidebar>, &mut VisualTestContext) {
	app.update(|cx| {
		Theme::install(Appearance::Dark, cx).expect("the dark palette parses");
		veyyon_desktop_app::init(cx);
	});
	let state = app.new(|_| AppState::new(Store::new()));
	state.update(app, |state, cx| state.apply(seeded(), cx));
	state.update(app, |state, _| state.drain_outbox());
	let view_state = state.clone();
	let (view, cx) = app.add_window_view(|window, cx| Sidebar::new(view_state, window, cx));
	cx.run_until_parked();
	(state, view, cx)
}

fn sent(state: &Entity<AppState>, cx: &mut VisualTestContext) -> Vec<HostAction> {
	state.update(cx, |state, _| {
		state.drain_outbox().into_iter().map(|request| request.action).collect()
	})
}

#[gpui::test]
fn a_streamed_turn_renders_the_sidebar_when_it_starts_and_never_per_delta(app: &mut TestAppContext) {
	let (state, view, cx) = sidebar(app);
	let before = view.read_with(cx, |view, _| view.render_count());
	assert!(before >= 1, "the sidebar drew its first frame");

	state.update(cx, |state, cx| state.apply(vec![delta(2)], cx));
	cx.run_until_parked();
	let started = view.read_with(cx, |view, _| view.render_count());
	assert_eq!(started, before + 1, "the running glyph appears once");

	for revision in 3..40 {
		state.update(cx, |state, cx| state.apply(vec![delta(revision)], cx));
		cx.run_until_parked();
	}
	assert_eq!(view.read_with(cx, |view, _| view.render_count()), started, "no render per delta");
}

#[gpui::test]
fn keys_move_the_selection_and_send_open_and_delete_for_the_selected_thread(
	app: &mut TestAppContext,
) {
	let (state, view, cx) = sidebar(app);
	cx.update(|window, cx| {
		let focus = view.focus_handle(cx);
		window.focus(&focus, cx);
	});

	// The list reads alpha: b, a; beta: c. `a` is open and selected.
	cx.dispatch_action(SelectPrev);
	cx.dispatch_action(OpenSelected);
	cx.run_until_parked();
	assert_eq!(sent(&state, cx), vec![HostAction::OpenSession { session: sid("b") }]);

	cx.dispatch_action(SelectNext);
	cx.dispatch_action(SelectNext);
	cx.dispatch_action(SelectNext);
	cx.dispatch_action(DeleteSelected);
	cx.run_until_parked();
	assert_eq!(sent(&state, cx), Vec::<HostAction>::new(), "delete waits for its confirmation");
	cx.dispatch_action(OpenSelected);
	cx.run_until_parked();
	assert_eq!(sent(&state, cx), vec![HostAction::DeleteSession { session: sid("c") }]);
}

#[gpui::test]
fn the_filter_lists_matching_threads_under_their_projects_even_when_collapsed(
	app: &mut TestAppContext,
) {
	let state = app.new(|_| AppState::new(Store::new()));
	state.update(app, |state, cx| state.apply(seeded(), cx));
	state.read_with(app, |state, _| {
		let projects = state.projects();
		let collapsed: HashSet<String> = HashSet::from(["/w/alpha".to_owned()]);
		assert_eq!(visible_items(projects, &collapsed, ""), vec![
			Item::Project(0),
			Item::Project(1),
			Item::Session { project: 1, row: 0 },
		]);
		assert_eq!(visible_items(projects, &collapsed, "title a"), vec![
			Item::Project(0),
			Item::Session { project: 0, row: 1 },
		]);
		assert_eq!(visible_items(projects, &HashSet::new(), "nothing"), Vec::<Item>::new());
	});
}
