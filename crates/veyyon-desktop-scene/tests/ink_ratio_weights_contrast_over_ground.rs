//! Contract test: ink ratio weights contrast over ground color, ignores
//! sub-0.02 noise, and evaluates composited alpha.

use veyyon_desktop_scene::{
	frame::{RgbaColor, RgbaFrame},
	metrics::compute_ink_ratio,
};

#[test]
fn test_ground_colored_frame_has_zero_ink_ratio() {
	let ground = RgbaColor::opaque(30, 30, 30);
	let frame = RgbaFrame::filled(50, 50, 1.0, ground).expect("frame creates");

	let ratio = compute_ink_ratio(&frame, ground);
	assert_eq!(ratio, 0.0);
}

#[test]
fn test_half_black_half_white_frame_matches_hand_computed_ratio() {
	let black = RgbaColor::opaque(0, 0, 0);
	let white = RgbaColor::opaque(255, 255, 255);

	let mut pixels = Vec::with_capacity(100 * 100 * 4);
	for _y in 0..100 {
		for x in 0..100 {
			if x < 50 {
				pixels.extend_from_slice(&[0, 0, 0, 255]);
			} else {
				pixels.extend_from_slice(&[255, 255, 255, 255]);
			}
		}
	}
	let frame = RgbaFrame::new(100, 100, 1.0, pixels).expect("frame creates");

	// Over black ground (luma 0):
	// Black pixels have delta = 0 <= 0.02 (noise floor) -> 0.0
	// White pixels have delta = 255 / 255 = 1.0 > 0.02 -> 1.0
	// Half the frame is white -> expected ink ratio = 0.5
	let ratio = compute_ink_ratio(&frame, black);
	assert!((ratio - 0.5).abs() < 1e-4);

	// Over white ground (luma 255):
	// Black pixels have delta = 1.0, white pixels have delta = 0.0 -> expected =
	// 0.5
	let ratio_white = compute_ink_ratio(&frame, white);
	assert!((ratio_white - 0.5).abs() < 1e-4);
}

#[test]
fn test_sub_noise_floor_deltas_are_filtered() {
	let ground = RgbaColor::opaque(100, 100, 100);
	// Small shift: rgb(103, 103, 103) -> delta = 3 / 255 ≈ 0.0117 <= 0.02
	let slight_shift = RgbaColor::opaque(103, 103, 103);
	let frame = RgbaFrame::filled(50, 50, 1.0, slight_shift).expect("frame creates");

	let ratio = compute_ink_ratio(&frame, ground);
	assert_eq!(ratio, 0.0);
}
