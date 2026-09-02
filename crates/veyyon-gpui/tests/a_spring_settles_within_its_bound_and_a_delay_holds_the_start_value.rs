//! WHY THIS SUITE EXISTS
//!
//! Patch P3 adds an analytical spring integrator (`SpringConfig`,
//! `SpringState`) with stiffness, damping, and mass parameters, alongside
//! native delay on `Animation`.
//!
//! When configuring a spring with critical damping ($\zeta = 1.0$), it must
//! approach the target monotonically without overshooting. For an underdamped
//! spring ($\zeta < 1.0$), oscillation amplitude must remain strictly bounded
//! by the theoretical analytical decay. A delayed animation must maintain its
//! initial value for the entire configured delay.
//!
//! THE CLASS THIS CLOSES: spring physics instability, perpetual oscillation,
//! numerical drift, overshoot in critically damped springs, and premature
//! animation starts.
//!
//! WHAT IT DOES NOT CATCH: non-homogeneous external forces acting on springs
//! during flight.

use std::{cell::RefCell, rc::Rc, time::Duration};

use veyyon_desktop_scene::{HeadlessSession, RenderOptions, headless_context};
use veyyon_gpui::{
	Animation, AnimationExt as _, App, AppContext, Context, IntoElement, ParentElement as _, Render,
	SpringConfig, SpringState, Window, div,
};

struct DelayedAnimationView {
	rendered_deltas: Rc<RefCell<Vec<f32>>>,
}

impl Render for DelayedAnimationView {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let deltas = self.rendered_deltas.clone();
		let animation = Animation::new(Duration::from_secs(1)).with_delay(Duration::from_millis(500));

		div().child(div().with_animation("delayed", animation, move |this, delta| {
			deltas.borrow_mut().push(delta);
			this
		}))
	}
}

#[test]
fn a_spring_settles_within_its_bound_and_does_not_oscillate_past_damping() {
	// Critical damping (zeta = 1.0): monotonic approach with zero overshoot
	let critical_config = SpringConfig::new(100.0, 20.0, 1.0);
	let mut state = SpringState { position: 0.0, velocity: 0.0 };
	let target = 1.0f32;
	let epsilon = 0.001f32;
	let settle_time = critical_config.settle_time(state, target, epsilon);

	let dt = 0.01f32;
	let steps = (settle_time.as_secs_f32() / dt).ceil() as usize;
	for _ in 0..steps {
		state = critical_config.step(state, target, dt);
		assert!(
			state.position <= target + 1e-4,
			"critically damped spring must not overshoot target, got {}",
			state.position
		);
	}
	assert!(
		(state.position - target).abs() <= epsilon,
		"critically damped spring must reach rest within settle time"
	);

	// Underdamped spring (zeta = 0.5): oscillation amplitude bounded by
	// e^(-pi*zeta/sqrt(1-zeta^2))
	let underdamped_config = SpringConfig::new(100.0, 10.0, 1.0);
	let (_, damping_ratio) = underdamped_config.canonical();
	assert!((damping_ratio - 0.5).abs() < 1e-4);
	let max_theoretical_overshoot =
		(-std::f32::consts::PI * damping_ratio / (1.0 - damping_ratio * damping_ratio).sqrt()).exp();

	let mut under_state = SpringState { position: 0.0, velocity: 0.0 };
	let under_settle = underdamped_config.settle_time(under_state, target, epsilon);
	let mut max_observed_pos = 0.0f32;
	let under_steps = (under_settle.as_secs_f32() / dt).ceil() as usize;
	for _ in 0..under_steps {
		under_state = underdamped_config.step(under_state, target, dt);
		max_observed_pos = max_observed_pos.max(under_state.position);
	}

	let observed_overshoot = max_observed_pos - target;
	assert!(
		observed_overshoot <= max_theoretical_overshoot + 1e-3,
		"underdamped overshoot {observed_overshoot} exceeded theoretical bound \
		 {max_theoretical_overshoot}"
	);
	assert!(
		(under_state.position - target).abs() <= epsilon,
		"underdamped spring must reach rest within settle time"
	);
}

#[test]
fn a_delayed_animation_holds_start_value_during_delay() {
	let mut cx = headless_context().expect("headless context");
	let options = RenderOptions { width: 100, height: 100, scale_factor: 1.0, ..Default::default() };

	let rendered_deltas = Rc::new(RefCell::new(Vec::new()));
	let mut session = HeadlessSession::open(&mut cx, &options, {
		let deltas = rendered_deltas.clone();
		move |_window, app: &mut App| app.new(|_| DelayedAnimationView { rendered_deltas: deltas })
	})
	.expect("open delayed session");

	// Opening draws the window at least once (activation re-runs layout), and
	// every one of those renders is at the start value.
	{
		let deltas = rendered_deltas.borrow();
		assert!(!deltas.is_empty(), "the animation rendered on open");
		assert!(deltas.iter().all(|delta| *delta == 0.0), "start value on open, got {deltas:?}");
	}

	// Advance 250ms (within 500ms delay) -> still exactly 0.0
	session.advance(Duration::from_millis(250));
	let _ = session.frame();
	assert_eq!(*rendered_deltas.borrow().last().unwrap(), 0.0, "must hold 0.0 during initial delay");

	// Advance another 250ms (500ms total = exact delay boundary) -> still 0.0
	session.advance(Duration::from_millis(250));
	let _ = session.frame();
	assert_eq!(
		*rendered_deltas.borrow().last().unwrap(),
		0.0,
		"must hold 0.0 at exact delay boundary"
	);

	// Advance 250ms (750ms total, 250ms active into 1s animation = 0.25)
	session.advance(Duration::from_millis(250));
	let _ = session.frame();
	let delta_750 = *rendered_deltas.borrow().last().unwrap();
	assert!((delta_750 - 0.25).abs() < 0.05, "progress at 750ms should be ~0.25, got {delta_750}");

	// Advance 250ms (1000ms total, 500ms active into 1s animation = 0.50)
	session.advance(Duration::from_millis(250));
	let _ = session.frame();
	let delta_1000 = *rendered_deltas.borrow().last().unwrap();
	assert!(
		(delta_1000 - 0.50).abs() < 0.05,
		"progress at 1000ms should be ~0.50, got {delta_1000}"
	);

	// Advance 500ms (1500ms total, 1000ms active into 1s animation = 1.0, done)
	session.advance(Duration::from_millis(500));
	let _ = session.frame();
	let delta_1500 = *rendered_deltas.borrow().last().unwrap();
	assert_eq!(delta_1500, 1.0, "animation must complete at 1.0 upon full duration");
}
