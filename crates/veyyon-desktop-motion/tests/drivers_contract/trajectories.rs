//! Each driver's trajectory, interruption and reduced variant, sampled on
//! the harness clock of `drivers_contract`.

use super::*;

#[test]
fn panel_motion_direct_drag_tracks_velocity_and_release_snaps_via_spring() {
	let tokens = MotionTokens::reference();
	let mut clock = Clock::new();
	let mut panel = PanelMotion::new(320.0);
	assert_eq!(panel.current_width(), 320.0);
	assert!(panel.is_settled());

	let t_drag1 = clock.at(20);
	panel.set_direct(350.0, t_drag1);
	assert_eq!(panel.sample(t_drag1), (350.0, false));
	assert!(!clock.advance(&mut panel), "a dragged panel moves with the pointer, not with frames");

	let t_drag2 = clock.at(50);
	panel.set_direct(400.0, t_drag2);
	assert_eq!(panel.sample(t_drag2), (400.0, false));
	let velocity = 50.0 / 0.030;
	assert!((panel.drag_velocity() - velocity).abs() < 1.0);

	panel.release_to_snap(380.0, &tokens, FULL, t_drag2);
	let (w_snap, settled_snap) = panel.sample(clock.at(70));
	assert!(!settled_snap);
	// The release continues from the dragged width with the drag velocity.
	let expected = tokens
		.panel
		.snap_spring
		.evaluate(400.0, velocity, 380.0, 0.020)
		.position;
	assert!((w_snap - expected).abs() < 0.01, "{w_snap} is not {expected}");
	let from_rest = tokens
		.panel
		.snap_spring
		.evaluate(400.0, 0.0, 380.0, 0.020)
		.position;
	assert!((w_snap - from_rest).abs() > 1.0, "the release dropped the drag velocity");

	let (w_final, settled_final) = panel.sample(clock.at(1550));
	assert!(settled_final);
	assert!((w_final - 380.0).abs() < 0.001);
	assert!(panel.is_settled());
}

#[test]
fn panel_motion_with_bounds_clamps_direct_drag_and_snap_target() {
	let tokens = MotionTokens::reference();
	let mut clock = Clock::new();
	let mut panel = PanelMotion::with_bounds(320.0, 240.0, 480.0);
	assert_eq!(panel.bounds(), Some((240.0, 480.0)));

	let t0 = clock.at(0);
	panel.set_direct(180.0, t0);
	assert_eq!(panel.sample(t0).0, 240.0);

	let t1 = clock.at(30);
	panel.set_direct(600.0, t1);
	assert_eq!(panel.sample(t1).0, 480.0);

	panel.release_to_snap(700.0, &tokens, FULL, t1);
	let (w_snap, settled) = panel.sample(clock.at(1530));
	assert!(settled);
	assert!((w_snap - 480.0).abs() < 0.001);
}

#[test]
fn scroll_motion_interpolates_over_its_duration() {
	let tokens = MotionTokens::reference();
	let mut clock = Clock::new();
	let mut scroll = ScrollMotion::new(0.0);
	assert_eq!(scroll.current_offset(), 0.0);
	assert!(scroll.is_settled());

	scroll.scroll_to(500.0, &tokens, FULL, clock.at(0));
	let (offset_half, settled_half) = scroll.sample(clock.at(120));
	assert!(!settled_half);
	assert!(offset_half > 100.0 && offset_half < 400.0);

	assert_eq!(scroll.sample(clock.at(250)), (500.0, true));
	assert!(scroll.is_settled());

	scroll.set_direct(120.0);
	assert_eq!(scroll.current_offset(), 120.0);
	assert!(scroll.is_settled());
}

#[test]
fn caret_motion_blinks_at_its_period_while_streaming_and_is_steady_otherwise() {
	let tokens = MotionTokens::reference();
	let mut clock = Clock::new();
	let mut caret = CaretMotion::new();

	let t0 = clock.at(0);
	caret.set_streaming(false, &tokens, FULL, t0);
	assert_eq!(caret.sample(t0), (1.0, true));

	caret.set_streaming(true, &tokens, FULL, t0);
	assert_eq!(caret.sample(clock.at(100)), (1.0, false));
	assert_eq!(caret.sample(clock.at(550)), (0.0, false));
	// A blink already running keeps its phase when streaming is restated.
	caret.set_streaming(true, &tokens, FULL, clock.at(600));
	assert_eq!(caret.sample(clock.at(1000)), (1.0, false));

	caret.set_streaming(true, &tokens, REDUCED, clock.at(1100));
	assert_eq!(caret.sample(clock.at(1100)), (1.0, true));
}

