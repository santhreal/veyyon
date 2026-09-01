//! WHY THIS SUITE EXISTS
//!
//! Patch P10 gives the fork a headless offscreen surface, and section 9 of the
//! desktop plan rests its whole iteration engine on one property of it: the
//! same scene renders the same bytes twice. Every clutter metric, every
//! perceptual diff and every contact-sheet cell compares frames, so a renderer
//! that varies by a pixel between runs turns each comparison into noise and
//! reports it as a change.
//!
//! The fork has its own tests for the patch. They prove it inside the fork's
//! tree. This proves the property through the pin, which is what this
//! repository depends on: a rebase that drops the patch, a revision bump that
//! lands a different one, or an adapter-selection change that picks another GPU
//! all break here rather than in a sweep whose output merely looks surprising.
//!
//! It also pins the wiring, which was the actual defect the first time. P10
//! landed `WgpuHeadlessRenderer` while `current_headless_renderer` still
//! returned `None` off macOS and `gpui_platform` carried no `gpui_wgpu`
//! dependency, so nothing on Linux could construct one. Measured by replacing
//! the factory below with `|| None`: `render_frame` returns an error, so the
//! hole surfaces as a failed render rather than a wrong frame. The third case
//! asserts the factory directly, which is what names the cause instead of the
//! symptom.
//!
//! THE CLASS THIS CLOSES: non-determinism reaching the iteration engine through
//! the renderer, and the headless path resolving to no renderer at all.
//!
//! WHAT IT DOES NOT CATCH: determinism across machines or drivers. Frames are
//! compared within one process on one adapter, so this says nothing about two
//! developers seeing the same bytes. It does not judge whether the frame is
//! CORRECT, only that it is stable, non-empty and the size that was asked for.
//!
//! Ignored by default: it needs a GPU with a Vulkan ICD, which a CI runner does
//! not have. Run with `--ignored` on a machine that has one.

use std::{collections::BTreeSet, sync::Arc};

use veyyon_gpui::{
	App, AppContext, Context, HeadlessAppContext, IntoElement, ParentElement, Pixels, Render, Size,
	Styled, Window, div, hsla, px,
};

/// A scene with a fill, a nested box and text, so the comparison covers more
/// than a cleared buffer. A frame that is entirely one colour compares equal to
/// itself even when the renderer drew nothing.
struct ProbeScene;

impl Render for ProbeScene {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		div().size_full().bg(hsla(0.6, 0.4, 0.2, 1.0)).child(
			div()
				.w(px(120.0))
				.h(px(48.0))
				.bg(hsla(0.1, 0.8, 0.6, 1.0))
				.child("veyyon"),
		)
	}
}

const fn frame_size() -> Size<Pixels> {
	Size { width: px(320.0), height: px(200.0) }
}

/// A context wired to the current platform's headless renderer.
/// `HeadlessAppContext::new` hands back a context with no renderer at all,
/// which renders nothing.
fn headless_context() -> HeadlessAppContext {
	let text_system = Arc::new(gpui_wgpu::CosmicTextSystem::new("sans-serif"));
	HeadlessAppContext::with_platform(text_system, Arc::new(()), || {
		gpui_platform::current_headless_renderer()
	})
}

fn render_probe(cx: &mut HeadlessAppContext, scale_factor: f32) -> (Vec<u8>, u32, u32) {
	let frame = cx
		.render_frame(frame_size(), scale_factor, |_window, app: &mut App| app.new(|_| ProbeScene))
		.expect("headless render");
	(frame.as_bytes().to_vec(), frame.width(), frame.height())
}

#[test]
#[ignore = "requires a GPU with a Vulkan ICD; run with --ignored on a machine that has one"]
fn the_same_scene_renders_identical_bytes_twice_in_one_process() {
	let mut cx = headless_context();
	let (first, width, height) = render_probe(&mut cx, 1.0);
	let (second, ..) = render_probe(&mut cx, 1.0);

	assert_eq!(width, 320, "the frame is the width that was asked for");
	assert_eq!(height, 200, "the frame is the height that was asked for");

	assert_eq!(
		first.len(),
		(width as usize) * (height as usize) * 4,
		"readback is tightly packed RGBA8; wgpu's 256-byte row alignment must be unpadded, or every \
		 metric reads padding as pixels",
	);
	assert_eq!(first.len(), second.len(), "two renders produced different buffer lengths");

	// Compare by index so a failure names where the frames diverge rather than
	// dumping two 256 KB buffers.
	let divergence = first
		.iter()
		.zip(second.iter())
		.position(|(left, right)| left != right);
	assert!(
		divergence.is_none(),
		"two renders of one scene diverged at byte {divergence:?}; the iteration engine compares \
		 frames, so a renderer that is not deterministic reports every sweep cell as changed",
	);

	// Determinism alone is satisfied by a buffer that is entirely one value, so
	// this separates a stable frame from a frame that was never drawn: a
	// renderer that clears and draws nothing, or a scene whose element tree
	// produced no primitives.
	let distinct: BTreeSet<&[u8]> = first.chunks_exact(4).collect();
	assert!(
		distinct.len() > 1,
		"the frame holds a single pixel value, so nothing was drawn; determinism over a uniform \
		 buffer proves nothing",
	);
}

#[test]
#[ignore = "requires a GPU with a Vulkan ICD; run with --ignored on a machine that has one"]
fn the_scale_factor_changes_the_device_pixels_and_not_the_logical_size() {
	// A contact sheet renders one scene at several densities. If the scale
	// factor were ignored every cell would come back the same size, and the
	// sweep would compare 1x frames while reporting 2x.
	let mut cx = headless_context();
	let (_, one_w, one_h) = render_probe(&mut cx, 1.0);
	let (_, two_w, two_h) = render_probe(&mut cx, 2.0);

	assert_eq!((one_w, one_h), (320, 200));
	assert_eq!(
		(two_w, two_h),
		(640, 400),
		"a scale factor of 2 doubles the device pixels while the logical size is unchanged",
	);
}

#[test]
#[ignore = "requires a GPU with a Vulkan ICD; run with --ignored on a machine that has one"]
fn the_platform_supplies_a_headless_renderer_on_this_machine() {
	// The direct form of the defect above. P10's renderer existed for a
	// revision during which this returned None off macOS, and every headless
	// render quietly produced an empty frame instead of failing.
	assert!(
		gpui_platform::current_headless_renderer().is_some(),
		"this platform reports no headless renderer, so every offscreen render returns an empty \
		 frame",
	);
}
