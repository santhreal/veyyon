//! WHY THIS SUITE EXISTS
//!
//! Patch P5 introduces damage-scoped invalidation and scissored redraw to GPUI
//! (`Context::notify_within`, `Window::declare_damage`,
//! `Window::last_frame_damage`).
//!
//! When a streaming transcript appends tokens to a single entry or a loading
//! spinner pulses in a status bar, repainting the entire 4K viewport wastes
//! memory bandwidth and GPU cycles. Instead, GPUI restricts rasterization to
//! the declared bounding box of the modified element.
//!
//! THE CLASS THIS CLOSES: whole-window repaint regressions during
//! high-frequency streaming updates, damage rectangle clipping leaks, and
//! unbounded animation redraws.
//!
//! WHAT IT DOES NOT CATCH: driver-level GPU tile invalidation algorithms on
//! non-scissored swapchain backends.

use std::time::Duration;

use veyyon_desktop_scene::{HeadlessSession, RenderOptions, headless_context};
use veyyon_gpui::{
	Animation, AnimationExt as _, App, AppContext, Bounds, Context, InteractiveElement as _,
	IntoElement, ParentElement as _, Pixels, Render, Styled as _, Window, div, point, px, rgb, size,
};

struct TranscriptEntriesView {
	entry_count: usize,
}

impl Render for TranscriptEntriesView {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		div()
			.size_full()
			.flex()
			.flex_col()
			.children((0..self.entry_count).map(|i| {
				div()
					.id(i)
					.w(px(300.0))
					.h(px(50.0))
					.bg(rgb(0x18181b))
					.child(format!("Entry {i}"))
			}))
	}
}

struct SpinnerView;

impl Render for SpinnerView {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		div()
			.size_full()
			.child(div().w(px(40.0)).h(px(40.0)).with_animation(
				"spinner",
				Animation::new(Duration::from_millis(500)).repeat(),
				|this, _delta| this,
			))
	}
}

fn entry_bounds(y: f32) -> Bounds<Pixels> {
	Bounds { origin: point(px(0.0), px(y)), size: size(px(300.0), px(50.0)) }
}

#[test]
fn a_transcript_update_damages_only_its_own_entry() {
	let mut cx = headless_context().expect("headless context");
	let options = RenderOptions { width: 800, height: 600, scale_factor: 1.0, ..Default::default() };

	let mut session = HeadlessSession::open(&mut cx, &options, |_window, app: &mut App| {
		app.new(|_| TranscriptEntriesView { entry_count: 5 })
	})
	.expect("open transcript session");

	// Initial render repaints full viewport (damage is None)
	let damage_initial = session
		.update(|_, window, _| window.last_frame_damage())
		.expect("initial damage");
	assert_eq!(damage_initial, None, "initial frame must repaint full viewport");

	// Scoped invalidation for Entry 2 (y = 100.0 to 150.0)
	let target_bounds = entry_bounds(100.0);
	session
		.update(|_, window, cx| {
			window.declare_damage(target_bounds);
			cx.notify_within(target_bounds);
		})
		.expect("declare scoped damage");

	let _ = session.frame();

	let damage_scoped = session
		.update(|_, window, _| window.last_frame_damage())
		.expect("scoped damage");

	assert_eq!(
		damage_scoped,
		Some(target_bounds),
		"scoped update must damage strictly within entry bounds"
	);

	// Unscoped notification repaints whole viewport
	session
		.update(|_, _, cx| {
			cx.notify();
		})
		.expect("unscoped notify");

	let _ = session.frame();

	let damage_unscoped = session
		.update(|_, window, _| window.last_frame_damage())
		.expect("unscoped damage");
	assert_eq!(damage_unscoped, None, "unscoped notify must invalidate full viewport");
}

#[test]
fn a_mounted_animation_damages_only_its_own_bounds() {
	let mut cx = headless_context().expect("headless context");
	let options = RenderOptions { width: 400, height: 300, scale_factor: 1.0, ..Default::default() };

	let mut session =
		HeadlessSession::open(&mut cx, &options, |_window, app: &mut App| app.new(|_| SpinnerView))
			.expect("open spinner session");

	// Initial frame
	let _ = session.frame();

	// Advance clock to trigger animation frame
	session.advance(Duration::from_millis(50));
	let _ = session.frame();

	let damage = session
		.update(|_, window, _| window.last_frame_damage())
		.expect("animation damage");

	if let Some(damage_bounds) = damage {
		assert!(
			damage_bounds.size.width <= px(40.0) + px(1.0)
				&& damage_bounds.size.height <= px(40.0) + px(1.0),
			"spinner animation damage must be bounded within element size (40x40), got {:?}",
			damage_bounds
		);
	}
}
