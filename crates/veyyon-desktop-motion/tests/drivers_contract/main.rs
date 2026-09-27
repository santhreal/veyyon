//! Contracts of the motion drivers, sampled on the test executor's clock.
//!
//! WHY: a driver that never reaches rest keeps its view requesting frames
//! forever, and a driver that ignores reduced motion animates for an operator
//! who turned animation off. Both failures are invisible in a still frame.
//! `every_role_driver_comes_to_rest_within_its_bound` enumerates
//! `MotionRole::ALL` with an exhaustive match, so a role the framework adds
//! fails to compile here until a driver and a bound are stated for it.
//! `trajectories` pins each driver's trajectory, interruption and reduced
//! variant.
//!
//! It does not catch a surface that samples a driver but never tracks it on
//! its `MotionFrame`; the surface suites cover that.

use std::time::Duration;

use veyyon_desktop_motion::{
	CaretMotion, FloatMotion, PanelMotion, RevealMotion, ScrollMotion, ShiftMotion, TintMotion,
};
use veyyon_gpui::{
	Bounds, TestAppContext,
	motion::{Advance, FrameInstant, MotionDriver, MotionPolicy, MotionRole, MotionTokens},
};

const FULL: MotionPolicy = MotionPolicy::DEFAULT;
const REDUCED: MotionPolicy = MotionPolicy::REDUCED;

mod trajectories;

/// The test executor's clock, moved forward by hand.
struct Clock {
	cx:      TestAppContext,
	elapsed: Duration,
}

impl Clock {
	fn new() -> Self {
		Self { cx: TestAppContext::single(), elapsed: Duration::ZERO }
	}

