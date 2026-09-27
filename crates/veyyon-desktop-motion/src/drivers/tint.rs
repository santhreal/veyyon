//! Motion driver for tint transitions: hover, selection, focus, badge color,
//! scrim (`MotionRole::Tint`).

use veyyon_gpui::motion::{
	Advance, Animator, FrameInstant, MotionFrame, MotionPolicy, MotionRole, MotionTokens,
	resolve_motion,
};

/// A tint amount moving between states under `MotionRole::Tint`.
#[derive(Debug, Clone, Copy)]
pub struct TintMotion {
	value: Animator<FrameInstant>,
}

impl TintMotion {
	/// A tint at rest on `initial`.
	#[must_use]
	pub const fn new(initial: f32) -> Self {
		Self { value: Animator::at_rest(initial) }
	}

	/// Moves the tint toward `target` from its value at `now`. Reduced motion
	/// places it on `target`.
	pub fn set_target(
		&mut self,
		target: f32,
		tokens: &MotionTokens,
		policy: MotionPolicy,
		now: FrameInstant,
	) {
		let motion = resolve_motion(MotionRole::Tint, tokens, policy.reduced());
		self.value.apply(target, motion, policy, now);
	}

	/// Samples the tint at `now` and returns its value and whether it is at
	/// rest.
	pub fn sample(&mut self, now: FrameInstant) -> (f32, bool) {
		let sample = self.value.update(now);
		(sample.value, sample.at_rest)
	}

	/// The value at the last sample.
	#[must_use]
	pub const fn current_value(&self) -> f32 {
		self.value.value()
	}

	/// Whether the last sample found the tint at rest.
	#[must_use]
	pub const fn is_settled(&self) -> bool {
		self.value.is_at_rest()
	}
}

impl Advance for TintMotion {
	fn advance(&mut self, frame: &MotionFrame) -> bool {
		!self.sample(frame.now()).1
	}
}
