//! WHY THIS SUITE EXISTS
//!
//! Patch P8 adds subtree clipping to GPUI: both rounded-rectangle clipping (via
//! `ContentMask` corner radii / `overflow_hidden()`) and arbitrary path
//! clipping (via `window.with_clip_path(path, ...)`).
//!
//! When a subtree is clipped to a boundary, child primitives (quads, shadows,
//! text, underlines, sprites) drawn inside that subtree must be clipped at the
//! exact boundary in device pixels, correctly antialiased, at both 1x and 2x
//! scale factors.
//!
//! THE CLASS THIS CLOSES: subtree elements leaking or overflowing outside
//! rounded corner containers or arbitrary vector clipping boundaries.
//!
//! WHAT IT DOES NOT CATCH: non-determinism across different GPU hardware
//! architectures.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use veyyon_gpui::{
	App, AppContext, Context, HeadlessAppContext, IntoElement, ParentElement, Path, Pixels, Render,
	Size, Styled, Window, canvas, div, fill, hsla, point, px,
};

const fn frame_size() -> Size<Pixels> {
	Size { width: px(200.0), height: px(200.0) }
}

static RENDERER: Mutex<()> = Mutex::new(());

fn headless_context() -> (HeadlessAppContext, MutexGuard<'static, ()>) {
	let permit = RENDERER.lock().unwrap_or_else(PoisonError::into_inner);
	let text_system = Arc::new(gpui_wgpu::CosmicTextSystem::new("sans-serif"));
	let cx = HeadlessAppContext::with_platform(text_system, Arc::new(()), || {
		gpui_platform::current_headless_renderer()
	});
	(cx, permit)
}

struct RoundedClippedScene;

impl Render for RoundedClippedScene {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		// Outer container (200x200, black)
		div()
			.size_full()
			.bg(hsla(0.0, 0.0, 0.0, 1.0))
			// Rounded clipped container (100x100 at 50,50, rounded 24px, overflow_hidden)
			.child(
				div()
					.ml(px(50.0))
					.mt(px(50.0))
					.w(px(100.0))
					.h(px(100.0))
					.rounded(px(24.0))
					.overflow_hidden()
					// Child that exceeds container bounds (e.g. 100x100 white quad covering the corner)
					.child(div().size_full().bg(hsla(0.0, 0.0, 1.0, 1.0))),
			)
	}
}

/// A white fill over the whole frame, painted inside a triangular clip path
/// with vertices at the top-left, top-right and bottom-left corners. The
/// diagonal from (200, 0) to (0, 200) is the clip boundary.
struct PathClippedScene;

impl Render for PathClippedScene {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		div().size_full().bg(hsla(0.0, 0.0, 0.0, 1.0)).child(
			canvas(
				|_bounds, _window, _app| (),
				|bounds, (), window, _app| {
					let mut path = Path::new(bounds.origin);
					path.line_to(point(bounds.right(), bounds.top()));
					path.line_to(point(bounds.left(), bounds.bottom()));
					window.with_clip_path(path, |window| {
						window.paint_quad(fill(bounds, hsla(0.0, 0.0, 1.0, 1.0)));
					});
				},
			)
			.size_full(),
		)
	}
}

/// Renders the path-clipped scene and returns the frame bytes and its width.
fn render_path_clipped(scale_factor: f32) -> (Vec<u8>, usize) {
	let (mut cx, _permit) = headless_context();
	let frame = cx
		.render_frame(frame_size(), scale_factor, |_window, app: &mut App| {
			app.new(|_| PathClippedScene)
		})
		.expect("headless render");
	(frame.as_bytes().to_vec(), frame.width() as usize)
}

fn red_at(bytes: &[u8], width: usize, x: usize, y: usize) -> u8 {
	bytes[(y * width + x) * 4]
}

#[test]
fn a_path_clipped_subtree_clips_at_the_path_boundary_at_1x() {
	let (bytes, width) = render_path_clipped(1.0);
	assert!(red_at(&bytes, width, 50, 50) > 200, "inside the triangle is filled");
	assert!(red_at(&bytes, width, 90, 90) > 200, "just inside the diagonal is filled");
	assert_eq!(red_at(&bytes, width, 110, 110), 0, "just outside the diagonal is clipped");
	assert_eq!(red_at(&bytes, width, 150, 150), 0, "outside the triangle is clipped");
	assert_eq!(red_at(&bytes, width, 199, 199), 0, "the far corner is clipped");
}

#[test]
fn a_path_clipped_subtree_clips_at_the_path_boundary_at_2x() {
	let (bytes, width) = render_path_clipped(2.0);
	assert_eq!(width, 400);
	assert!(red_at(&bytes, width, 100, 100) > 200, "inside the triangle is filled at 2x");
	assert!(red_at(&bytes, width, 180, 180) > 200, "just inside the diagonal is filled at 2x");
	assert_eq!(red_at(&bytes, width, 220, 220), 0, "just outside the diagonal is clipped at 2x");
	assert_eq!(red_at(&bytes, width, 300, 300), 0, "outside the triangle is clipped at 2x");
}

#[test]
fn a_rounded_clipped_subtree_clips_at_the_boundary_at_1x() {
	let (mut cx, _permit) = headless_context();
	let frame = cx
		.render_frame(frame_size(), 1.0, |_window, app: &mut App| app.new(|_| RoundedClippedScene))
		.expect("headless render 1x");

	let width = frame.width() as usize;
	let bytes = frame.as_bytes();

	// Pixel inside the center of the clipped box (100, 100) should be white (R=255,
	// G=255, B=255)
	let center_idx = (100 * width + 100) * 4;
	assert!(bytes[center_idx] > 200, "center pixel should be white");

	// Pixel at the corner of the 100x100 box (52, 52) would be inside the box if
	// unrounded, but is clipped away by the 24px radius, so it remains black (R=0,
	// G=0, B=0).
	let corner_idx = (52 * width + 52) * 4;
	assert_eq!(bytes[corner_idx], 0, "corner pixel outside radius should be clipped to background");
}

#[test]
fn a_rounded_clipped_subtree_clips_at_the_boundary_at_2x() {
	let (mut cx, _permit) = headless_context();
	let frame = cx
		.render_frame(frame_size(), 2.0, |_window, app: &mut App| app.new(|_| RoundedClippedScene))
		.expect("headless render 2x");

	let width = frame.width() as usize;
	let bytes = frame.as_bytes();

	// At 2x scale:
	// Logical (100, 100) -> Device (200, 200)
	let center_idx = (200 * width + 200) * 4;
	assert!(bytes[center_idx] > 200, "center pixel should be white at 2x");

	// Logical (52, 52) -> Device (104, 104) is outside the 48px device radius
	// corner:
	let corner_idx = (104 * width + 104) * 4;
	assert_eq!(bytes[corner_idx], 0, "corner pixel outside radius should be clipped at 2x");
}