#[test]
fn tint_motion_transitions_and_respects_reduced_motion() {
	let tokens = MotionTokens::reference();
	let mut clock = Clock::new();
	let mut tint = TintMotion::new(0.0);
	assert_eq!(tint.current_value(), 0.0);
	assert!(tint.is_settled());

	tint.set_target(1.0, &tokens, FULL, clock.at(0));
	let (val_mid, set_mid) = tint.sample(clock.at(60));
	assert!(!set_mid);
	assert!(val_mid > 0.2 && val_mid < 0.95);

	let t_end = clock.at(130);
	assert_eq!(tint.sample(t_end), (1.0, true));

	tint.set_target(0.0, &tokens, REDUCED, t_end);
	assert_eq!(tint.sample(t_end), (0.0, true));
}

#[test]
fn reveal_motion_toggles_and_springs_continuously() {
	let tokens = MotionTokens::reference();
	let mut clock = Clock::new();
	let mut reveal = RevealMotion::new(false);

	let t0 = clock.at(0);
	assert!(!reveal.is_expanded());
	assert_eq!(reveal.sample(t0), (0.0, true));

	reveal.set_expanded(true, &tokens, FULL, t0);
	assert!(reveal.is_expanded());
	assert!(reveal.animates_height());

	let (val_mid, set_mid) = reveal.sample(clock.at(50));
	assert!(!set_mid);
	assert!(val_mid > 0.0 && val_mid < 1.0);

	let t_end = clock.at(1500);
	let (val_end, set_end) = reveal.sample(t_end);
	assert!(set_end);
	assert!((val_end - 1.0).abs() < 0.001);

	assert!(!reveal.toggle(&tokens, FULL, t_end));
	assert!(!reveal.is_expanded());
}

#[test]
fn float_motion_drives_entrance_exit_and_interruption() {
	let tokens = MotionTokens::reference();
	let mut clock = Clock::new();
	let mut float = FloatMotion::new();

	let t0 = clock.at(0);
	float.set_open(false, &tokens, FULL, t0);
	let initial = float.sample(t0);
	assert_eq!(initial.opacity, 0.0);
	assert!(initial.settled);

	float.set_open(true, &tokens, FULL, t0);
	let start = float.sample(t0);
	assert_eq!(start.opacity, 0.0);
	assert_eq!(start.offset_y, tokens.float.rise_px);
	assert!(!start.settled);

	let t_mid = clock.at(45);
	let mid = float.sample(t_mid);
	assert!(mid.opacity > 0.0 && mid.opacity < 1.0);
	assert!(mid.offset_y > 0.0 && mid.offset_y < tokens.float.rise_px);

	// Closing mid-entrance reverses from where the entrance was.
	float.set_open(false, &tokens, FULL, t_mid);
	let reversed = float.sample(t_mid);
	assert!((reversed.opacity - mid.opacity).abs() < 0.0001);
	assert!((reversed.offset_y - mid.offset_y).abs() < 0.0001);
	assert_eq!(float.current(), reversed);

	let settled = float.sample(clock.at(1545));
	assert_eq!(settled.opacity, 0.0);
	assert!(settled.settled);

	let open = FloatMotion::at_rest(true);
	assert_eq!(open.current(), veyyon_desktop_motion::FloatFrame {
		opacity:  1.0,
		offset_y: 0.0,
		settled:  true,
	});
}

#[test]
fn shift_motion_drives_flip_translation_and_respects_reduced_motion() {
	let tokens = MotionTokens::reference();
	let mut clock = Clock::new();
	let mut shift = ShiftMotion::new();
	assert_eq!(shift.current_offset(), 0.0);
	assert!(shift.is_settled());

	let t0 = clock.at(0);
	shift.record_shift(100.0, 150.0, &tokens, FULL, t0);
	assert!(!shift.is_settled());
	assert_eq!(shift.sample(t0), (-50.0, false));

	let (off_mid, set_mid) = shift.sample(clock.at(100));
	assert!(!set_mid);
	assert!(off_mid > -50.0 && off_mid < 0.0);

	// A second move mid-flight adds to the offset still showing.
	let t_second = clock.at(100);
	shift.record_shift(150.0, 170.0, &tokens, FULL, t_second);
	assert!((shift.sample(t_second).0 - (off_mid - 20.0)).abs() < 0.001);

	let t_end = clock.at(320);
	assert_eq!(shift.sample(t_end), (0.0, true));
	assert!(shift.is_settled());

	shift.record_shift(100.0, 200.0, &tokens, REDUCED, t_end);
	assert_eq!(shift.sample(t_end), (0.0, true));
	assert!(shift.is_settled());
}
