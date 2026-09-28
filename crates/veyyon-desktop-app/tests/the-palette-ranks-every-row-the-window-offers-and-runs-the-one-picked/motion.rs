//! The card settles into place as it opens and fades out before it leaves,
//! asking for frames only while it moves; under reduced motion it arrives and
//! leaves at once and asks for none.

use std::time::Duration;

use gpui::{Pixels, TestAppContext, px};
use veyyon_desktop_ui::theme::space;

use super::{
	harness::{WINDOW, Win, seeded, window},
	near,
};

/// One frame at 60 Hz.
const FRAME: Duration = Duration::from_millis(16);

impl Win<'_> {
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
			assert!(ran <= bound, "the card still moves {ran:?} in");
		}
		ran
	}

	fn top(&mut self) -> Option<Pixels> {
		self.bounds("palette").map(|card| card.origin.y)
	}
}

/// Where the card's top rests.
fn rest() -> Pixels {
	px(WINDOW.1 * 0.18)
}

#[gpui::test]
fn the_card_settles_into_place_as_it_opens_and_fades_out_before_it_leaves(
	app: &mut TestAppContext,
) {
	let mut w = window(app, seeded(), false);
	w.open();
	let first = w.top().expect("the opening card is laid out");
	assert!(near(first, rest() - space::S1), "the card starts at {first:?}");
	let opened = w.settle(Duration::from_millis(400));
	assert!(opened >= Duration::from_millis(96), "the card moved for {opened:?}");
	assert!(opened <= Duration::from_millis(160), "the card moved for {opened:?}");
	let top = w.top().expect("the open card is laid out");
	assert!(near(top, rest()), "the card rests at {top:?}");
	assert!(!w.frame(), "a card at rest asks for no frame");

	w.keys("escape");
	assert!(!w.is_open() && !w.layout().palette_open, "a closing palette takes no input");
	assert!(w.top().is_some(), "the card is drawn while it fades out");
	let closed = w.settle(Duration::from_millis(400));
	assert!(closed >= Duration::from_millis(64), "the card faded for {closed:?}");
	assert!(closed <= Duration::from_millis(128), "the card faded for {closed:?}");
	assert_eq!(w.bounds("palette"), None, "the card leaves once it has faded");
	assert!(!w.frame(), "a closed palette asks for no frame");
}

#[gpui::test]
fn under_reduced_motion_the_card_arrives_and_leaves_at_once(app: &mut TestAppContext) {
	let mut w = window(app, seeded(), true);
	w.open();
	let top = w.top().expect("the card is laid out");
	assert!(near(top, rest()), "the card arrives at {top:?}");
	assert!(!w.frame(), "no frame is asked for");
	w.keys("escape");
	assert!(!w.is_open());
	assert_eq!(w.bounds("palette"), None, "the card leaves at once");
	assert!(!w.frame(), "no frame is asked for");
}
