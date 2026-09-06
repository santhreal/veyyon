//! WHY THIS SUITE EXISTS
//!
//! Patch P4 adds animatable style properties (`StyleTransition`,
//! `TransitionHandle`) enabling declared CSS-style transitions on interactive
//! GPUI elements.
//!
//! When an interactive state changes (such as hover or active state), the style
//! properties must interpolate monotonically over the declared duration. If the
//! state changes again mid-flight, the transition must smoothly re-anchor from
//! its current interpolated value rather than snapping to the original or new
//! target.
//!
//! THE CLASS THIS CLOSES: color and geometry snapping on quick hover gestures,
//! discontinuous jump artifacts, and non-monotonic style interpolation.
//!
//! WHAT IT DOES NOT CATCH: non-interpolatable discrete style properties (such
//! as display/flex layout direction changes).

use std::time::Duration;

use veyyon_desktop_scene::{HeadlessSession, RenderOptions, headless_context};
use veyyon_gpui::{
	App, AppContext, Context, InteractiveElement as _, IntoElement, Render, Styled as _,
	TransitionHandle, Window, div, hsla, px,
};

struct TransitionTestView {
	hovered: bool,
	handle:  TransitionHandle,
}

impl Render for TransitionTestView {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let mut element = div()
			.id("transition-box")
			.size(px(100.0))
			.bg(hsla(0.0, 1.0, 0.5, 1.0))
			.transition(Duration::from_millis(100))
			.transition_handle(self.handle.clone());

		if self.hovered {
			element = element.bg(hsla(0.6, 1.0, 0.5, 1.0));
		}

		element
	}
}

#[test]
fn a_hover_transition_ramps_monotonically_over_duration() {
	let mut cx = headless_context().expect("headless context");
	let options = RenderOptions { width: 100, height: 100, scale_factor: 1.0, ..Default::default() };

	let handle = TransitionHandle::new();
	let mut session = HeadlessSession::open(&mut cx, &options, {
		let handle = handle.clone();
		move |_window, app: &mut App| app.new(|_| TransitionTestView { hovered: false, handle })
	})
	.expect("open transition session");

	let initial_color = handle
		.current_style()
		.expect("current style")
		.background
		.expect("background")
		.color()
		.expect("fill color")
		.as_solid()
		.expect("solid color");
	assert!((initial_color.h - 0.0).abs() < 1e-4);

	// Trigger hover state change
	session
		.update(|view, _, cx| {
			view.hovered = true;
			cx.notify();
		})
		.expect("trigger hover");

	let mut previous_hue = initial_color.h;
	for _ in 0..5 {
		session.advance(Duration::from_millis(20));
		let _ = session.frame();

		let current_hue = handle
			.current_style()
			.expect("style during ramp")
			.background
			.expect("background")
			.color()
			.expect("fill color")
			.as_solid()
			.expect("solid color")
			.h;

		assert!(
			current_hue >= previous_hue,
			"color ramp must be monotonic: prev {previous_hue}, current {current_hue}"
		);
		previous_hue = current_hue;
	}

	// At or after 100ms, hue reaches target 0.6
	assert!((previous_hue - 0.6).abs() < 1e-2, "reached target hue 0.6, got {previous_hue}");
}

#[test]
fn a_mid_transition_state_change_reanchors_without_discontinuity() {
	let mut cx = headless_context().expect("headless context");
	let options = RenderOptions { width: 100, height: 100, scale_factor: 1.0, ..Default::default() };

	let handle = TransitionHandle::new();
	let mut session = HeadlessSession::open(&mut cx, &options, {
		let handle = handle.clone();
		move |_window, app: &mut App| app.new(|_| TransitionTestView { hovered: false, handle })
	})
	.expect("open transition session");

	// Start hover
	session
		.update(|view, _, cx| {
			view.hovered = true;
			cx.notify();
		})
		.expect("start hover");

	// Advance 40ms into 100ms transition
	session.advance(Duration::from_millis(40));
	let _ = session.frame();

	let hue_at_flip = handle
		.current_style()
		.expect("style at flip")
		.background
		.expect("bg")
		.color()
		.expect("fill color")
		.as_solid()
		.expect("solid color")
		.h;
	assert!(
		hue_at_flip > 0.1 && hue_at_flip < 0.5,
		"mid-flight hue must be intermediate, got {hue_at_flip}"
	);

	// Flip hover mid-flight
	session
		.update(|view, _, cx| {
			view.hovered = false;
			cx.notify();
		})
		.expect("flip hover");

	let hue_immediately_after_flip = handle
		.current_style()
		.expect("style immediately after flip")
		.background
		.expect("bg")
		.color()
		.expect("fill color")
		.as_solid()
		.expect("solid color")
		.h;

	assert!(
		(hue_immediately_after_flip - hue_at_flip).abs() < 0.02,
		"mid-ramp flip must re-anchor from current value {hue_at_flip}, got \
		 {hue_immediately_after_flip}"
	);

	// Advance clock towards unhovered target (0.0)
	let mut previous_hue = hue_immediately_after_flip;
	for _ in 0..5 {
		session.advance(Duration::from_millis(20));
		let _ = session.frame();

		let current_hue = handle
			.current_style()
			.expect("style during reverse ramp")
			.background
			.expect("bg")
			.color()
			.expect("fill color")
			.as_solid()
			.expect("solid color")
			.h;

		assert!(
			current_hue <= previous_hue + 1e-4,
			"reverse color ramp must decrease monotonically: prev {previous_hue}, current \
			 {current_hue}"
		);
		previous_hue = current_hue;
	}

	assert!(previous_hue < 0.05, "must settle back near 0.0, got {previous_hue}");
}
