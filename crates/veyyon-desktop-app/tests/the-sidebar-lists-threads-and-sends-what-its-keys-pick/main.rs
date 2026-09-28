//! The sidebar lists the host's threads by project and block, sends what its
//! keys pick, and renders only for the events it draws.
//!
//! WHY: the sidebar re-renders on store events. A sidebar notified for every
//! streamed delta costs one render per token while nothing it draws changed,
//! and a key handler that reads the wrong list line opens, deletes, pins or
//! folds a thread other than the one the row shows as selected. A thread
//! placed in a block, holding an unsent prompt, or folded under its parent
//! that is listed in the wrong place, or twice, or not at all, is a thread
//! the operator cannot find, and a fold kept in the view rather than the
//! store is lost when the window reopens. The suite drives the real `Sidebar`
//! over a real `AppState` fed host events.
//!
//! Gap: clicks on thread rows and the drawn pixels are not asserted; the
//! pointer paths `pointer` drives name their own gaps. The store is asserted,
//! not the file the window writes it to.

mod folds;
mod motion;
mod pointer;

use gpui::{AppContext as _, Entity, Focusable as _, TestAppContext, VisualTestContext};
use veyyon_desktop_app::{
	AppState,
	actions::sidebar::{
		DeleteSelected, OpenSelected, SelectNext, SelectPrev, ToggleArchiveSelected,
		ToggleDeferSelected, TogglePinSelected,
	},
	sidebar::{
		Sidebar,
		listing::{Block, Branches, Item, Listing},
	},
};
use veyyon_desktop_model::{
	ComposerStore, EntryId, HostAction, HostEvent, MessageRole, QueuePartition, SessionHeaderView,
	SessionId, SessionStatus, SessionSummary, SnapshotSection, Store, StreamingMessageState,
	TranscriptEntry, Versioned,
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

fn summary(id: &str, cwd: &str, modified_at_ms: u64, parent: Option<&str>) -> SessionSummary {
	SessionSummary {
		id: sid(id),
		workspace: "ws-default".to_owned(),
		path: format!("/sessions/{id}.jsonl"),
		cwd: cwd.to_owned(),
		title: Some(format!("title {id}")),
		parent_path: parent.map(|parent| format!("/sessions/{parent}.jsonl")),
		created_at_ms: 0,
		modified_at_ms,
		message_count: 1,
		size_bytes: 1,
		first_message: None,
		searchable_messages: None,
		status: SessionStatus::Complete,
	}
}

const fn listing(summaries: Vec<SessionSummary>) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Sessions(
		Versioned { revision: 1, value: summaries },
		Vec::new(),
	))
}

/// The host opening `id`, which runs under `cwd`.
fn opened(id: &str, cwd: &str) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
		revision: 1,
		value:    SessionHeaderView {
			id:             sid(id),
			schema_version: 1,
			title:          Some(format!("title {id}")),
			title_source:   None,
			parent:         None,
			created_at_ms:  0,
			cwd:            cwd.to_owned(),
			mode:           None,
		},
	}))
}

/// The host listing `a` and `b` under `/w/alpha` and `c` under `/w/beta`,
/// then opening `a`. The list reads alpha: b, a; beta: c.
fn seeded() -> Vec<HostEvent> {
	vec![
		listing(vec![
			summary("a", "/w/alpha", 100, None),
			summary("b", "/w/alpha", 200, None),
			summary("c", "/w/beta", 50, None),
		]),
		opened("a", "/w/alpha"),
		HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
			revision: 1,
			value:    vec![entry("a-0", None, 1)],
		})),
	]
}

/// `r` under `/w/alpha`, its branch `r1`, and `r2` branched from `r1`.
fn branched() -> Vec<HostEvent> {
	vec![listing(vec![
		summary("r", "/w/alpha", 300, None),
		summary("r1", "/w/alpha", 250, Some("r")),
		summary("r2", "/w/alpha", 240, Some("r1")),
	])]
}

fn delta(revision: u64) -> HostEvent {
	HostEvent::StreamingChanged(Some(StreamingMessageState {
		entry: EntryId::from("a-1"),
		tool: None,
		accumulating: entry("a-1", Some("a-0"), revision),
		revision,
	}))
}

fn sidebar(
	app: &mut TestAppContext,
	events: Vec<HostEvent>,
) -> (Entity<AppState>, Entity<Sidebar>, &mut VisualTestContext) {
	sidebar_over(app, Store::new(), events)
}

/// The sidebar over `store`, as a window reopens it, fed `events`.
fn sidebar_over(
	app: &mut TestAppContext,
	store: Store,
	events: Vec<HostEvent>,
) -> (Entity<AppState>, Entity<Sidebar>, &mut VisualTestContext) {
	app.update(|cx| {
		Theme::install(Appearance::Dark, cx).expect("the dark palette parses");
		veyyon_desktop_app::init(cx);
		veyyon_desktop_app::keymap::install(cx).expect("the default keymap parses");
	});
	let state = app.new(|_| AppState::new(store));
	state.update(app, |state, cx| state.apply(events, cx));
	state.update(app, |state, _| state.drain_outbox());
	let view_state = state.clone();
	let (view, cx) = app.add_window_view(|window, cx| Sidebar::new(view_state, window, cx));
	cx.update(|window, cx| {
		let focus = view.focus_handle(cx);
		window.focus(&focus, cx);
	});
	cx.run_until_parked();
	(state, view, cx)
}

