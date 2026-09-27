//! Motion driver for section reveal and collapse (`MotionRole::Reveal`).

use veyyon_gpui::motion::{
	Advance, Animator, FrameInstant, MotionFrame, MotionPolicy, MotionRole, MotionTokens,
	ResolvedMotion, resolve_motion,
};

/// Reveal progress of one section: 0.0 collapsed, 1.0 expanded.
#[derive(Debug, Clone, Copy)]
pub struct RevealMotion {
	progress:  Animator<FrameInstant>,
	expanded:  bool,
	fade_only: bool,
}

impl RevealMotion {
	/// A section at rest, expanded or collapsed.
	#[must_use]
	pub const fn new(expanded: bool) -> Self {
		Self {
			progress: Animator::at_rest(if expanded { 1.0 } else { 0.0 }),
			expanded,
			fade_only: false,
		}
	}

	/// Flips the section and returns whether it is now expanded.
	pub fn toggle(
		&mut self,
		tokens: &MotionTokens,
		policy: MotionPolicy,
		now: FrameInstant,
	) -> bool {
		self.set_expanded(!self.expanded, tokens, policy, now);
		self.expanded
	}

	/// Moves the section toward expanded or collapsed from its progress at
	/// `now`. Reduced motion runs the role's fade and leaves the height at its
	/// target.
	pub fn set_expanded(
		&mut self,
		expanded: bool,
		tokens: &MotionTokens,
		policy: MotionPolicy,
		now: FrameInstant,
	) {
		self.expanded = expanded;
		let motion = resolve_motion(MotionRole::Reveal, tokens, policy.reduced());
		self.fade_only = matches!(motion, ResolvedMotion::FadeOnly { .. });
		self
			.progress
			.apply(if expanded { 1.0 } else { 0.0 }, motion, policy, now);
	}

	/// Samples the progress at `now` and returns it with whether it is at rest.
	pub fn sample(&mut self, now: FrameInstant) -> (f32, bool) {
		let sample = self.progress.update(now);
		(sample.value, sample.at_rest)
	}

	/// Whether progress changes geometry rather than only opacity.
	#[must_use]
	pub const fn animates_height(&self) -> bool {
		!self.fade_only
	}

	/// Whether the section is targeted as expanded.
	#[must_use]
	pub const fn is_expanded(&self) -> bool {
		self.expanded
	}

	/// Whether the last sample found the progress at rest.
	#[must_use]
	pub const fn is_settled(&self) -> bool {
		self.progress.is_at_rest()
	}
}

impl Advance for RevealMotion {
	fn advance(&mut self, frame: &MotionFrame) -> bool {
		!self.sample(frame.now()).1
	}
}
