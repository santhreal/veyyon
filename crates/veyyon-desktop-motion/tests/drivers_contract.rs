//! Tests for specialized, token-driven motion drivers (§7.1, §7.2, §8.23).

use std::time::{Duration, Instant};

use veyyon_desktop_motion::{
	CaretMotion, FloatMotion, MotionTokens, PanelMotion, RevealMotion, ScrollMotion, SurfaceId,
	TintMotion,
};

#[test]
fn panel_motion_direct_drag_tracks_velocity_and_release_snaps_via_spring() {
	let tokens = MotionTokens::reference();
	let mut panel = PanelMotion::new(SurfaceId::RightPanel, 0, 320.0);

	let t0 = Instant::now();
	assert_eq!(panel.current_width(), 320.0);
	assert!(panel.is_settled());

	// Drag from 320.0 to 400.0 over 50ms
	let t_drag1 = t0 + Duration::from_millis(20);
	panel.set_direct(350.0, t_drag1);
	let (w, settled) = panel.sample(t_drag1);
	assert_eq!(w, 350.0);
	assert!(!settled);

	let t_drag2 = t0 + Duration::from_millis(50);
	panel.set_direct(400.0, t_drag2);
	let (w, settled) = panel.sample(t_drag2);
	assert_eq!(w, 400.0);
	assert!(!settled);

	// Release to snap to 380.0
	panel.release_to_snap(380.0, &tokens, false, t_drag2);

	// Advance 20ms into snap spring
	let t_snap = t_drag2 + Duration::from_millis(20);
	let (w_snap, settled_snap) = panel.sample(t_snap);
	assert!(!settled_snap);
	// Analytic 180/22/1 spring with v0 = 50 / 0.030 px/s at t = 0.020s.
	assert!((w_snap - 426.0241).abs() < 0.001);

	// Advance to 1.5s to verify complete rest
	let t_settled = t_drag2 + Duration::from_millis(1500);
	let (w_final, settled_final) = panel.sample(t_settled);
	assert!(settled_final);
	assert!((w_final - 380.0).abs() < 0.001);
	assert!(panel.is_settled());
}

#[test]
fn panel_motion_under_reduced_motion_snaps_instantly() {
	let tokens = MotionTokens::reference();
	let mut panel = PanelMotion::new(SurfaceId::RightPanel, 0, 320.0);

	let t0 = Instant::now();
	panel.set_direct(360.0, t0);
	panel.release_to_snap(300.0, &tokens, true, t0);

	let (w, settled) = panel.sample(t0);
	assert!(settled);
	assert_eq!(w, 300.0);
	assert!(panel.is_settled());
}

#[test]
fn panel_motion_with_bounds_clamps_direct_drag_and_snap_target() {
	let tokens = MotionTokens::reference();
	let mut panel = PanelMotion::with_bounds(SurfaceId::RightPanel, 0, 320.0, 240.0, 480.0);
	assert_eq!(panel.bounds(), Some((240.0, 480.0)));

	let t0 = Instant::now();

	// Drag below minimum width 240.0 -> clamped to 240.0
	panel.set_direct(180.0, t0);
	let (w_low, _) = panel.sample(t0);
	assert_eq!(w_low, 240.0);

	// Drag above maximum width 480.0 -> clamped to 480.0
	let t1 = t0 + Duration::from_millis(30);
	panel.set_direct(600.0, t1);
	let (w_high, _) = panel.sample(t1);
	assert_eq!(w_high, 480.0);

	// Release to snap outside bounds -> clamped to nearest bound
	panel.release_to_snap(700.0, &tokens, false, t1);
	let t_settle = t1 + Duration::from_millis(1500);
	let (w_snap, settled) = panel.sample(t_settle);
	assert!(settled);
	assert!((w_snap - 480.0).abs() < 0.001);
}

#[test]
fn scroll_motion_interpolates_smoothly_over_duration() {
	let tokens = MotionTokens::reference();
	let mut scroll = ScrollMotion::new(SurfaceId::Transcript, 0, 0.0);

	let t0 = Instant::now();
	assert_eq!(scroll.current_offset(), 0.0);
	assert!(scroll.is_settled());

	scroll.scroll_to(500.0, &tokens, false, t0);

	// Sample halfway through 240ms duration
	let t_half = t0 + Duration::from_millis(120);
	let (offset_half, settled_half) = scroll.sample(t_half);
	assert!(!settled_half);
	assert!(offset_half > 100.0 && offset_half < 400.0);

	// Sample after full duration + margin
	let t_end = t0 + Duration::from_millis(250);
	let (offset_end, settled_end) = scroll.sample(t_end);
	assert!(settled_end);
	assert_eq!(offset_end, 500.0);
	assert!(scroll.is_settled());
}

#[test]
fn scroll_motion_under_reduced_motion_jumps_instantly() {
	let tokens = MotionTokens::reference();
	let mut scroll = ScrollMotion::new(SurfaceId::Transcript, 0, 0.0);

	let t0 = Instant::now();
	scroll.scroll_to(800.0, &tokens, true, t0);

	let (offset, settled) = scroll.sample(t0);
	assert!(settled);
	assert_eq!(offset, 800.0);
	assert!(scroll.is_settled());
}

