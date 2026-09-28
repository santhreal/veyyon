//! A streamed reply is the transcript list's last item: a reply taller than
//! the thread scrolls to its first line, the list follows it while at the
//! bottom, and the committed entry takes its place without moving it.
//!
//! WHY: a tail drawn as a fixed sibling under the list grows past the window
//! once a reply is taller than the thread. The list shrinks to nothing, the
//! reply's end is drawn off the window and nothing scrolls. A tail inside the
//! list that is swapped for the committed entry by a list splice jumps the
//! reader to the entry's top when the scroll position was inside the reply.
//! A reply growing just below the view keeps the height it was last measured
//! at, so a wheel scroll down clamps to that stale end and snaps to the grown
//! reply's end instead of moving by the wheel's distance.
//! The suite drives the real `ThreadView` over an `AppState` fed host events
//! and reads where the driver targets were laid out.
//!
//! Gap: the reply's own fade and the tail spring are not asserted, and the
//! committed entry is assumed to draw its prose at the tail's height.

use gpui::{
	AppContext as _, Bounds, Entity, Modifiers, Pixels, Point, ScrollDelta, ScrollWheelEvent,
	TestAppContext, TouchPhase, VisualTestContext, point, px, size,
};
use veyyon_desktop_app::{AppState, driver, thread::ThreadView, transcript::Transcript};
use veyyon_desktop_model::{
	ContentBlock, EntryId, HostEvent, MessageRole, SessionHeaderView, SessionId, SnapshotSection,
	Store, StreamingMessageState, TranscriptEntry, Versioned,
};
use veyyon_desktop_ui::theme::{Appearance, Theme};

/// The window the thread is drawn in; the transcript is the height less
/// the thread header.
const WINDOW: (f32, f32) = (1000.0, 600.0);

fn entry(
	id: &str,
	parent: Option<&str>,
	role: MessageRole,
	text: &str,
	revision: u64,
) -> TranscriptEntry {
	TranscriptEntry {
		id: EntryId::from(id),
		parent: parent.map(EntryId::from),
		revision,
		timestamp_ms: revision,
		role,
		content: vec![ContentBlock::Text { text: text.to_owned() }],
		meta: None,
		raw_discriminator: String::new(),
		raw: serde_json::Value::Null,
	}
}

/// `count` short paragraphs, one markdown block each.
fn reply(count: usize) -> String {
	(0..count)
		.map(|ix| format!("Line {ix} of the reply."))
		.collect::<Vec<_>>()
		.join("\n\n")
}

/// Session `s` open with `prior` entries alternating the operator and the
/// agent, the last one the operator's prompt.
fn opened(prior: usize) -> Vec<HostEvent> {
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
	let entries = (0..prior)
		.map(|ix| {
			let role = if (prior - ix) % 2 == 1 {
				MessageRole::User
			} else {
				MessageRole::Assistant
			};
			let parent = ix.checked_sub(1).map(|up| format!("s-{up}"));
			entry(&format!("s-{ix}"), parent.as_deref(), role, &format!("Entry {ix}."), 1)
		})
		.collect();
	vec![
		HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
			revision: 1,
			value:    header,
		})),
		HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
			revision: 1,
			value:    entries,
		})),
	]
}

/// The agent's reply so far, as the host streams it.
fn streamed(text: &str, revision: u64) -> HostEvent {
	HostEvent::StreamingChanged(Some(StreamingMessageState {
		entry: EntryId::from("stream-1"),
		tool: None,
		accumulating: entry("stream-1", None, MessageRole::Assistant, text, revision),
		revision,
	}))
}

/// The reply committed as entry `id`, the child of `parent`.
fn committed(id: &str, parent: &str, text: &str, revision: u64) -> HostEvent {
	HostEvent::TranscriptAppended {
		revision,
		entries: vec![entry(id, Some(parent), MessageRole::Assistant, text, revision)],
	}
}

fn thread(
	app: &mut TestAppContext,
	prior: usize,
) -> (Entity<AppState>, Entity<Transcript>, &mut VisualTestContext) {
	driver::enable();
	app.update(|cx| {
		Theme::install(Appearance::Dark, cx).expect("the dark palette parses");
		veyyon_desktop_app::init(cx);
	});
	let state = app.new(|_| AppState::new(Store::new()));
	state.update(app, |state, cx| state.apply(opened(prior), cx));
	let view_state = state.clone();
	let (view, cx) = app.add_window_view(|window, cx| ThreadView::new(view_state, window, cx));
	cx.simulate_resize(size(px(WINDOW.0), px(WINDOW.1)));
	cx.run_until_parked();
	let transcript = view.read_with(cx, |view, _| view.transcript().clone());
	(state, transcript, cx)
}

