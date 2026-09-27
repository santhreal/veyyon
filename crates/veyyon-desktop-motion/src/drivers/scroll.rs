//! Motion driver for programmatic smooth scroll jumps (`MotionRole::Scroll`).

use veyyon_gpui::motion::{
	Advance, Animator, FrameInstant, MotionFrame, MotionPolicy, MotionRole, MotionTokens,
	resolve_motion,
};

/// A scroll offset moving to a programmatic target under
/// `MotionRole::Scroll`.
#[derive(Debug, Clone, Copy)]
pub struct ScrollMotion {
	offset: Animator<FrameInstant>,
}

impl ScrollMotion {
	/// An offset at rest on `initial`.
	#[must_use]
	pub const fn new(initial: f32) -> Self {
		Self { offset: Animator::at_rest(initial) }
	}

	/// Scrolls toward `target` from the offset at `now`. Reduced motion jumps.
	pub fn scroll_to(
		&mut self,
		target: f32,
		tokens: &MotionTokens,
		policy: MotionPolicy,
		now: FrameInstant,
	) {
		let motion = resolve_motion(MotionRole::Scroll, tokens, policy.reduced());
		self.offset.apply(target, motion, policy, now);
	}

	/// Places the offset where a manual scroll left it and ends any
	/// programmatic scroll.
	pub fn set_direct(&mut self, offset: f32) {
		self.offset.snap(offset);
	}

	/// Samples the offset at `now` and returns it with whether it is at rest.
	pub fn sample(&mut self, now: FrameInstant) -> (f32, bool) {
		let sample = self.offset.update(now);
		(sample.value, sample.at_rest)
	}

	/// The offset at the last sample.
	#[must_use]
	pub const fn current_offset(&self) -> f32 {
		self.offset.value()
	}

	/// Whether the last sample found the offset at rest.
	#[must_use]
	pub const fn is_settled(&self) -> bool {
		self.offset.is_at_rest()
	}
}

impl Advance for ScrollMotion {
	fn advance(&mut self, frame: &MotionFrame) -> bool {
		!self.sample(frame.now()).1
	}
}