	/// The instant `ms` milliseconds after the clock was made. Time only moves
	/// forward.
	fn at(&mut self, ms: u64) -> FrameInstant {
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
	fn advance(&self, motion: &mut impl Advance) -> bool {
		self.cx.update(|cx| {
			let mut driver = MotionDriver::default();
			let mut frame = driver.begin(cx);
			frame.track_within(motion, Bounds::default())
		})
	}
}

/// Advances `motion` one 16 ms frame at a time from `start_ms` and returns the
/// milliseconds it took to stop requesting frames, failing once `bound_ms`
/// passes. Asserts it keeps requesting none for a second afterwards.
fn frames_until_rest(
	clock: &mut Clock,
	motion: &mut impl Advance,
	start_ms: u64,
	bound_ms: u64,
	what: &str,
) -> u64 {
	let mut ms = start_ms;
	loop {
		clock.at(ms);
		if !clock.advance(motion) {
			break;
		}
		assert!(
			ms - start_ms <= bound_ms,
			"{what} still moves {} ms after it started",
			ms - start_ms
		);
		ms += 16;
	}
	let rested = ms - start_ms;
	for extra in 1..=60 {
		clock.at(ms + extra * 16);
		assert!(!clock.advance(motion), "{what} moves again {} ms after it rested", extra * 16);
	}
	rested
}

/// Seconds a role's spring takes from 0 to 1, from the framework's own
/// solver.
fn spring_rest_ms(spring: veyyon_gpui::motion::SpringConfig) -> u64 {
	let seconds = spring
		.time_to_rest(0.0, 0.0, 1.0, 5.0)
		.expect("a role spring rests within five seconds");
	(seconds * 1000.0).ceil() as u64
}

#[test]
fn every_role_driver_comes_to_rest_within_its_bound() {
	let tokens = MotionTokens::reference();
	let mut clock = Clock::new();
	let mut start = 0;
	for role in MotionRole::ALL {
		let now = clock.at(start);
		// One 16 ms frame of slack past the authored length: the last frame
		// before rest can land up to one frame after it.
		let (rested, bound) = match role {
			MotionRole::Tint => {
				let mut tint = TintMotion::new(0.0);
				tint.set_target(1.0, &tokens, FULL, now);
				let bound = u64::from(tokens.tint.duration_ms) + 16;
				(frames_until_rest(&mut clock, &mut tint, start, bound, "tint"), bound)
			},
			MotionRole::Reveal => {
				let mut reveal = RevealMotion::new(false);
				reveal.set_expanded(true, &tokens, FULL, now);
				let bound = spring_rest_ms(tokens.reveal) + 16;
				(frames_until_rest(&mut clock, &mut reveal, start, bound, "reveal"), bound)
			},
			MotionRole::Float => {
				let mut float = FloatMotion::new();
				float.set_open(true, &tokens, FULL, now);
				let bound = spring_rest_ms(tokens.float.spring)
					.max(u64::from(tokens.float.fade_duration_ms))
					+ 16;
				(frames_until_rest(&mut clock, &mut float, start, bound, "float"), bound)
			},
			MotionRole::Panel => {
				let mut panel = PanelMotion::new(320.0);
				panel.set_direct(400.0, now);
				panel.release_to_snap(380.0, &tokens, FULL, now);
				// The release starts 80 px from the target, so the bound
				// scales the unit spring's settle by the distance it covers.
				let bound = (spring_rest_ms(tokens.panel.snap_spring) as f32 * 1.5) as u64 + 16;
				(frames_until_rest(&mut clock, &mut panel, start, bound, "panel"), bound)
			},
			MotionRole::Shift => {
				let mut shift = ShiftMotion::new();
				shift.record_shift(100.0, 150.0, &tokens, FULL, now);
				let bound = u64::from(tokens.shift.duration_ms) + 16;
				(frames_until_rest(&mut clock, &mut shift, start, bound, "shift"), bound)
			},
			MotionRole::Scroll => {
				let mut scroll = ScrollMotion::new(0.0);
				scroll.scroll_to(500.0, &tokens, FULL, now);
				let bound = u64::from(tokens.scroll.duration_ms) + 16;
				(frames_until_rest(&mut clock, &mut scroll, start, bound, "scroll"), bound)
			},
			MotionRole::Caret => {
				// A blink never rests while its reply streams, so the bound is
				// on the frame after streaming ends.
				let mut caret = CaretMotion::new();
				caret.set_streaming(true, &tokens, FULL, now);
				assert!(clock.advance(&mut caret), "a streaming caret blinks");
				let later = clock.at(start + 16);
				caret.set_streaming(false, &tokens, FULL, later);
				(frames_until_rest(&mut clock, &mut caret, start + 16, 0, "caret"), 0)
			},
		};
		assert!(rested <= bound, "{} rested after {rested} ms, over {bound} ms", role.name());
		start += rested + 60 * 16 + 16;
	}
}

#[test]
fn every_role_driver_places_its_value_under_reduced_motion() {
	let tokens = MotionTokens::reference();
	let mut clock = Clock::new();
	let now = clock.at(0);

	let mut tint = TintMotion::new(0.0);
	tint.set_target(1.0, &tokens, REDUCED, now);
	assert_eq!(tint.sample(now), (1.0, true));

	let mut panel = PanelMotion::new(320.0);
	panel.set_direct(360.0, now);
	panel.release_to_snap(300.0, &tokens, REDUCED, now);
	assert_eq!(panel.sample(now), (300.0, true));
	assert!(panel.is_settled());

	let mut shift = ShiftMotion::new();
	shift.record_shift(100.0, 200.0, &tokens, REDUCED, now);
	assert_eq!(shift.sample(now), (0.0, true));

	let mut scroll = ScrollMotion::new(0.0);
	scroll.scroll_to(800.0, &tokens, REDUCED, now);
	assert_eq!(scroll.sample(now), (800.0, true));

	let mut caret = CaretMotion::new();
	caret.set_streaming(true, &tokens, REDUCED, now);
	assert_eq!(caret.sample(now), (1.0, true));
	assert!(!clock.advance(&mut caret), "a reduced caret requests no frames");

	// Reveal and float keep a fade under reduced motion, with no movement: the
	// reveal leaves height alone and the float does not rise.
	let mut reveal = RevealMotion::new(false);
	reveal.set_expanded(true, &tokens, REDUCED, now);
	assert!(!reveal.animates_height());
	let mut float = FloatMotion::new();
	float.set_open(true, &tokens, REDUCED, now);
	assert_eq!(float.sample(now).offset_y, 0.0);
	let faded = clock.at(u64::from(veyyon_gpui::motion::REDUCED_FADE_MS));
	assert_eq!(reveal.sample(faded), (1.0, true));
	let frame = float.sample(faded);
	assert_eq!((frame.opacity, frame.offset_y, frame.settled), (1.0, 0.0, true));
}
