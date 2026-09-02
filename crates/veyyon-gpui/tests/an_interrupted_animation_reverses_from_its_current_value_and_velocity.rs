//! WHY THIS SUITE EXISTS
//!
//! Patch P2 adds animator identity and persistent animation handles
//! (`AnimationHandle`, `SpringHandle`) to GPUI. Animations in a dynamic UI are
//! frequently interrupted (e.g., user rapidly hovering and unhovering, or view
//! unmounting and remounting).
//!
//! When an animation is interrupted mid-flight, it must preserve its current
//! progress and physical velocity rather than resetting to initial state or
//! snapping to the target.
//!
//! THE CLASS THIS CLOSES: visual snapping on rapid interaction, lost velocity
//! on spring direction changes, and progress reset to zero when elements
//! remount mid-animation.
//!
//! WHAT IT DOES NOT CATCH: non-linear custom bezier easing curves outside
//! standard spring and duration animators.

use std::{cell::RefCell, rc::Rc, time::Duration};

use veyyon_desktop_scene::{HeadlessSession, RenderOptions, headless_context};
use veyyon_gpui::{
	Animation, AnimationExt as _, AnimationHandle, App, AppContext, Context, IntoElement,
	ParentElement as _, Pixels, Render, SpringAnimation, SpringConfig, SpringHandle, Styled as _,
	Window, div, prelude::FluentBuilder as _, px,
};

struct SpringInterruptView {
	target:          Pixels,
	handle:          SpringHandle,
	rendered_values: Rc<RefCell<Vec<Pixels>>>,
}

impl Render for SpringInterruptView {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let rendered = self.rendered_values.clone();
		let animation = SpringAnimation::new(SpringConfig::new(100.0, 5.0, 1.0))
			.to(self.target)
			.from(px(0.0))
			.with_handle(self.handle.clone());

		div().with_spring("spring", animation, move |this, val| {
			rendered.borrow_mut().push(val);
			this.left(val)
		})
	}
}

struct RemountAnimationView {
	mounted: bool,
	handle:  AnimationHandle,
}

impl Render for RemountAnimationView {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let handle = self.handle.clone();
		div().when(self.mounted, |this| {
			this.child(div().with_animation_handle(
				"anim",
				Animation::new(Duration::from_secs(1)),
				handle,
				move |child, _delta| child,
			))
		})
	}
}

#[test]
fn an_interrupted_animation_reverses_from_its_current_value_and_velocity() {
	let mut cx = headless_context().expect("headless context");
	let options = RenderOptions { width: 200, height: 200, scale_factor: 1.0, ..Default::default() };

	// 1. Spring interruption preserves velocity
	let spring_handle = SpringHandle::new();
	let rendered_values = Rc::new(RefCell::new(Vec::new()));

	let mut session = HeadlessSession::open(&mut cx, &options, {
		let handle = spring_handle.clone();
		let values = rendered_values.clone();
		move |_window, app: &mut App| {
			app.new(|_| SpringInterruptView { target: px(100.0), handle, rendered_values: values })
		}
	})
	.expect("open spring session");

	// Step forward until spring reaches approximately 40% (40.0 px)
	let mut steps = 0usize;
	while spring_handle.position().unwrap_or(0.0) < 40.0 && steps < 100 {
		session.advance(Duration::from_millis(10));
		let _ = session.frame();
		steps += 1;
	}
	assert!(steps < 100, "spring must advance within 100 steps");

	let pos_at_interrupt = spring_handle
		.position()
		.expect("position at interrupt must exist");
	let vel_at_interrupt = spring_handle
		.velocity()
		.expect("velocity at interrupt must exist");

	assert!(
		pos_at_interrupt >= 40.0 && pos_at_interrupt < 65.0,
		"position must be around 40%, got {pos_at_interrupt}"
	);
	assert!(vel_at_interrupt > 0.0, "forward velocity must be positive, got {vel_at_interrupt}");

	// Interrupt by reversing target back to 0.0
	session
		.update(|view, _, cx| {
			view.target = px(0.0);
			cx.notify();
		})
		.expect("update view target");

	let vel_after_reversal = spring_handle
		.velocity()
		.expect("velocity after reversal must exist");
	assert!(
		vel_after_reversal > 0.0,
		"non-zero velocity must be retained upon target reversal, got {vel_after_reversal}"
	);

	// Advance 5ms: inertia carries position strictly past pos_at_interrupt before
	// reversing
	session.advance(Duration::from_millis(5));
	let _ = session.frame();

	let pos_stepped = spring_handle.position().expect("stepped position");
	assert!(
		pos_stepped >= pos_at_interrupt,
		"forward inertia must carry position forward, was {pos_at_interrupt}, stepped {pos_stepped}"
	);

	// Settle back to 0.0
	for _ in 0..150 {
		session.advance(Duration::from_millis(20));
		let _ = session.frame();
	}

	let final_pos = spring_handle.position().expect("final position");
	assert!(final_pos.abs() < 1.0, "spring must settle back to 0.0, got {final_pos}");
}

#[test]
fn a_remounted_animation_preserves_its_flight_progress() {
	let mut cx = headless_context().expect("headless context");
	let options = RenderOptions { width: 200, height: 200, scale_factor: 1.0, ..Default::default() };

	let anim_handle = AnimationHandle::new();
	let mut session = HeadlessSession::open(&mut cx, &options, {
		let handle = anim_handle.clone();
		move |_window, app: &mut App| app.new(|_| RemountAnimationView { mounted: true, handle })
	})
	.expect("open remount session");

	// Advance clock by 400ms (40% of 1s animation)
	session.advance(Duration::from_millis(400));
	let _ = session.frame();

	let progress_before_unmount = anim_handle
		.progress()
		.expect("progress before unmount must exist");
	assert!(
		(progress_before_unmount - 0.4).abs() < 0.08,
		"progress should be around 0.4, got {progress_before_unmount}"
	);

	// Unmount
	session
		.update(|view, _, cx| {
			view.mounted = false;
			cx.notify();
		})
		.expect("unmount");
	let _ = session.frame();

	// Remount
	session
		.update(|view, _, cx| {
			view.mounted = true;
			cx.notify();
		})
		.expect("remount");
	let _ = session.frame();

	let progress_after_remount = anim_handle
		.progress()
		.expect("progress after remount must exist");
	assert!(
		progress_after_remount >= progress_before_unmount,
		"remounting must not reset progress to zero: before {progress_before_unmount}, after \
		 {progress_after_remount}"
	);
}