fn apply(state: &Entity<AppState>, cx: &mut VisualTestContext, events: Vec<HostEvent>) {
	state.update(cx, |state, cx| state.apply(events, cx));
	cx.run_until_parked();
}

/// Where the driver last saw `id` laid out.
fn drawn(cx: &mut VisualTestContext, id: &str) -> Bounds<Pixels> {
	cx.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), id))
		.unwrap_or_else(|| panic!("`{id}` was laid out"))
}

/// A touchpad scroll of `dy` pixels over the transcript; positive scrolls up.
fn wheel(cx: &mut VisualTestContext, dy: f32) {
	let at: Point<Pixels> = drawn(cx, "transcript").center();
	cx.simulate_event(ScrollWheelEvent {
		position:    at,
		delta:       ScrollDelta::Pixels(point(px(0.0), px(dy))),
		modifiers:   Modifiers::default(),
		touch_phase: TouchPhase::Moved,
	});
	cx.run_until_parked();
}

fn close(a: Pixels, b: Pixels) -> bool {
	(f32::from(a) - f32::from(b)).abs() < 0.5
}

#[gpui::test]
fn a_reply_taller_than_the_thread_scrolls_to_its_first_line_and_is_followed_at_the_bottom(
	app: &mut TestAppContext,
) {
	let (state, transcript, cx) = thread(app, 2);
	apply(&state, cx, vec![streamed(&reply(80), 2)]);

	let list = drawn(cx, "transcript");
	let tail = drawn(cx, "transcript.tail");
	assert!(list.size.height > px(0.0), "the list keeps its height: {list:?}");
	assert!(list.bottom() <= px(WINDOW.1), "the list stays in the window: {list:?}");
	assert!(
		tail.size.height > list.size.height,
		"the reply is taller than the thread: {tail:?} in {list:?}"
	);
	assert!(
		close(tail.bottom(), list.bottom()),
		"at the bottom the reply's end is drawn: {tail:?} in {list:?}"
	);
	assert_eq!(transcript.read_with(cx, |t, _| t.item_count()), 3, "two entries and the tail");

	apply(&state, cx, vec![streamed(&reply(100), 3)]);
	let grown = drawn(cx, "transcript.tail");
	assert!(grown.size.height > tail.size.height, "the reply grew: {grown:?}");
	assert!(
		close(grown.bottom(), list.bottom()),
		"the list follows the growing reply: {grown:?} in {list:?}"
	);

	wheel(cx, 100_000.0);
	let top = drawn(cx, "transcript.tail");
	assert!(
		top.top() >= list.top() && top.top() < list.bottom(),
		"scrolled up, the reply's first line is in the list: {top:?} in {list:?}",
	);

	apply(&state, cx, vec![streamed(&reply(120), 4)]);
	let held = drawn(cx, "transcript.tail");
	assert!(
		close(held.top(), top.top()),
		"scrolled up, a delta leaves the reader in place: {held:?} vs {top:?}"
	);
}

#[gpui::test]
fn a_reply_growing_below_the_view_scrolls_by_the_wheel_rather_than_to_its_end(
	app: &mut TestAppContext,
) {
	let (state, _, cx) = thread(app, 40);
	apply(&state, cx, vec![streamed(&reply(2), 2)]);
	let list = drawn(cx, "transcript");
	let tail = drawn(cx, "transcript.tail");
	// Scroll up until the reply's top sits 40 px below the list: the reply is
	// off screen, where the list lays out ahead of a scroll.
	wheel(cx, f32::from(list.bottom() - tail.top()) + 40.0);
	let reading = drawn(cx, "transcript.entry:s-37");
	assert!(
		reading.top() >= list.top() && reading.bottom() <= list.bottom(),
		"an earlier entry is on screen: {reading:?} in {list:?}"
	);

	apply(&state, cx, vec![streamed(&reply(80), 3)]);
	let still = drawn(cx, "transcript.entry:s-37");
	assert!(close(still.top(), reading.top()), "the reply grew out of sight: {still:?}");

	wheel(cx, -200.0);
	let moved = drawn(cx, "transcript.entry:s-37");
	assert!(
		close(moved.top(), reading.top() - px(200.0)),
		"the wheel moves the view 200 px, not to the grown reply's end: {moved:?} vs {reading:?}"
	);
}

