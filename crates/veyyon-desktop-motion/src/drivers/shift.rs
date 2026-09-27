//! Motion driver for FLIP layout shift transitions (`MotionRole::Shift`).
//!
//! A row that moved is drawn at its old position and translated to its new
//! one: the offset starts at the distance moved and animates to zero, so the
//! layout changes at once and no sibling reflows.

use veyyon_gpui::motion::{
	Advance, Animator, FrameInstant, MotionFrame, MotionPolicy, MotionRole, MotionTokens,
	ResolvedMotion, resolve_motion,
};

/// Moves closer than this, in pixels, are not moves.
const MOVE_TOLERANCE_PX: f32 = 0.001;

/// The translation of one row from where it was drawn to where it is laid out.
#[derive(Debug, Clone, Copy)]
pub struct ShiftMotion {
	offset: Animator<FrameInstant>,
}

impl Default for ShiftMotion {
	fn default() -> Self {
		Self::new()
	}
}

impl ShiftMotion {
	/// A row at rest where it is laid out.
	#[must_use]
	pub const fn new() -> Self {
		Self { offset: Animator::at_rest(0.0) }
	}

	/// Records that the row moved from `previous_pos` to `current_pos`. The
	/// offset jumps by the distance moved, added to the offset still showing
	/// at `now`, and animates back to zero. Reduced motion places the row.
	pub fn record_shift(
		&mut self,
		previous_pos: f32,
		current_pos: f32,
		tokens: &MotionTokens,
		policy: MotionPolicy,
		now: FrameInstant,
	) {
		let delta = previous_pos - current_pos;
		if delta.abs() <= MOVE_TOLERANCE_PX {
			return;
		}
		match resolve_motion(MotionRole::Shift, tokens, policy.reduced()) {
			motion @ ResolvedMotion::Duration { .. } => {
				let showing = self.offset.sample(now).value;
				self
					.offset
					.start(delta + showing, 0.0, 0.0, motion.model(), policy, now);
			},
			_ => self.offset.snap(0.0),
		}
	}

	/// Samples the offset at `now` and returns it with whether it is at rest.
	pub fn sample(&mut self, now: FrameInstant) -> (f32, bool) {
		let sample = self.offset.update(now);
		(sample.value, sample.at_rest)
	}

	/// The offset at the last sample or shift.
	#[must_use]
	pub const fn current_offset(&self) -> f32 {
		self.offset.value()
	}

	/// Whether the last sample found the row at rest.
	#[must_use]
	pub const fn is_settled(&self) -> bool {
		self.offset.is_at_rest()
	}
}

impl Advance for ShiftMotion {
	fn advance(&mut self, frame: &MotionFrame) -> bool {
		!self.sample(frame.now()).1
	}
}
