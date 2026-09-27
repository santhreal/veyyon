//! WHY: Motion transitions across surface components (popovers, rails, panels,
//! overlays) must honor the centralized §7.1 role table, preserve velocity
//! across interruptions, handle remounts without replay-from-zero artifacts,
//! and respect reduced motion.
//!
//! CLASS CLOSED:
//! 1. Float popovers jumping to 0 on exit interruption.
//! 2. Queue rail FLIP shift resetting position on re-layout.
//! 3. Collapsible section springs losing position during rapid toggle.
//! 4. Overlay scrim background flashing during entrance/exit transitions.
//! 5. Reduced motion executing continuous animations or failing to settle at
//!    rest.

#[path = "support/clock.rs"]
mod clock;

use std::collections::HashMap;

use clock::Clock;
use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_motion::{PanelMotion, ScrollMotion};
use veyyon_desktop_surface::{Section, palette::motion::FloatMotion, queue::motion::RailMotion};
use veyyon_gpui::motion::{MotionPolicy, MotionTokens};

const FULL: MotionPolicy = MotionPolicy::DEFAULT;

fn tokens() -> MotionTokens {
	load_bundled_tokens().expect("bundled tokens").motion
}

#[test]
fn surface_float_motion_reverses_continuously_in_both_motion_modes() {
	let tokens = tokens();

	for policy in [MotionPolicy::DEFAULT, MotionPolicy::REDUCED] {
		let mut clock = Clock::start();
		let mut motion = FloatMotion::default();

		// Start open
		let t0 = clock.at(0);
		motion.set_open(true, &tokens, policy, t0);
		let f0 = motion.sample(t0);
		assert_eq!(f0.opacity, 0.0);
		assert_eq!(
			f0.offset_y,
			if policy.reduced() {
				0.0
			} else {
				tokens.float.rise_px
			}
		);
		assert!(!f0.settled);

		// Interrupt at 30ms (close)
		let t1 = clock.at(30);
		let before_close = motion.sample(t1);
		motion.set_open(false, &tokens, policy, t1);
		let after_close = motion.sample(t1);
		assert!(
			(before_close.opacity - after_close.opacity).abs() < 0.0001,
			"Opacity must be continuous at close interruption"
		);
		assert!(
			(before_close.offset_y - after_close.offset_y).abs() < 0.0001,
			"Offset must be continuous at close interruption"
		);

		// Re-open at 45ms
		let t2 = clock.at(45);
		let before_reopen = motion.sample(t2);
		motion.set_open(true, &tokens, policy, t2);
		let after_reopen = motion.sample(t2);
		assert!(
			(before_reopen.opacity - after_reopen.opacity).abs() < 0.0001,
			"Opacity must be continuous at reopen interruption"
		);
		assert!(
			(before_reopen.offset_y - after_reopen.offset_y).abs() < 0.0001,
			"Offset must be continuous at reopen interruption"
		);

		// Fully settle
		let settled_open = motion.sample(clock.at(1545));
		assert!(settled_open.settled);
		assert_eq!(settled_open.opacity, 1.0);
		assert!(settled_open.offset_y.abs() < 0.01);
	}
}

#[test]
fn queue_rail_motion_handles_rapid_collapse_expansion_without_teleporting() {
	let tokens = tokens();
	let mut clock = Clock::start();
	let mut rail = RailMotion::new();

	let t0 = clock.at(0);

	// Initially expanded
	assert!(!rail.is_collapsed(Section::Deferred));
	assert!(!clock.advance(&mut rail), "a rail nobody toggled requests no frame");
	assert_eq!(rail.reveal_progress(Section::Deferred), 1.0);

	// Toggle to collapsed
	rail.toggle_collapsed(Section::Deferred, &tokens, FULL, t0);
	assert!(rail.is_collapsed(Section::Deferred));

	// 25ms in, sample partial progress
	let t1 = clock.at(25);
	assert!(clock.advance(&mut rail), "the collapse still moves 25 ms in");
	let p_mid = rail.reveal_progress(Section::Deferred);
	assert!(p_mid < 1.0 && p_mid > 0.0, "Progress must be in-flight: {p_mid}");

	// Interrupt: toggle back to expanded at t1
	rail.toggle_collapsed(Section::Deferred, &tokens, FULL, t1);
	assert!(!rail.is_collapsed(Section::Deferred));

	assert!(clock.advance(&mut rail), "the reversal still moves");
	let p_reopened = rail.reveal_progress(Section::Deferred);
	assert!(
		(p_reopened - p_mid).abs() < 0.01,
		"Progress must not jump on reversal: before={p_mid}, after={p_reopened}"
	);
}

#[test]
fn queue_rail_flip_shift_preserves_continuity_under_rapid_layout_updates() {
	let tokens = tokens();
	let mut clock = Clock::start();
	let mut rail = RailMotion::new();

	// Frame 1: initial layout positions
	let mut pos_frame1 = HashMap::new();
	pos_frame1.insert(101, 100.0_f32);
	pos_frame1.insert(102, 140.0_f32);
	rail.record_positions(&pos_frame1, &tokens, FULL, clock.at(0));
	assert_eq!(rail.shift_offset(101), 0.0);
	assert_eq!(rail.shift_offset(102), 0.0);

	// Frame 2: row 101 moves down to 140.0 (shift delta = -40px)
	let mut pos_frame2 = HashMap::new();
	pos_frame2.insert(101, 140.0_f32);
	pos_frame2.insert(102, 180.0_f32);
	rail.record_positions(&pos_frame2, &tokens, FULL, clock.at(16));

	let offset_101 = rail.shift_offset(101);
	assert!(
		(offset_101 - (-40.0)).abs() < 0.01,
		"Initial FLIP offset must equal delta_y (-40): got {offset_101}"
	);

	// Frame 3 (50ms in): shift is smoothly returning towards 0.0
	clock.at(66);
	assert!(clock.advance(&mut rail), "the shift still moves 50 ms in");
	let offset_101_mid = rail.shift_offset(101);
	assert!(
		offset_101_mid > -40.0 && offset_101_mid < 0.0,
		"Shift offset must interpolate smoothly: got {offset_101_mid}"
	);
}

#[test]
fn panel_and_scroll_shared_drivers_behave_deterministically_for_surfaces() {
	let tokens = tokens();
	let mut clock = Clock::start();
	let t0 = clock.at(0);

	// Panel snap
	let mut panel = PanelMotion::new(320.0);
	panel.set_direct(350.0, t0);
	panel.release_to_snap(380.0, &tokens, FULL, t0);

	// Scroll jump
	let mut scroll = ScrollMotion::new(0.0);
	scroll.scroll_to(600.0, &tokens, FULL, t0);

	let t_settle = clock.at(1500);
	let (w, settled) = panel.sample(t_settle);
	assert!(settled);
	assert!((w - 380.0).abs() < 0.001);

	let (offset, scroll_settled) = scroll.sample(t_settle);
	assert!(scroll_settled);
	assert_eq!(offset, 600.0);
}
