//! At the live edge the list follows a growing reply on a spring rather than
//! jumping to its end; a scroll by the reader ends the motion, and under
//! reduced motion the end shows at once.

use std::time::Duration;

use gpui::{Modifiers, ScrollDelta, ScrollWheelEvent, TestAppContext, TouchPhase, point, px};

use super::{Thread, thread};
use crate::stream::streamed;

/// `count` short paragraphs.
fn reply(count: usize) -> String {
	(0..count)
		.map(|ix| format!("Line {ix} of the reply."))
		.collect::<Vec<_>>()
		.join("\n\n")
}

impl Thread<'_> {
	/// How far the reply's end is drawn below the end of the list.
	fn behind(&mut self) -> f32 {
		let list = self.drawn("transcript");
		let tail = self.drawn("transcript.tail");
		f32::from(tail.bottom() - list.bottom())
	}

	/// A touchpad scroll of `dy` pixels over the transcript; positive
	/// scrolls back.
	fn wheel(&mut self, dy: f32) {
		let at = self.drawn("transcript").center();
		self.cx.simulate_event(ScrollWheelEvent {
			position:    at,
			delta:       ScrollDelta::Pixels(point(px(0.0), px(dy))),
			modifiers:   Modifiers::default(),
			touch_phase: TouchPhase::Moved,
		});
		self.cx.run_until_parked();
	}
}

#[gpui::test]
fn at_the_live_edge_a_growing_reply_is_followed_on_a_spring_and_then_rests(
	app: &mut TestAppContext,
) {
	let mut t = thread(app, 20, false);
	t.apply(vec![streamed(&reply(2), 2)]);
	t.settle(Duration::from_millis(600));
	assert!(t.behind().abs() < 0.5, "the reply's end is drawn at the list's end");

	t.apply(vec![streamed(&reply(20), 3)]);
	let mut behind = vec![t.behind()];
	assert!(behind[0] > 100.0, "part of the growth starts below the list's end: {behind:?}");
	let mut ran = Duration::ZERO;
	while t.frame() {
		ran += super::FRAME;
		assert!(ran <= Duration::from_millis(600), "the list still moves {ran:?} in: {behind:?}");
		behind.push(t.behind());
	}
	assert!(behind.len() > 3, "the list moves over frames: {behind:?}");
	for pair in behind.windows(2) {
		assert!(pair[1] <= pair[0] + 0.5, "the list only moves toward the end: {behind:?}");
	}
	assert!(t.behind().abs() < 0.5, "the list rests at the end: {behind:?}");
	assert!(!t.frame(), "a list at rest asks for no frame");
}

#[gpui::test]
fn a_scroll_by_the_reader_ends_the_follow_where_the_list_is(app: &mut TestAppContext) {
	let mut t = thread(app, 20, false);
	t.apply(vec![streamed(&reply(2), 2)]);
	t.settle(Duration::from_millis(600));
	t.apply(vec![streamed(&reply(20), 3)]);
	t.frame();
	let moving = t.behind();
	assert!(moving > 20.0, "mid-motion: {moving}");

	t.wheel(40.0);
	let held = t.behind();
	assert!(
		(held - (moving + 40.0)).abs() < 0.5,
		"the scroll moves from where the list was: {held} vs {moving}"
	);
	t.settle(Duration::from_millis(200));
	assert!((t.behind() - held).abs() < 0.5, "the list stays where the reader put it");
	assert!(!t.frame(), "no motion continues");
}

#[gpui::test]
fn under_reduced_motion_a_growing_reply_shows_its_end_at_once(app: &mut TestAppContext) {
	let mut t = thread(app, 20, true);
	t.apply(vec![streamed(&reply(2), 2)]);
	t.apply(vec![streamed(&reply(20), 3)]);
	assert!(t.behind().abs() < 0.5, "the end shows at once: {}", t.behind());
	assert!(!t.frame(), "no frame is asked for");
}
