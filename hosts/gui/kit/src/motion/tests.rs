//! WHY THIS SUITE EXISTS.
//!
//! An animation layer fails in ways a screenshot cannot show and a person
//! only feels: a reversal that snaps because the tween restarted from its
//! target, a channel that never reports itself finished so the window
//! repaints at the display's full rate forever, a hover wash that outlives
//! the row it belonged to and comes back already lit, an eased value a hair
//! outside 0..1 that panics one layer down as an opacity.
//!
//! Every one of those is arithmetic over a clock, and the clock is an
//! argument here, so all of it is asserted at exact milliseconds with no
//! sleeping and no window.
//!
//! WHAT IT DOES NOT CATCH. Whether the motion looks right. The curves are
//! pinned to the CSS ones by value at five points each, which is the part
//! that can be wrong arithmetically rather than by taste.

use gpui::{Hsla, Rgba};

use super::*;

fn close(actual: f32, expected: f32, tolerance: f32, what: &str) {
	assert!(
		(actual - expected).abs() <= tolerance,
		"{what}: got {actual}, expected {expected} ±{tolerance}"
	);
}

#[test]
fn a_linear_bezier_is_the_identity() {
	let linear = Curve::new(0.0, 0.0, 1.0, 1.0);
	for x in [0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0] {
		close(linear.at(x), x, 1e-4, "linear");
	}
}

#[test]
fn the_curves_are_the_css_curves_by_value() {
	// References solved independently by bisection to 1e-6. A curve that
	// drifts from these is no longer the shape the rest of the machine's
	// software moves with, which is the only reason to use CSS curves.
	let cases: [(&str, Curve, [f32; 5]); 4] = [
		("expo-out", EXPO_OUT, [0.494391, 0.825622, 0.971779, 0.997677, 0.999878]),
		("ease-out", OUT, [0.160572, 0.378138, 0.684643, 0.906535, 0.982973]),
		("ease", EASE, [0.094796, 0.408511, 0.802403, 0.960459, 0.994316]),
		("ease-in-out", IN_OUT, [0.019151, 0.129405, 0.5, 0.870595, 0.980849]),
	];
	for (name, curve, expected) in cases {
		for (x, want) in [0.1, 0.25, 0.5, 0.75, 0.9].into_iter().zip(expected) {
			close(curve.at(x), want, 1e-3, name);
		}
	}
}

#[test]
fn an_eased_value_never_escapes_the_unit_interval() {
	// f32 rounding puts the sharper curves a hair above 1.0 near the tail.
	// A value above 1.0 handed to an opacity is a panic, so the sweep is
	// dense and includes the values closest to the endpoint.
	for curve in [EXPO_OUT, OUT, EASE, IN_OUT, IN, COLOR] {
		for step in 0..=20_000u32 {
			let x = step as f32 / 20_000.0;
			let y = curve.at(x);
			assert!((0.0..=1.0).contains(&y), "at({x}) = {y} escaped 0..1");
		}
		for x in [0.999_999_f32, 0.999_999_9, 1.0 - f32::EPSILON] {
			assert!((0.0..=1.0).contains(&curve.at(x)));
		}
	}
}

#[test]
fn every_curve_starts_at_nothing_ends_at_everything_and_clamps_outside() {
	for curve in [EXPO_OUT, OUT, EASE, IN_OUT, IN, COLOR] {
		assert_eq!(curve.at(0.0), 0.0);
		assert_eq!(curve.at(1.0), 1.0);
		assert_eq!(curve.at(-0.5), 0.0);
		assert_eq!(curve.at(1.5), 1.0);
	}
}

#[test]
fn the_curves_never_go_backwards() {
	for curve in [EXPO_OUT, OUT, EASE, IN_OUT, IN, COLOR] {
		let mut last = 0.0;
		for step in 0..=1_000 {
			let y = curve.at(step as f32 / 1_000.0);
			assert!(y >= last - 1e-4, "{curve:?} went backwards at {step}");
			last = y;
		}
	}
}

#[test]
fn a_spec_starts_at_zero_and_ends_at_one() {
	let spec = Spec::new(200, EASE);
	assert_eq!(spec.at_ms(0), 0.0, "a motion that has not started has not moved");
	assert!(spec.at_ms(100) > 0.0, "halfway through the duration is halfway in");
	assert_eq!(spec.at_ms(200), 1.0, "the end of the duration is the end of the motion");
	assert_eq!(spec.at_ms(9_000), 1.0, "past the end stays at the end");
}

#[test]
fn a_zero_length_motion_is_already_there() {
	assert_eq!(Spec::new(0, EASE).at_ms(0), 1.0);
}

