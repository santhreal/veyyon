//! Motion driver for the streaming caret (`MotionRole::Caret`).
//!
//! While a reply streams, the caret blinks: fully on for half the role's
//! period and off for the other half. Idle, or under reduced motion, it is
//! steady on at opacity 1.0 and at rest, so it requests no frames.

use veyyon_gpui::motion::{
	Advance, Animator, FrameInstant, MotionFrame, MotionModel, MotionPolicy, MotionRole,
	MotionTokens, ResolvedMotion, resolve_motion,
};

/// Opacity of the caret while it is on.
const ON: f32 = 1.0;
/// Opacity of the caret while it is off.
const OFF: f32 = 0.0;

/// The caret's opacity: blinking while streaming, steady on otherwise.
#[derive(Debug, Clone, Copy)]
pub struct CaretMotion {
	opacity: Animator<FrameInstant>,
}

impl Default for CaretMotion {
	fn default() -> Self {
		Self::new()
	}
}

impl CaretMotion {
	/// A steady caret.
	#[must_use]
	pub const fn new() -> Self {
		Self { opacity: Animator::at_rest(ON) }
	}

	/// Starts the blink at `now` when streaming begins and ends it when
	/// streaming ends or reduced motion is on. A blink already running keeps
	/// its phase.
	pub fn set_streaming(
		&mut self,
		streaming: bool,
		tokens: &MotionTokens,
		policy: MotionPolicy,
		now: FrameInstant,
	) {
		let steady = matches!(
			resolve_motion(MotionRole::Caret, tokens, policy.reduced()),
			ResolvedMotion::SteadyOn
		);
		if !streaming || steady {
			self.opacity.snap(ON);
		} else if self.opacity.is_at_rest() {
			// The blink alternates between the value it starts from and its
			// target, so it starts from off: a blink from on to on would
			// never rest and never show.
			self
				.opacity
				.start(OFF, 0.0, ON, MotionModel::TwoStep(tokens.caret), policy, now);
		}
	}

	/// Samples the opacity at `now` and returns it with whether it is at rest.
	pub fn sample(&mut self, now: FrameInstant) -> (f32, bool) {
		let sample = self.opacity.update(now);
		(sample.value, sample.at_rest)
	}

	/// Whether the caret is steady.
	#[must_use]
	pub const fn is_settled(&self) -> bool {
		self.opacity.is_at_rest()
	}
}

impl Advance for CaretMotion {
	fn advance(&mut self, frame: &MotionFrame) -> bool {
		!self.sample(frame.now()).1
	}
}
