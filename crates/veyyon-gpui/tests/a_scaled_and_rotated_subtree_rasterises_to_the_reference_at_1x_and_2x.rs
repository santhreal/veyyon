//! WHY THIS SUITE EXISTS
//!
//! Patch P1 adds 2x3 affine transformation support to GPUI's element pipeline,
//! composing translation, rotation, and scaling down the view tree into vertex
//! shader matrix transformations.
//!
//! When a subtree is scaled and rotated, child primitives must be rasterized to
//! the analytically expected geometry without vertex distortion or coordinate
//! clipping bugs, at both 1x and 2x device pixel ratios.
//!
//! THE CLASS THIS CLOSES: affine matrix inversion errors, rotation origin
//! drift, scale distortion, and scale-factor coordinate mismatches in
//! transformed subtrees.
//!
//! WHAT IT DOES NOT CATCH: non-affine projective transformations and
//! platform-specific GPU subpixel rasterizer rounding modes.

use std::f32::consts::FRAC_PI_4;

use veyyon_desktop_scene::{HeadlessSession, RenderOptions, headless_context};
use veyyon_gpui::{
	App, AppContext, Context, IntoElement, ParentElement as _, Radians, Render, Styled as _, Window,
	div, px, radians, rgb,
};

struct TransformedScene {
	rotation:     Radians,
	scale_factor: f32,
}

impl Render for TransformedScene {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		div()
			.size_full()
			.bg(rgb(0x000000))
			.flex()
			.items_center()
			.justify_center()
			.child(
				div()
					.w(px(80.0))
					.h(px(80.0))
					.bg(rgb(0xffffff))
					.rotate(self.rotation)
					.scale(self.scale_factor),
			)
	}
}

fn sample_pixel(bytes: &[u8], width: usize, x: usize, y: usize) -> (u8, u8, u8, u8) {
	let idx = (y * width + x) * 4;
	(bytes[idx], bytes[idx + 1], bytes[idx + 2], bytes[idx + 3])
}

fn downsample_2x(bytes: &[u8], width: usize, height: usize) -> Vec<u8> {
	let out_w = width / 2;
	let out_h = height / 2;
	let mut out = vec![0u8; out_w * out_h * 4];

	for y in 0..out_h {
		for x in 0..out_w {
			let src_y = y * 2;
			let src_x = x * 2;

			for c in 0..4 {
				let p00 = bytes[(src_y * width + src_x) * 4 + c] as u32;
				let p10 = bytes[(src_y * width + (src_x + 1)) * 4 + c] as u32;
				let p01 = bytes[((src_y + 1) * width + src_x) * 4 + c] as u32;
				let p11 = bytes[((src_y + 1) * width + (src_x + 1)) * 4 + c] as u32;

				let avg = ((p00 + p10 + p01 + p11) / 4) as u8;
				out[(y * out_w + x) * 4 + c] = avg;
			}
		}
	}

	out
}

#[test]
fn a_scaled_and_rotated_subtree_rasterises_to_the_reference_at_1x_and_2x() {
	let mut cx = headless_context().expect("headless context");

	// 1x DPR Render
	let options_1x =
		RenderOptions { width: 200, height: 200, scale_factor: 1.0, ..Default::default() };

	let bytes_1x = {
		let mut session_1x = HeadlessSession::open(&mut cx, &options_1x, |_window, app: &mut App| {
			app.new(|_| TransformedScene { rotation: radians(FRAC_PI_4), scale_factor: 1.2 })
		})
		.expect("open 1x session");

		let captured_1x = session_1x.frame().expect("capture 1x frame");
		assert_eq!(captured_1x.frame.width(), 200);
		assert_eq!(captured_1x.frame.height(), 200);
		captured_1x.frame.as_bytes().to_vec()
	};

	// Center pixel must be fully white (interior)
	let center_1x = sample_pixel(&bytes_1x, 200, 100, 100);
	assert!(center_1x.0 > 240, "center pixel must be white, got {center_1x:?}");

	// Far corner must be black (exterior)
	let corner_1x = sample_pixel(&bytes_1x, 200, 10, 10);
	assert!(corner_1x.0 < 15, "corner pixel must be black, got {corner_1x:?}");

	// The 80px square, scaled 1.2 and rotated 45° about its centre, is a
	// diamond around (100, 100) with a half-diagonal of 40 · 1.2 · √2 ≈ 67.9px.
	// A point 60px below the centre is inside that diamond but outside the
	// unrotated 1.2x square (half-side 48), and (140, 140) is inside the
	// unrotated square but outside the diamond (|dx| + |dy| = 80). Together they
	// pin the rotation, the scale and the origin; the unscaled diamond
	// (half-diagonal 56.6) would leave (100, 160) black.
	let below_1x = sample_pixel(&bytes_1x, 200, 100, 160);
	assert!(below_1x.0 > 240, "(100, 160) is inside the rotated, scaled square, got {below_1x:?}");
	let diagonal_1x = sample_pixel(&bytes_1x, 200, 140, 140);
	assert!(diagonal_1x.0 < 15, "(140, 140) is outside the rotated square, got {diagonal_1x:?}");

	// 2x DPR Render
	let options_2x =
		RenderOptions { width: 200, height: 200, scale_factor: 2.0, ..Default::default() };

	let mut session_2x = HeadlessSession::open(&mut cx, &options_2x, |_window, app: &mut App| {
		app.new(|_| TransformedScene { rotation: radians(FRAC_PI_4), scale_factor: 1.2 })
	})
	.expect("open 2x session");
	let captured_2x = session_2x.frame().expect("capture 2x frame");
	let bytes_2x = captured_2x.frame.as_bytes();
	assert_eq!(captured_2x.frame.width(), 400);
	assert_eq!(captured_2x.frame.height(), 400);

	// Center at 2x must also be white
	let center_2x = sample_pixel(bytes_2x, 400, 200, 200);
	assert!(center_2x.0 > 240, "2x center pixel must be white, got {center_2x:?}");
	let below_2x = sample_pixel(bytes_2x, 400, 200, 320);
	assert!(
		below_2x.0 > 240,
		"2x (200, 320) is inside the rotated, scaled square, got {below_2x:?}"
	);
	let diagonal_2x = sample_pixel(bytes_2x, 400, 280, 280);
	assert!(diagonal_2x.0 < 15, "2x (280, 280) is outside the rotated square, got {diagonal_2x:?}");

	// Compare 1x rasterization with downsampled 2x rasterization
	let downsampled = downsample_2x(bytes_2x, 400, 400);
	let mut matching_pixels = 0usize;
	let total_pixels = 200 * 200;

	for y in 0..200 {
		for x in 0..200 {
			let p1 = sample_pixel(&bytes_1x, 200, x, y);
			let p2 = sample_pixel(&downsampled, 200, x, y);

			// Tolerance of 35 levels for antialiasing boundary differences
			let diff = (p1.0 as i32 - p2.0 as i32).abs();
			if diff < 35 {
				matching_pixels += 1;
			}
		}
	}

	let agreement_ratio = matching_pixels as f64 / total_pixels as f64;
	assert!(
		agreement_ratio > 0.95,
		"1x and downsampled 2x must agree over 95% of pixels, got {:.2}%",
		agreement_ratio * 100.0
	);
}
