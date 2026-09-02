//! WHY THIS SUITE EXISTS
//!
//! Patch P7 adds explicit z-ordering (`.z_index(i32)`, `Window::with_z_index`)
//! within visual layers, independent of primitive kind or paint order.
//!
//! In complex UI layouts (such as floating badges, avatar rings, or tooltips
//! overlapping surfaces and images), elements with a higher explicit z-index
//! must always rasterize above lower z-index primitives, regardless of the
//! order they were inserted into the scene tree.
//!
//! THE CLASS THIS CLOSES: z-ordering bugs where later-declared DOM siblings
//! erroneously occlude earlier elements despite lower explicit z-index values.
//!
//! WHAT IT DOES NOT CATCH: 3D depth-buffer occlusion with intersecting
//! non-coplanar geometry.

use veyyon_desktop_scene::{HeadlessSession, RenderOptions, headless_context};
use veyyon_gpui::{
	App, AppContext, Context, IntoElement, ParentElement as _, Render, Styled as _, Window, div, px,
	rgb,
};

struct ZOrderScene {
	circle_on_top: bool,
}

impl Render for ZOrderScene {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let (bg_z, circle_z) = if self.circle_on_top { (1, 2) } else { (2, 1) };

		// Note: The circle (higher z) is declared FIRST, and the background (lower z)
		// is declared SECOND. Without explicit z-ordering, painter's algorithm would
		// draw the background on top of the circle.
		div()
			.size_full()
			.bg(rgb(0x000000))
			// Circle element: Green, positioned at (70, 70) to (130, 130)
			.child(
				div()
					.absolute()
					.top(px(70.0))
					.left(px(70.0))
					.w(px(60.0))
					.h(px(60.0))
					.rounded_full()
					.bg(rgb(0x22c55e))
					.z_index(circle_z),
			)
			// Base background quad: Red, positioned at (50, 50) to (150, 150)
			.child(
				div()
					.absolute()
					.top(px(50.0))
					.left(px(50.0))
					.w(px(100.0))
					.h(px(100.0))
					.bg(rgb(0xef4444))
					.z_index(bg_z),
			)
	}
}

fn sample_pixel(bytes: &[u8], width: usize, x: usize, y: usize) -> (u8, u8, u8, u8) {
	let idx = (y * width + x) * 4;
	(bytes[idx], bytes[idx + 1], bytes[idx + 2], bytes[idx + 3])
}

#[test]
fn a_circle_declared_above_an_image_renders_above_it() {
	let mut cx = headless_context().expect("headless context");
	let options = RenderOptions { width: 200, height: 200, scale_factor: 1.0, ..Default::default() };

	let mut session = HeadlessSession::open(&mut cx, &options, |_window, app: &mut App| {
		app.new(|_| ZOrderScene { circle_on_top: true })
	})
	.expect("open z-order session");

	// Frame 1: Circle has z_index 2, background has z_index 1 -> Center (100, 100)
	// must be GREEN
	let frame1 = session.frame().expect("capture frame 1");
	let bytes1 = frame1.frame.as_bytes();

	let center_f1 = sample_pixel(bytes1, 200, 100, 100);
	assert!(
		center_f1.1 > 180 && center_f1.0 < 50,
		"center pixel must be green (circle on top), got {center_f1:?}"
	);

	// Corner of the red background at (55, 55) (outside the circle) must still be
	// RED
	let bg_corner_f1 = sample_pixel(bytes1, 200, 55, 55);
	assert!(
		bg_corner_f1.0 > 200 && bg_corner_f1.1 < 100 && bg_corner_f1.2 < 100,
		"background corner pixel must be red, got {bg_corner_f1:?}"
	);

	// Invert z-order: Background now has z_index 2, circle has z_index 1
	session
		.update(|view, _, cx| {
			view.circle_on_top = false;
			cx.notify();
		})
		.expect("invert z-order");

	// Frame 2: Center (100, 100) must now be RED (background covers circle)
	let frame2 = session.frame().expect("capture frame 2");
	let bytes2 = frame2.frame.as_bytes();

	let center_f2 = sample_pixel(bytes2, 200, 100, 100);
	assert!(
		center_f2.0 > 200 && center_f2.1 < 100 && center_f2.2 < 100,
		"center pixel must be red (background on top), got {center_f2:?}"
	);
}
