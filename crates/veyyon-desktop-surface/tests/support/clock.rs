//! The test executor's clock, moved forward by hand, so a suite samples motion
//! at the instants it states rather than at the wall clock's.
#![allow(dead_code, reason = "each test binary uses a subset of the clock")]

use std::time::Duration;

use veyyon_desktop_surface::transcript::TranscriptViewportState;
use veyyon_gpui::{
	Bounds, HeadlessAppContext, TestAppContext,
	motion::{Advance, FrameInstant, MotionDriver, MotionPolicy, MotionTokens, REDUCED_FADE_MS},
};

/// The test executor's clock, moved forward by hand.
pub struct Clock {
	cx:      TestAppContext,
	elapsed: Duration,
}

impl Clock {
	/// A clock at its first instant.
	pub fn start() -> Self {
		Self { cx: TestAppContext::single(), elapsed: Duration::ZERO }
	}

	/// The instant `ms` milliseconds after the clock started. Time only moves
	/// forward.
	pub fn at(&mut self, ms: u64) -> FrameInstant {
		let target = Duration::from_millis(ms);
		let step = target
			.checked_sub(self.elapsed)
			.unwrap_or_else(|| panic!("the clock does not move back to {ms} ms"));
		self.cx.executor().advance_clock(step);
		self.elapsed = target;
		self.cx.read(|cx| cx.frame_instant())
	}

	/// Brings `motion` to a frame at the current instant and returns whether
	/// it is still moving, which is whether the frame requests another.
	pub fn advance(&self, motion: &mut impl Advance) -> bool {
		self.cx.update(|cx| {
			let mut driver = MotionDriver::default();
			let mut frame = driver.begin(cx);
			frame.track_within(motion, Bounds::default())
		})
	}
}

/// Expands block `block` of turn `turn` under reduced motion at `cx`'s current
/// instant and runs the reduced fade to its end on `cx`'s clock, so the next
/// frame draws the block at rest at its own height.
pub fn expand_at_rest(
	cx: &mut HeadlessAppContext,
	state: &TranscriptViewportState,
	turn: usize,
	block: usize,
	tokens: &MotionTokens,
) {
	let start = cx.update(|app| app.frame_instant());
	state.set_block_expanded(turn, block, true, tokens, MotionPolicy::REDUCED, start);
	cx.advance_clock(Duration::from_millis(u64::from(REDUCED_FADE_MS)));
	let rest = cx.update(|app| app.frame_instant());
	assert!(!state.advance_to(rest), "the reduced reveal rests once its fade ends");
}