fn sent(state: &Entity<AppState>, cx: &mut VisualTestContext) -> Vec<HostAction> {
	state.update(cx, |state, _| {
		state
			.drain_outbox()
			.into_iter()
			.map(|request| request.action)
			.collect()
	})
}

fn items(view: &Entity<Sidebar>, cx: &VisualTestContext) -> Vec<Item> {
	view.read_with(cx, |view, _| view.items().to_vec())
}

/// A thread row at `depth` with `branches`.
const fn row(project: usize, row: usize, depth: usize, branches: Branches) -> Item {
	Item::Session { project, row, depth, branches }
}

/// A thread row with no branches, not inset.
const fn leaf(project: usize, at: usize) -> Item {
	row(project, at, 0, Branches::None)
}

/// The lines of `state` listed with `collapsed` projects, `folded` threads
/// and `query`; the folds are undone after.
fn lines(state: &mut AppState, collapsed: &[&str], folded: &[&str], query: &str) -> Vec<Item> {
	let toggle = |state: &mut AppState| {
		for path in collapsed {
			state.toggle_project(path);
		}
		for session in folded {
			state.toggle_branches(&sid(session));
		}
	};
	toggle(state);
	let lines = Listing { app: state, query }.items();
	toggle(state);
	lines
}

#[gpui::test]
fn a_streamed_turn_renders_the_sidebar_when_it_starts_and_never_per_delta(
	app: &mut TestAppContext,
) {
	let (state, view, cx) = sidebar(app, seeded());
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
	let (state, _view, cx) = sidebar(app, seeded());
	// `a` is open and selected.
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
	state.update(app, |state, _| {
		assert_eq!(lines(state, &["/w/alpha"], &[], ""), vec![
			Item::Project(0),
			Item::Project(1),
			leaf(1, 0),
		]);
		assert_eq!(lines(state, &["/w/alpha"], &[], "title a"), vec![Item::Project(0), leaf(0, 1)]);
		assert_eq!(lines(state, &[], &[], "nothing"), Vec::<Item>::new());
	});
}

#[gpui::test]
fn placement_keys_move_the_selected_thread_into_its_block_and_back_without_the_host(
	app: &mut TestAppContext,
) {
	let (state, view, cx) = sidebar(app, seeded());
	let listed = vec![Item::Project(0), leaf(0, 0), leaf(0, 1), Item::Project(1), leaf(1, 0)];
	assert_eq!(items(&view, cx), listed);

	// `a` is selected.
	cx.dispatch_action(TogglePinSelected);
	cx.run_until_parked();
	assert_eq!(items(&view, cx), vec![
		Item::Block { block: Block::Pinned, count: 1 },
		leaf(0, 1),
		Item::Project(0),
		leaf(0, 0),
		Item::Project(1),
		leaf(1, 0),
	]);
	cx.dispatch_action(TogglePinSelected);
	cx.run_until_parked();
	assert_eq!(items(&view, cx), listed, "a second press unpins");

	cx.dispatch_action(ToggleDeferSelected);
	cx.run_until_parked();
	assert_eq!(items(&view, cx), vec![
		Item::Project(0),
		leaf(0, 0),
		Item::Project(1),
		leaf(1, 0),
		Item::Block { block: Block::Deferred, count: 1 },
		leaf(0, 1),
	]);

	cx.dispatch_action(ToggleArchiveSelected);
	cx.run_until_parked();
	assert_eq!(items(&view, cx), vec![
		Item::Project(0),
		leaf(0, 0),
		Item::Project(1),
		leaf(1, 0),
		Item::Block { block: Block::Archived, count: 1 },
		leaf(0, 1),
	]);
	assert_eq!(state.read_with(cx, |state, _| state.partition(&sid("a"))), QueuePartition::Parked);
	cx.dispatch_action(ToggleArchiveSelected);
	cx.run_until_parked();
	assert_eq!(items(&view, cx), listed, "a second press restores");
	assert_eq!(sent(&state, cx), Vec::<HostAction>::new(), "a placement stays in the window");
}

#[gpui::test]
fn a_thread_holding_an_unsent_prompt_is_listed_under_unsent_once_another_is_open(
	app: &mut TestAppContext,
) {
	let (state, view, cx) = sidebar(app, seeded());
	let draft =
		|text: &str| ComposerStore { draft_text: text.to_owned(), ..ComposerStore::default() };
	state.update(cx, |state, _| {
		state.save_draft(sid("a"), draft("half a prompt"));
		state.save_draft(sid("c"), draft("  \n"));
	});
	assert_eq!(
		state.update(cx, |state, _| lines(state, &[], &[], "")),
		vec![Item::Project(0), leaf(0, 0), leaf(0, 1), Item::Project(1), leaf(1, 0)],
		"the open thread's own draft is not unsent"
	);

	cx.dispatch_action(SelectPrev);
	cx.dispatch_action(OpenSelected);
	cx.run_until_parked();
	assert_eq!(items(&view, cx), vec![
		Item::Block { block: Block::Unsent, count: 1 },
		leaf(0, 1),
		Item::Project(0),
		leaf(0, 0),
		Item::Project(1),
		leaf(1, 0),
	]);
}