/// The orders the host's two frames can reach the window in when a reply
/// ends: the committed entry and the end of the stream.
#[derive(Debug, Clone, Copy)]
enum Commit {
	OneBatch,
	EndThenEntry,
	EntryThenEnd,
}

fn commit_keeps_the_reader_in_place(app: &mut TestAppContext, order: Commit) {
	let (state, transcript, cx) = thread(app, 2);
	let text = reply(80);
	apply(&state, cx, vec![streamed(&text, 2)]);
	wheel(cx, 100_000.0);
	let list = drawn(cx, "transcript");
	let start = drawn(cx, "transcript.tail");
	// Scroll until the reply's top sits 150 px above the list: the scroll
	// position is inside the reply.
	wheel(cx, -(f32::from(start.top() - list.top()) + 150.0));
	let reading = drawn(cx, "transcript.tail");
	assert!(
		close(reading.top(), list.top() - px(150.0)),
		"{order:?}: reading inside the reply: {reading:?}"
	);

	let end = HostEvent::StreamingChanged(None);
	let entry = committed("s-2", "s-1", &text, 5);
	match order {
		Commit::OneBatch => apply(&state, cx, vec![end, entry]),
		Commit::EndThenEntry => {
			apply(&state, cx, vec![end]);
			let held = drawn(cx, "transcript.tail");
			assert!(
				close(held.top(), reading.top()),
				"{order:?}: the ended reply stays drawn: {held:?}"
			);
			apply(&state, cx, vec![entry]);
		},
		Commit::EntryThenEnd => {
			apply(&state, cx, vec![entry]);
			apply(&state, cx, vec![end]);
		},
	}

	let landed = drawn(cx, "transcript.entry:s-2");
	assert!(
		close(landed.top(), reading.top()),
		"{order:?}: the entry takes the reply's place: {landed:?} vs {reading:?}"
	);
	assert_eq!(
		transcript.read_with(cx, |t, _| t.item_count()),
		3,
		"{order:?}: three entries, no tail"
	);
	assert_eq!(
		transcript.read_with(cx, |t, cx| t.tail().read(cx).text().to_owned()),
		"",
		"{order:?}: the tail let go"
	);
}

#[gpui::test]
fn the_committed_reply_takes_the_tails_place_when_both_arrive_together(app: &mut TestAppContext) {
	commit_keeps_the_reader_in_place(app, Commit::OneBatch);
}

#[gpui::test]
fn the_committed_reply_takes_the_tails_place_when_the_stream_ends_first(app: &mut TestAppContext) {
	commit_keeps_the_reader_in_place(app, Commit::EndThenEntry);
}

#[gpui::test]
fn the_committed_reply_takes_the_tails_place_when_the_entry_lands_first(app: &mut TestAppContext) {
	commit_keeps_the_reader_in_place(app, Commit::EntryThenEnd);
}

#[gpui::test]
fn a_streamed_reply_never_reparses_an_entry_and_draws_only_what_is_on_screen(
	app: &mut TestAppContext,
) {
	const PRIOR: usize = 200;
	const DELTAS: usize = 40;
	let (state, transcript, cx) = thread(app, PRIOR);
	apply(&state, cx, vec![streamed("Line", 2)]);
	let (parses, renders) = transcript.read_with(cx, |t, _| (t.parses(), t.item_renders()));
	let tail = transcript.read_with(cx, |t, cx| t.tail().read(cx).renders());

	let mut text = String::from("Line");
	let mut revision = 2;
	for _ in 0..DELTAS {
		text.push_str(" more");
		revision += 1;
		apply(&state, cx, vec![streamed(&text, revision)]);
	}

	let (after_parses, after_renders) =
		transcript.read_with(cx, |t, _| (t.parses(), t.item_renders()));
	assert_eq!(after_parses, parses, "no entry is parsed again while a reply streams");
	let per_delta = (after_renders - renders) / DELTAS;
	assert!(
		per_delta < 40,
		"a delta draws the entries on screen, not all {PRIOR}: {per_delta} per delta"
	);
	let tail_renders = transcript.read_with(cx, |t, cx| t.tail().read(cx).renders()) - tail;
	assert!(tail_renders >= DELTAS, "the tail draws every delta: {tail_renders}");
	assert_eq!(transcript.read_with(cx, |t, cx| t.tail().read(cx).text().to_owned()), text);
}
