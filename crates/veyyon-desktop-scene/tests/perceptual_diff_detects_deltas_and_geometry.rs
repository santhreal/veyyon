//! Contract test: perceptual diff reports unchanged frames, rejects geometry
//! mismatches with named errors, and quantifies pixel deltas precisely.

use veyyon_desktop_scene::{
	frame::{FrameError, RgbaColor, RgbaFrame},
	metrics::perceptual_diff,
};

#[test]
fn test_identical_frames_report_unchanged() {
	let color = RgbaColor::opaque(128, 64, 32);
	let a = RgbaFrame::filled(20, 20, 1.0, color).expect("frame creates");
	let b = RgbaFrame::filled(20, 20, 1.0, color).expect("frame creates");

	let diff = perceptual_diff(&a, &b).expect("diff computes");
	assert!(diff.is_unchanged());
	assert_eq!(diff.changed_fraction, 0.0);
	assert_eq!(diff.mean_delta, 0.0);
	assert_eq!(diff.max_delta, 0.0);
}

#[test]
fn test_geometry_mismatch_returns_named_error() {
	let white = RgbaColor::opaque(255, 255, 255);
	let a = RgbaFrame::filled(20, 20, 1.0, white).expect("frame creates");
	let b = RgbaFrame::filled(20, 30, 1.0, white).expect("frame creates");

	let err = perceptual_diff(&a, &b).expect_err("mismatch must error");
	assert_eq!(err, FrameError::GeometryMismatch {
		a_width:  20,
		a_height: 20,
		b_width:  20,
		b_height: 30,
	});
}

#[test]
fn test_single_pixel_delta_is_quantified_accurately() {
	let black = RgbaColor::opaque(0, 0, 0);
	let a = RgbaFrame::filled(10, 10, 1.0, black).expect("frame creates");

	// Frame B is identical to A except 1 white pixel at index 0 (out of 100 pixels)
	let mut pixels = vec![0u8; 10 * 10 * 4];
	for (i, byte) in pixels.iter_mut().enumerate() {
		if i % 4 == 3 {
			*byte = 255;
		}
	}
	// Make first pixel white: rgb(255, 255, 255, 255)
	if let Some(r) = pixels.get_mut(0) {
		*r = 255;
	}
	if let Some(g) = pixels.get_mut(1) {
		*g = 255;
	}
	if let Some(b) = pixels.get_mut(2) {
		*b = 255;
	}

	let b = RgbaFrame::new(10, 10, 1.0, pixels).expect("frame creates");

	let diff = perceptual_diff(&a, &b).expect("diff computes");
	assert!(!diff.is_unchanged());

	// 1 changed pixel out of 100 = 0.01 fraction
	assert!((diff.changed_fraction - 0.01).abs() < 1e-4);
	// Single pixel changed from luma 0 to 255 (delta 1.0), over 100 pixels mean is
	// 0.01
	assert!((diff.mean_delta - 0.01).abs() < 1e-4);
	assert!((diff.max_delta - 1.0).abs() < 1e-4);
}
