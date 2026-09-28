//! The transcript moves only what is new to the reader, and asks for no
//! frame once nothing moves: an entry that lands while the thread is open
//! rises into place and fades in, a streamed run is drawn visible on its
//! first frame and fades the rest of the way in, the list at the live edge
//! follows a growing reply on a spring until the reader scrolls, and
//! everything else is drawn at rest.
//!
//! WHY: an entry drawn because the thread opened, because the host revised
//! or resent it, or because the tail already drew its prose is not new, and
//! moving it reads as the transcript changing under the reader. A streamed
//! run that starts transparent paints its first frame empty, which adds a
//! frame to every token's latency. A value that never reaches rest asks for
//! frames forever, which is idle CPU. Under reduced motion nothing moves.
//! The suite drives the real `ThreadView` over an `AppState` fed host events
//! and reads where the driver saw each entry laid out, the stops the tail
//! drew its runs with and whether any frame was asked for.
//!
//! Gap: glyph colors are not read, so a stop's opacity is proven by the stop
//! the tail drew with, not by the pixels it painted.

mod follow;
mod stream;

use std::time::Duration;

use gpui::{AppContext as _, Bounds, Entity, Pixels, TestAppContext, VisualTestContext, px, size};
use veyyon_desktop_app::{AppState, driver, thread::ThreadView, transcript::Transcript};
use veyyon_desktop_model::{
	ContentBlock, EntryId, HostEvent, MessageRole, SessionHeaderView, SessionId, SnapshotSection,
	Store, TranscriptEntry, Versioned,
};
use veyyon_desktop_ui::theme::{Appearance, Theme};

/// The window the thread is drawn in.
const WINDOW: (f32, f32) = (1000.0, 800.0);

/// One frame at 60 Hz.
const FRAME: Duration = Duration::from_millis(16);

/// How far below its place an arriving entry starts.
const RISE: f32 = 6.0;

fn entry(id: &str, parent: Option<&str>, role: MessageRole, text: &str) -> TranscriptEntry {
	TranscriptEntry {
		id: EntryId::from(id),
		parent: parent.map(EntryId::from),
		revision: 1,
		timestamp_ms: 1,
		role,
		content: vec![ContentBlock::Text { text: text.to_owned() }],
		meta: None,
		raw_discriminator: String::new(),
		raw: serde_json::Value::Null,
	}
}

/// Entries `s-0` to `s-{count-1}`, chained, alternating the operator and
/// the agent and ending on the operator's prompt.
fn prior(count: usize) -> Vec<TranscriptEntry> {
	(0..count)
		.map(|ix| {
			let role = if (count - ix) % 2 == 1 {
				MessageRole::User
			} else {
				MessageRole::Assistant
			};
			let parent = ix.checked_sub(1).map(|up| format!("s-{up}"));
			entry(&format!("s-{ix}"), parent.as_deref(), role, &format!("Entry {ix}."))
		})
		.collect()
}

/// The host sending session `s`'s transcript whole.
const fn whole(revision: u64, entries: Vec<TranscriptEntry>) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Transcript(Versioned { revision, value: entries }))
}

/// Session `s` active with `entries`.
fn opened(entries: Vec<TranscriptEntry>) -> Vec<HostEvent> {
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
		whole(1, entries),
	]
}

/// The thread of session `s`, drawn in a window.
struct Thread<'a> {
	state:      Entity<AppState>,
	transcript: Entity<Transcript>,
	cx:         &'a mut VisualTestContext,
}

/// Opens session `s` holding `prior(count)`, with motion reduced when
/// `reduced` is set.
fn thread(app: &mut TestAppContext, count: usize, reduced: bool) -> Thread<'_> {
	driver::enable();
	app.update(|cx| {
		Theme::install(Appearance::Dark, cx).expect("the dark palette parses");
		veyyon_desktop_app::init(cx);
		cx.set_reduce_motion(reduced);
	});
	let state = app.new(|_| AppState::new(Store::new()));
	state.update(app, |state, cx| state.apply(opened(prior(count)), cx));
	let view_state = state.clone();
	let (view, cx) = app.add_window_view(|window, cx| ThreadView::new(view_state, window, cx));
	cx.simulate_resize(size(px(WINDOW.0), px(WINDOW.1)));
	cx.run_until_parked();
	let transcript = view.read_with(cx, |view, _| view.transcript().clone());
	Thread { state, transcript, cx }
}