#[test]
fn the_catalog_is_the_timing_the_window_was_tuned_at() {
	// Not decoration: these numbers are what the window's feel was set by,
	// and a change to one of them is a change to the product that should
	// be made deliberately rather than by editing a constant in passing.
	assert_eq!((ENTER.duration_ms, ENTER.curve), (260, EXPO_OUT));
	assert_eq!((RESIZE.duration_ms, RESIZE.curve), (200, OUT));
	assert_eq!((COLLAPSE.duration_ms, COLLAPSE.curve), (180, OUT));
	assert_eq!((WASH.duration_ms, WASH.curve), (150, COLOR));
}

#[test]
fn the_first_sight_of_a_driven_value_is_at_rest_on_its_target() {
	// A sidebar that is open at startup is open, not sliding in.
	let mut motion = Motion::new();
	let key = Key::of(Channel::SidebarWidth);
	assert_eq!(motion.drive(key, RESIZE, 268.0, 0), 268.0);
	assert!(!motion.advance(0), "a value at rest asked for a frame");
	assert_eq!(motion.next_frame_after(0), None, "a value at rest asked for a frame");
}

#[test]
fn a_driven_value_travels_to_a_new_target_and_arrives() {
	let mut motion = Motion::new();
	let key = Key::of(Channel::SidebarWidth);
	motion.drive(key, RESIZE, 0.0, 0);
	motion.drive(key, RESIZE, 200.0, 0);

	let quarter = motion.drive(key, RESIZE, 200.0, 50);
	assert!(quarter > 0.0 && quarter < 200.0, "did not travel: {quarter}");
	assert_eq!(motion.next_frame_after(50), Some(0), "a moving value wants the next frame");

	assert_eq!(motion.drive(key, RESIZE, 200.0, 200), 200.0);
	assert_eq!(motion.next_frame_after(200), None, "an arrived value still wants frames");
}

#[test]
fn restating_a_target_every_frame_does_not_restart_the_motion() {
	// The render path re-states every target on every frame by
	// construction. A tween that restarts on a re-statement never arrives.
	let mut motion = Motion::new();
	let key = Key::of(Channel::SidebarWidth);
	motion.drive(key, RESIZE, 0.0, 0);
	motion.drive(key, RESIZE, 260.0, 0);
	let mut last = 0.0;
	for now in [16, 32, 48, 64, 80, 96] {
		let value = motion.drive(key, RESIZE, 260.0, now);
		assert!(value >= last, "went backwards at {now}: {last} then {value}");
		last = value;
	}
	assert_eq!(motion.drive(key, RESIZE, 260.0, 200), 260.0);
}

#[test]
fn a_reversal_continues_from_where_the_value_actually_is() {
	// The defect this closes: a panel toggled twice quickly jumps to the
	// far end and slides back, because the second leg started from the
	// first leg's target instead of from the value on screen.
	let mut motion = Motion::new();
	let key = Key::of(Channel::SidebarWidth);
	motion.drive(key, RESIZE, 0.0, 0);
	motion.drive(key, RESIZE, 260.0, 0);
	let midway = motion.drive(key, RESIZE, 260.0, 100);
	assert!(midway > 0.0 && midway < 260.0);

	motion.drive(key, RESIZE, 0.0, 100);
	let after = motion.value(key, 100);
	close(after, midway, 1.0, "a reversal jumped instead of continuing");
}

#[test]
fn an_entrance_runs_once_and_a_remount_does_not_replay_it() {
	// This is the whole reason the window does not use an element-keyed
	// animation: the tree remounts constantly and a replay is a flash.
	let mut motion = Motion::new();
	let key = Key::named(Channel::Message, "message-7");
	assert_eq!(motion.enter(key, ENTER, 0), 0.0, "an entrance starts at nothing");
	let midway = motion.enter(key, ENTER, 100);
	assert!(midway > 0.0 && midway < 1.0);
	assert_eq!(motion.enter(key, ENTER, 300), 1.0);

	// The frame after it finished, and a hundred frames later: still 1. It
	// asks for no more frames, and it is kept, because a value at 1 is not
	// the same as a value that was never there.
	assert!(!motion.advance(300), "an arrived entrance asked for another frame");
	assert_eq!(motion.len(), 1);
	assert_eq!(motion.enter(key, ENTER, 5_000), 1.0, "the entrance replayed");
}

#[test]
fn a_hover_that_never_happened_creates_nothing() {
	// Every drawn row reports a leave when the pointer crosses the list. A
	// registry that stores a zero for each of them grows with the session
	// count and scans longer every frame.
	let mut motion = Motion::new();
	motion.flip(Key::named(Channel::Row, "a"), false, WASH, 0);
	assert!(motion.is_empty(), "a leave created a channel");
}

