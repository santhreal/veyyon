//! Motion preset catalog.
//!
//! Durations and spring constants are declared here. Surfaces select a preset
//! by interaction meaning; they do not define local timing literals.

use super::{Curve, Program, Spring, Steps, Tween};

pub const LAYOUT: Program = Program::Spring(Spring {
	omega:            22.0,
	damping_ratio:    0.90,
	epsilon_value:    0.10,
	epsilon_velocity: 1.0,
	hard_limit_ms:    360,
});
pub const SHARED_ELEMENT: Program = Program::Spring(Spring {
	omega:            20.0,
	damping_ratio:    0.82,
	epsilon_value:    0.10,
	epsilon_velocity: 1.0,
	hard_limit_ms:    420,
});
pub const DROP: Program = Program::Spring(Spring {
	omega:            26.0,
	damping_ratio:    0.78,
	epsilon_value:    0.10,
	epsilon_velocity: 1.0,
	hard_limit_ms:    320,
});
pub const SELECT: Program = Program::Spring(Spring {
	omega:            30.0,
	damping_ratio:    0.92,
	epsilon_value:    0.05,
	epsilon_velocity: 1.0,
	hard_limit_ms:    240,
});
pub const PRESS_OUT: Program = Program::Spring(Spring {
	omega:            34.0,
	damping_ratio:    0.76,
	epsilon_value:    0.002,
	epsilon_velocity: 0.02,
	hard_limit_ms:    180,
});
pub const SCROLL: Program = Program::Spring(Spring {
	omega:            18.0,
	damping_ratio:    1.0,
	epsilon_value:    0.25,
	epsilon_velocity: 2.0,
	hard_limit_ms:    450,
});

pub const ENTER: Program = tween(180, Curve::new(0.16, 1.0, 0.3, 1.0));
pub const EXIT: Program = tween(110, Curve::new(0.4, 0.0, 1.0, 1.0));
pub const HOVER_IN: Program = tween(90, Curve::new(0.2, 0.0, 0.0, 1.0));
pub const HOVER_OUT: Program = tween(140, Curve::new(0.4, 0.0, 0.2, 1.0));
pub const PRESS_IN: Program = tween(55, Curve::new(0.2, 0.0, 0.0, 1.0));
pub const CROSSFADE: Program = tween(120, Curve::new(0.4, 0.0, 0.2, 1.0));
pub const METER: Program = tween(180, Curve::new(0.2, 0.0, 0.0, 1.0));
pub const DISCLOSURE_ROTATE: Program = tween(160, Curve::new(0.2, 0.0, 0.0, 1.0));
pub const DISCLOSURE_INK: Program = tween(100, Curve::new(0.2, 0.0, 0.0, 1.0));
pub const ACTIVITY: Program =
	Program::Steps(Steps { count: 8, period_ms: 1_600, rest_steps: 4 });

pub const STAGGER_MS: u16 = 10;
pub const MAX_STAGGER_MS: u16 = 60;

const fn tween(duration_ms: u16, curve: Curve) -> Program {
	Program::Tween(Tween { duration_ms, curve })
}

pub const fn stagger_delay(index: usize) -> u16 {
	let delay = index.saturating_mul(STAGGER_MS as usize);
	if delay > MAX_STAGGER_MS as usize {
		MAX_STAGGER_MS
	} else {
		delay as u16
	}
}