impl Thread<'_> {
	fn apply(&mut self, events: Vec<HostEvent>) {
		self
			.state
			.update(self.cx, |state, cx| state.apply(events, cx));
		self.cx.run_until_parked();
	}

	/// Moves the clock a frame on and delivers the frame the window asked
	/// for. Answers whether anything asked for one.
	fn frame(&mut self) -> bool {
		self.cx.executor().advance_clock(FRAME);
		let asked = self.cx.update(|window, cx| window.simulate_next_frame(cx));
		self.cx.run_until_parked();
		asked > 0
	}

	/// Delivers frames until none is asked for, failing past `bound`, and
	/// answers how long the motion ran.
	fn settle(&mut self, bound: Duration) -> Duration {
		let mut ran = Duration::ZERO;
		while self.frame() {
			ran += FRAME;
			assert!(ran <= bound, "the transcript still moves {ran:?} in");
		}
		ran
	}

	/// Where the driver last saw `id` laid out.
	fn drawn(&mut self, id: &str) -> Bounds<Pixels> {
		self
			.cx
			.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), id))
			.unwrap_or_else(|| panic!("`{id}` was laid out"))
	}

	/// The top of entry `id` as last drawn.
	fn top(&mut self, id: &str) -> f32 {
		f32::from(self.drawn(&format!("transcript.entry:{id}")).top())
	}

	/// How far entry `id` is drawn below entry `above`. The list follows its
	/// end on its own spring, which moves both alike.
	fn below(&mut self, id: &str, above: &str) -> f32 {
		self.top(id) - self.top(above)
	}
}

fn near(a: f32, b: f32) -> bool {
	(a - b).abs() < 0.5
}

#[gpui::test]
fn an_opened_thread_draws_its_entries_at_rest_and_asks_for_no_frame(app: &mut TestAppContext) {
	let mut t = thread(app, 3, false);
	assert!(!t.frame(), "an opened thread asks for no frame");
	let top = t.top("s-2");
	assert!(!t.frame());
	assert!(near(t.top("s-2"), top), "the last entry rests where it was drawn");
}

#[gpui::test]
fn an_entry_that_lands_while_the_thread_is_open_rises_into_place_and_then_rests(
	app: &mut TestAppContext,
) {
	let mut t = thread(app, 2, false);
	t.apply(vec![HostEvent::TranscriptAppended {
		revision: 2,
		entries:  vec![entry("s-2", Some("s-1"), MessageRole::User, "A new prompt.")],
	}]);
	let mut below = vec![t.below("s-2", "s-1")];
	let mut ran = Duration::ZERO;
	while t.frame() {
		ran += FRAME;
		assert!(
			ran <= Duration::from_millis(600),
			"the transcript still moves {ran:?} in: {below:?}"
		);
		below.push(t.below("s-2", "s-1"));
	}
	let rest = t.below("s-2", "s-1");
	assert!(near(below[0] - rest, RISE), "the entry starts {RISE} px below its place: {below:?}");
	for pair in below.windows(2) {
		assert!(pair[1] <= pair[0] + 0.01, "the entry only rises: {below:?}");
	}
	assert!(below.len() > 10, "frames run until 160 ms: {below:?}");
	// 16 ms into a 160 ms ease-out the entry is still 3.6 px low; a shorter
	// reveal is nearer its place, a longer or a linear one further.
	assert!(
		(3.0..4.25).contains(&(below[1] - rest)),
		"the entry rises over frames on the reveal curve: {below:?}"
	);
	assert!(near(below[10], rest), "the entry rests by 160 ms: {below:?}");
	assert!(!t.frame(), "an entry at rest asks for no frame");
}

#[gpui::test]
fn under_reduced_motion_an_entry_that_lands_is_drawn_at_rest_at_once(app: &mut TestAppContext) {
	let mut t = thread(app, 2, true);
	t.apply(vec![HostEvent::TranscriptAppended {
		revision: 2,
		entries:  vec![entry("s-2", Some("s-1"), MessageRole::User, "A new prompt.")],
	}]);
	let first = t.top("s-2");
	assert!(!t.frame(), "no frame is asked for");
	assert!(near(t.top("s-2"), first), "the entry lands where it rests");
}

#[gpui::test]
fn an_entry_the_host_revises_or_resends_whole_is_drawn_at_rest(app: &mut TestAppContext) {
	let mut t = thread(app, 2, false);
	let top = t.top("s-1");
	t.apply(vec![HostEvent::TranscriptUpdated {
		revision: 2,
		entry:    TranscriptEntry {
			revision: 2,
			..entry("s-1", Some("s-0"), MessageRole::User, "Entry 1, revised.")
		},
	}]);
	assert!(!t.frame(), "a revised entry asks for no frame");
	assert!(near(t.top("s-1"), top), "a revised entry stays in place");

	let mut entries = prior(2);
	entries.push(entry("s-2", Some("s-1"), MessageRole::Assistant, "Sent with the rest."));
	t.apply(vec![whole(3, entries)]);
	let sent = t.top("s-2");
	assert!(!t.frame(), "a transcript sent whole asks for no frame");
	assert!(near(t.top("s-2"), sent), "an entry sent with the rest is drawn at rest");
}