#[test]
fn a_hover_wash_does_not_outlive_the_row_it_belonged_to() {
	// A row unmounted while the pointer is over it never gets its leave, so
	// its channel would sit at 1.0 and the row would come back lit. It is
	// dropped instead, because nothing read it for a whole frame.
	let mut motion = Motion::new();
	let key = Key::named(Channel::Row, "grep");
	motion.flip(key, true, WASH, 0);
	assert_eq!(motion.value(key, 200), 1.0);
	assert!(!motion.advance(200), "an arrived wash asked for another frame");
	assert_eq!(motion.len(), 1, "the wash was read this frame, so it stays");

	// The next frame does not draw the row at all.
	assert!(!motion.advance(400));
	assert!(motion.is_empty(), "the wash outlived its row");
	assert_eq!(motion.value(key, 400), 0.0, "the row came back lit");
}

#[test]
fn a_value_settled_back_at_zero_is_forgotten() {
	let mut motion = Motion::new();
	let key = Key::named(Channel::Control, "send");
	motion.flip(key, true, WASH, 0);
	motion.value(key, 0);
	motion.advance(0);
	motion.flip(key, false, WASH, 0);
	motion.value(key, 200);
	assert!(!motion.advance(200));
	assert!(motion.is_empty(), "a settled hover was kept");
}

#[test]
fn the_window_stops_asking_for_frames_once_everything_arrives() {
	// The failure this closes is a window that repaints forever for a
	// motion that ended, which is the single most expensive defect an
	// animation layer can have.
	let mut motion = Motion::new();
	let key = Key::of(Channel::SidebarWidth);
	motion.drive(key, RESIZE, 0.0, 0);
	motion.drive(key, RESIZE, 268.0, 0);
	assert_eq!(motion.next_frame_after(0), Some(0));

	let mut now = 0;
	let mut frames = 0;
	while let Some(wait) = motion.next_frame_after(now) {
		now += wait.max(16) as u64;
		motion.drive(key, RESIZE, 268.0, now);
		motion.advance(now);
		frames += 1;
		assert!(frames < 100, "the window never stopped asking for frames");
	}
	assert_eq!(motion.drive(key, RESIZE, 268.0, now), 268.0);
}

#[test]
fn reduced_motion_snaps_every_value_and_schedules_no_frames() {
	let mut motion = Motion::new();
	motion.set_reduced(true);
	let key = Key::of(Channel::SidebarWidth);
	motion.drive(key, RESIZE, 0.0, 0);
	assert_eq!(motion.drive(key, RESIZE, 268.0, 0), 268.0, "a value animated");
	assert_eq!(motion.enter(Key::of(Channel::Sheet), SHEET_IN, 0), 1.0);
	assert!(!motion.advance(0));
	assert_eq!(motion.next_frame_after(0), None);
}

#[test]
fn a_wash_fading_in_from_transparent_never_passes_through_grey() {
	// Naive interpolation of a white wash over transparent black darkens
	// first and brightens second, which reads as a flicker on a dark row.
	let wash = Hsla { h: 0.0, s: 0.0, l: 1.0, a: 0.08 };
	let half = mix(gpui::transparent_black(), wash, 0.5);
	close(half.a, 0.04, 1e-4, "alpha midpoint");
	let rgba = Rgba::from(half);
	assert!(rgba.r > 0.99 && rgba.g > 0.99 && rgba.b > 0.99, "the wash lost its hue: {rgba:?}");
}

#[test]
fn mixing_holds_its_endpoints_and_clamps() {
	let from = Hsla { h: 0.6, s: 0.1, l: 0.2, a: 1.0 };
	let to = Hsla { h: 0.6, s: 0.1, l: 0.4, a: 1.0 };
	assert_eq!(mix(from, to, 0.0), from);
	assert_eq!(mix(from, to, 1.0), to);
	assert_eq!(mix(from, to, -1.0), from);
	assert_eq!(mix(from, to, 2.0), to);
	let middle = mix(from, to, 0.5);
	assert!(middle.l > from.l && middle.l < to.l, "midpoint lightness {}", middle.l);
}

#[test]
fn a_named_key_is_stable_and_distinguishes_its_channel() {
	let row = Key::named(Channel::Row, "frame");
	assert_eq!(row, Key::named(Channel::Row, "frame"));
	assert_ne!(row, Key::named(Channel::Row, "themes"));
	assert_ne!(row, Key::named(Channel::Control, "frame"), "two channels collided");
}
