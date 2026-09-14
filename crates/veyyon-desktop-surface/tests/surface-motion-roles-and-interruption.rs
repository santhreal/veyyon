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

use std::{
	collections::HashMap,
	time::{Duration, Instant},
};

use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_motion::{MotionTokens, PanelMotion, ScrollMotion, SurfaceId};
use veyyon_desktop_surface::{Section, palette::motion::FloatMotion, queue::motion::RailMotion};

#[test]
fn surface_float_motion_reverses_continuously_in_both_motion_modes() {
	let tokens: MotionTokens = load_bundled_tokens().expect("bundled tokens").motion.into();

	for reduced in [false, true] {
		let mut motion = FloatMotion::default();
		let t0 = Instant::now();

		// Start open
		let f0 = motion.sample(true, t0, &tokens, reduced);
		assert_eq!(f0.opacity, 0.0);
		assert_eq!(f0.offset_y, if reduced { 0.0 } else { tokens.float.rise_px });
		assert!(!f0.settled);

		// Interrupt at 30ms (close)
		let t1 = t0 + Duration::from_millis(30);
		let before_close = motion.sample(true, t1, &tokens, reduced);
		let after_close = motion.sample(false, t1, &tokens, reduced);
		assert!(
			(before_close.opacity - after_close.opacity).abs() < 0.0001,
			"Opacity must be continuous at close interruption"
		);
		assert!(
			(before_close.offset_y - after_close.offset_y).abs() < 0.0001,
			"Offset must be continuous at close interruption"
		);

		// Re-open at 45ms
		let t2 = t1 + Duration::from_millis(15);
		let before_reopen = motion.sample(false, t2, &tokens, reduced);
		let after_reopen = motion.sample(true, t2, &tokens, reduced);
		assert!(
			(before_reopen.opacity - after_reopen.opacity).abs() < 0.0001,
			"Opacity must be continuous at reopen interruption"
		);
		assert!(
			(before_reopen.offset_y - after_reopen.offset_y).abs() < 0.0001,
			"Offset must be continuous at reopen interruption"
		);

		// Fully settle
		let t3 = t2 + Duration::from_millis(1500);
		let settled_open = motion.sample(true, t3, &tokens, reduced);
		assert!(settled_open.settled);
		assert_eq!(settled_open.opacity, 1.0);
		assert!(settled_open.offset_y.abs() < 0.01);
	}
}

#[test]
fn queue_rail_motion_handles_rapid_collapse_expansion_without_teleporting() {
	let tokens: MotionTokens = load_bundled_tokens().expect("bundled tokens").motion.into();
	let mut rail = RailMotion::with_tokens(tokens);

	let t0 = Instant::now();

	// Initially expanded
	assert!(!rail.is_collapsed(Section::Deferred));
	assert_eq!(rail.reveal_progress(Section::Deferred, t0), 1.0);

	// Toggle to collapsed
	rail.toggle_collapsed(Section::Deferred, t0);
	assert!(rail.is_collapsed(Section::Deferred));

	// 25ms in, sample partial progress
	let t1 = t0 + Duration::from_millis(25);
	let p_mid = rail.reveal_progress(Section::Deferred, t1);
	assert!(p_mid < 1.0 && p_mid > 0.0, "Progress must be in-flight: {p_mid}");

	// Interrupt: toggle back to expanded at t1
	rail.toggle_collapsed(Section::Deferred, t1);
	assert!(!rail.is_collapsed(Section::Deferred));

	let p_reopened = rail.reveal_progress(Section::Deferred, t1);
	assert!(
		(p_reopened - p_mid).abs() < 0.01,
		"Progress must not jump on reversal: before={p_mid}, after={p_reopened}"
	);
}

#[test]
fn queue_rail_flip_shift_preserves_continuity_under_rapid_layout_updates() {
	let tokens: MotionTokens = load_bundled_tokens().expect("bundled tokens").motion.into();
	let mut rail = RailMotion::with_tokens(tokens);

	let t0 = Instant::now();

	// Frame 1: initial layout positions
	let mut pos_frame1 = HashMap::new();
	pos_frame1.insert(101, 100.0_f32);
	pos_frame1.insert(102, 140.0_f32);
	rail.record_positions(&pos_frame1, t0);
	assert_eq!(rail.shift_offset(101, t0), 0.0);
	assert_eq!(rail.shift_offset(102, t0), 0.0);

	// Frame 2: row 101 moves down to 140.0 (shift delta = -40px)
	let t1 = t0 + Duration::from_millis(16);
	let mut pos_frame2 = HashMap::new();
	pos_frame2.insert(101, 140.0_f32);
	pos_frame2.insert(102, 180.0_f32);
	rail.record_positions(&pos_frame2, t1);

	let offset_101 = rail.shift_offset(101, t1);
	assert!(
		(offset_101 - (-40.0)).abs() < 0.01,
		"Initial FLIP offset must equal delta_y (-40): got {offset_101}"
	);

	// Frame 3 (50ms in): shift is smoothly returning towards 0.0
	let t2 = t1 + Duration::from_millis(50);
	let offset_101_mid = rail.shift_offset(101, t2);
	assert!(
		offset_101_mid > -40.0 && offset_101_mid < 0.0,
		"Shift offset must interpolate smoothly: got {offset_101_mid}"
	);
}

#[test]
fn panel_and_scroll_shared_drivers_behave_deterministically_for_surfaces() {
	let tokens: MotionTokens = load_bundled_tokens().expect("bundled tokens").motion.into();

	// Panel snap
	let mut panel = PanelMotion::new(SurfaceId::RightPanel, 0, 320.0);
	let t0 = Instant::now();
	panel.set_direct(350.0, t0);
	panel.release_to_snap(380.0, &tokens, false, t0);

	let t_settle = t0 + Duration::from_millis(1500);
	let (w, settled) = panel.sample(t_settle);
	assert!(settled);
	assert!((w - 380.0).abs() < 0.001);

	// Scroll jump
	let mut scroll = ScrollMotion::new(SurfaceId::Transcript, 0, 0.0);
	scroll.scroll_to(600.0, &tokens, false, t0);
	let (offset, scroll_settled) = scroll.sample(t_settle);
	assert!(scroll_settled);
	assert_eq!(offset, 600.0);
}
