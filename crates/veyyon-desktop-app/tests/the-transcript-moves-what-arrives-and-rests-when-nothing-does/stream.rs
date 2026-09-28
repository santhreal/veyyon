//! A streamed run is drawn visible on its first frame and fades the rest of
//! the way in; the reply the tail drew lands at rest when its entry commits.

use std::time::Duration;

use gpui::TestAppContext;
use veyyon_desktop_model::{EntryId, HostEvent, MessageRole, StreamingMessageState};
use veyyon_desktop_ui::markdown::FadeStop;

use super::{Thread, entry, near, thread};

/// The opacity a streamed run is first drawn at: visible, so the frame after
/// a token already paints it.
const FIRST: f32 = 0.4;

/// The agent's reply so far, as the host streams it.
pub fn streamed(text: &str, revision: u64) -> HostEvent {
	HostEvent::StreamingChanged(Some(StreamingMessageState {
		entry: EntryId::from("stream-1"),
		tool: None,
		accumulating: entry("stream-1", None, MessageRole::Assistant, text),
		revision,
	}))
}

/// The reply committed as entry `s-2`.
fn committed(text: &str, revision: u64) -> HostEvent {
	HostEvent::TranscriptAppended {
		revision,
		entries: vec![entry("s-2", Some("s-1"), MessageRole::Assistant, text)],
	}
}

impl Thread<'_> {
	/// The stops the tail last drew its runs with.
	fn stops(&self) -> Vec<FadeStop> {
		self
			.transcript
			.read_with(&*self.cx, |t, cx| t.tail().read(cx).fade_stops().to_vec())
	}

	fn drew(&mut self, text: &str) -> bool {
		self.cx.update(|window, _| {
			window
				.rendered_text_runs()
				.iter()
				.any(|run| run.text.as_ref() == text)
		})
	}
}

#[gpui::test]
fn a_streamed_run_is_drawn_visible_on_its_first_frame_and_fades_in(app: &mut TestAppContext) {
	let mut t = thread(app, 2, false);
	t.apply(vec![streamed("Hello", 2)]);
	assert!(t.drew("Hello"), "the first frame draws the first run");
	let stops = t.stops();
	assert_eq!(stops.len(), 1, "one run fades: {stops:?}");
	assert_eq!(stops[0].start, 0);
	assert!(
		(FIRST..1.0).contains(&stops[0].opacity),
		"the first run is drawn visible and still fading: {stops:?}"
	);

	assert!(t.frame(), "a fading run asks for the next frame");
	t.apply(vec![streamed("Hello world", 3)]);
	assert!(t.drew("Hello world"), "the frame after the token draws it");
	let stops = t.stops();
	assert_eq!(stops.len(), 2, "each run fades on its own: {stops:?}");
	assert!(stops[0].opacity > FIRST, "the older run has faded further: {stops:?}");
	assert_eq!(stops[1].start, "Hello".len(), "the new run starts where the old one ended");
	assert!(
		(FIRST..1.0).contains(&stops[1].opacity),
		"the new run is drawn visible and still fading: {stops:?}"
	);

	// The list follows the growing reply on its own spring, so the fade is
	// timed by the stops the tail draws rather than by the frames asked for.
	let mut faded = Duration::ZERO;
	while !t.stops().is_empty() {
		assert!(t.frame(), "a fading run asks for the next frame: {:?}", t.stops());
		faded += super::FRAME;
		assert!(faded <= Duration::from_millis(300), "the runs still fade: {:?}", t.stops());
	}
	assert!(faded >= Duration::from_millis(96), "the runs faded for {faded:?}");
	assert!(faded <= Duration::from_millis(144), "the runs faded for {faded:?}");
	assert!(t.drew("Hello world"));
	t.settle(Duration::from_millis(600));
	assert!(!t.frame(), "a reply at rest asks for no frame");
}

#[gpui::test]
fn under_reduced_motion_a_streamed_run_is_drawn_opaque_at_once(app: &mut TestAppContext) {
	let mut t = thread(app, 2, true);
	t.apply(vec![streamed("Hello", 2)]);
	assert!(t.drew("Hello"));
	assert!(t.stops().is_empty(), "nothing fades");
	assert!(!t.frame(), "no frame is asked for");
}

/// How the end of the stream and the committed entry reach the window.
#[derive(Debug, Clone, Copy)]
enum Commit {
	OneBatch,
	EndThenEntry,
	EntryThenEnd,
}

fn the_reply_the_tail_drew_lands_at_rest(app: &mut TestAppContext, order: Commit) {
	let mut t = thread(app, 2, false);
	t.apply(vec![streamed("The reply.", 2)]);
	t.settle(Duration::from_millis(600));
	let drawn = f32::from(t.drawn("transcript.tail").top()) - t.top("s-1");
	let end = HostEvent::StreamingChanged(None);
	let entry = committed("The reply.", 3);
	match order {
		Commit::OneBatch => t.apply(vec![end, entry]),
		Commit::EndThenEntry => {
			t.apply(vec![end]);
			t.apply(vec![entry]);
		},
		Commit::EntryThenEnd => {
			t.apply(vec![entry]);
			t.apply(vec![end]);
		},
	}
	// The entry may be taller than the tail, and the list then follows its
	// new end on its own spring, which moves both entries alike.
	let placed = t.below("s-2", "s-1");
	assert!(near(placed, drawn), "{order:?}: the entry takes the reply's place");
	let mut ran = Duration::ZERO;
	while t.frame() {
		ran += super::FRAME;
		assert!(ran <= Duration::from_millis(600), "{order:?}: the list still moves {ran:?} in");
		assert!(near(t.below("s-2", "s-1"), placed), "{order:?}: the entry does not rise");
	}
	assert!(near(t.below("s-2", "s-1"), placed), "{order:?}: the entry rests there");
}

#[gpui::test]
fn the_reply_the_tail_drew_lands_at_rest_when_both_arrive_together(app: &mut TestAppContext) {
	the_reply_the_tail_drew_lands_at_rest(app, Commit::OneBatch);
}

#[gpui::test]
fn the_reply_the_tail_drew_lands_at_rest_when_the_stream_ends_first(app: &mut TestAppContext) {
	the_reply_the_tail_drew_lands_at_rest(app, Commit::EndThenEntry);
}

#[gpui::test]
fn the_reply_the_tail_drew_lands_at_rest_when_the_entry_comes_first(app: &mut TestAppContext) {
	the_reply_the_tail_drew_lands_at_rest(app, Commit::EntryThenEnd);
}