#[test]
fn caret_motion_blinks_at_900ms_period_when_streaming_and_remains_steady_on_when_idle_or_reduced() {
	let tokens = MotionTokens::reference();
	let mut caret = CaretMotion::new(SurfaceId::Composer, 0);

	let t0 = Instant::now();

	// Idle state: steady on at opacity 1.0, settled
	let (opacity, settled) = caret.sample(false, t0, &tokens, false);
	assert_eq!(opacity, 1.0);
	assert!(settled);

	// Streaming active, normal motion:
	// Phase 0: 0ms to 450ms -> opacity 1.0
	let (op_0, set_0) = caret.sample(true, t0 + Duration::from_millis(100), &tokens, false);
	assert_eq!(op_0, 1.0);
	assert!(!set_0);

	// Phase 1: 450ms to 900ms -> opacity 0.0
	let (op_1, set_1) = caret.sample(true, t0 + Duration::from_millis(550), &tokens, false);
	assert_eq!(op_1, 0.0);
	assert!(!set_1);

	// Phase 2: 900ms to 1350ms -> opacity 1.0 again
	let (op_2, set_2) = caret.sample(true, t0 + Duration::from_secs(1), &tokens, false);
	assert_eq!(op_2, 1.0);
	assert!(!set_2);

	// Reduced motion during streaming: steady on at opacity 1.0, settled
	let (op_red, set_red) = caret.sample(true, t0 + Duration::from_millis(550), &tokens, true);
	assert_eq!(op_red, 1.0);
	assert!(set_red);
}

#[test]
fn tint_motion_transitions_smoothly_and_respects_reduced_motion() {
	let tokens = MotionTokens::reference();
	let mut tint = TintMotion::new(SurfaceId::Queue, 0, 0.0);

	let t0 = Instant::now();
	assert_eq!(tint.current_value(), 0.0);
	assert!(tint.is_settled());

	tint.set_target(1.0, &tokens, false, t0);

	// Sample midway through 120ms tint transition
	let t_mid = t0 + Duration::from_millis(60);
	let (val_mid, set_mid) = tint.sample(t_mid);
	assert!(!set_mid);
	assert!(val_mid > 0.2 && val_mid < 0.95);

	// Sample after 120ms
	let t_end = t0 + Duration::from_millis(130);
	let (val_end, set_end) = tint.sample(t_end);
	assert!(set_end);
	assert_eq!(val_end, 1.0);

	// Under reduced motion
	tint.set_target(0.0, &tokens, true, t_end);
	let (val_red, set_red) = tint.sample(t_end);
	assert!(set_red);
	assert_eq!(val_red, 0.0);
}

#[test]
fn reveal_motion_toggles_and_springs_continuously() {
	let tokens = MotionTokens::reference();
	let mut reveal = RevealMotion::new(SurfaceId::Queue, 1, false);

	let t0 = Instant::now();
	assert!(!reveal.is_expanded());
	let (val_0, set_0) = reveal.sample(t0);
	assert_eq!(val_0, 0.0);
	assert!(set_0);

	// Expand
	reveal.set_expanded(true, &tokens, false, t0);
	assert!(reveal.is_expanded());

	let t_mid = t0 + Duration::from_millis(50);
	let (val_mid, set_mid) = reveal.sample(t_mid);
	assert!(!set_mid);
	assert!(val_mid > 0.0 && val_mid < 1.0);

	// Settle
	let t_end = t0 + Duration::from_millis(1500);
	let (val_end, set_end) = reveal.sample(t_end);
	assert!(set_end);
	assert!((val_end - 1.0).abs() < 0.001);

	// Toggle back to collapse
	let now_expanded = reveal.toggle(&tokens, false, t_end);
	assert!(!now_expanded);
	assert!(!reveal.is_expanded());
}

#[test]
fn float_motion_drives_entrance_exit_and_interruption() {
	let tokens = MotionTokens::reference();
	let mut float = FloatMotion::new(SurfaceId::Palette, 0);

	let t0 = Instant::now();
	let initial_frame = float.sample(false, t0, &tokens, false);
	assert_eq!(initial_frame.opacity, 0.0);
	assert!(initial_frame.settled);

	// Open
	let open_frame_start = float.sample(true, t0, &tokens, false);
	assert_eq!(open_frame_start.opacity, 0.0);
	assert_eq!(open_frame_start.offset_y, tokens.float.rise_px);
	assert!(!open_frame_start.settled);

	let t_mid = t0 + Duration::from_millis(45);
	let mid_frame = float.sample(true, t_mid, &tokens, false);
	assert!(mid_frame.opacity > 0.0 && mid_frame.opacity < 1.0);
	assert!(mid_frame.offset_y > 0.0 && mid_frame.offset_y < tokens.float.rise_px);

	// Interrupt mid-flight (close)
	let int_frame = float.sample(false, t_mid, &tokens, false);
	assert!((int_frame.opacity - mid_frame.opacity).abs() < 0.0001);
	assert!((int_frame.offset_y - mid_frame.offset_y).abs() < 0.0001);

	// Settle closed
	let t_settle = t_mid + Duration::from_millis(1500);
	let settled_frame = float.sample(false, t_settle, &tokens, false);
	assert_eq!(settled_frame.opacity, 0.0);
	assert!(settled_frame.settled);
}
