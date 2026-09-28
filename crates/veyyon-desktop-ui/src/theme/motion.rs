//! The motion of every transition the window runs. Each is interruptible
//! through `gpui::motion::Animator`, which keeps velocity when a target moves.
//!
//! Under reduced motion (`App::reduce_motion`) position and scale land at once
//! and fades last at most [`REDUCED_FADE_MS`].

use veyyon_gpui::{
	Pixels,
	motion::{DurationModel, Easing, MotionModel, SpringConfig},
	px,
};

/// A unit-mass spring that settles in about `response` seconds with the given
/// damping ratio (1.0 is critical).
const fn spring(response: f32, damping_ratio: f32) -> SpringConfig {
	let omega = core::f32::consts::TAU / response;
	SpringConfig::new(omega * omega, 2.0 * damping_ratio * omega, 1.0)
}

const fn timed(duration_ms: u32, curve: Easing) -> DurationModel {
	DurationModel { duration_ms, curve }
}

/// Sidebar, right panel and terminal drawer opening, closing and settling
/// after a resize.
pub const REGION: MotionModel = MotionModel::Spring(spring(0.26, 0.92));

/// A row moving to a new position, and a section expanding or collapsing.
pub const LAYOUT: MotionModel = MotionModel::Spring(spring(0.30, 0.86));

/// A transcript entry appearing: fades in while rising [`REVEAL_RISE`].
pub const REVEAL: MotionModel = MotionModel::Duration(timed(160, Easing::EaseResort));

/// Distance an entry rises while it is revealed.
pub const REVEAL_RISE: Pixels = px(6.0);

/// A run of streamed text fading in from [`STREAM_FADE_FROM`].
pub const STREAM_FADE: MotionModel = MotionModel::Duration(timed(120, Easing::EaseResort));

/// Opacity a run of streamed text is first drawn at, so the frame after a
/// token already shows it.
pub const STREAM_FADE_FROM: f32 = 0.4;

/// A palette, menu or popover opening: scales up from [`POPOVER_SCALE`].
pub const POPOVER_OPEN: MotionModel = MotionModel::Duration(timed(120, Easing::EaseResort));

/// A palette, menu or popover closing.
pub const POPOVER_CLOSE: MotionModel = MotionModel::Duration(timed(90, Easing::Decel));

/// Scale a popover opens from and closes to.
pub const POPOVER_SCALE: f32 = 0.98;

/// A hover or press color change.
pub const HOVER: MotionModel = MotionModel::Duration(timed(80, Easing::Linear));

/// Seconds a spinner takes for one turn.
pub const SPIN_PERIOD: f32 = 0.8;

/// Longest fade that runs under reduced motion.
pub const REDUCED_FADE_MS: u32 = 80;
