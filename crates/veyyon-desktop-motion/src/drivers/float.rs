//! Motion driver for popovers, palettes, menus, dialogs and announcements
//! (`MotionRole::Float`).

use veyyon_gpui::motion::{
	Advance, Animator, DurationModel, Easing, FrameInstant, MotionFrame, MotionModel, MotionPolicy,
	MotionRole, MotionTokens, ResolvedMotion, resolve_motion,
};

/// One frame of a float's entrance or exit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FloatFrame {
	/// Opacity, from 0.0 closed to 1.0 open.
	pub opacity:  f32,
	/// Downward offset in pixels, zero once open.
	pub offset_y: f32,
	/// Whether the rise and the fade are both at rest.
	pub settled:  bool,
}

/// A float's rise and fade: 0.0 closed, 1.0 open.
///
/// The rise runs the role's spring over `rise_px`, and the opacity runs a
/// duration fade. Reduced motion runs only the fade.
#[derive(Debug, Clone, Copy)]
pub struct FloatMotion {
	position: Animator<FrameInstant>,
	opacity:  Animator<FrameInstant>,
	rise_px:  f32,
	open:     bool,
}

impl Default for FloatMotion {
	fn default() -> Self {
		Self::new()
	}
}

impl FloatMotion {
	/// A float at rest closed. Opening it runs the entrance.
	#[must_use]
	pub const fn new() -> Self {
		Self::at_rest(false)
	}

	/// A float at rest open or closed, with no entrance to run.
	#[must_use]
	pub const fn at_rest(open: bool) -> Self {
		let value = if open { 1.0 } else { 0.0 };
		Self {
			position: Animator::at_rest(value),
			opacity: Animator::at_rest(value),
			rise_px: 0.0,
			open,
		}
	}

	/// Moves the float toward open or closed from its state at `now`. A target
	/// it already has leaves the motion running.
	pub fn set_open(
		&mut self,
		open: bool,
		tokens: &MotionTokens,
		policy: MotionPolicy,
		now: FrameInstant,
	) {
		if open == self.open {
			return;
		}
		self.open = open;
		let target = if open { 1.0 } else { 0.0 };
		let motion = resolve_motion(MotionRole::Float, tokens, policy.reduced());
		let (rise_px, fade_ms) = match motion {
			ResolvedMotion::Spring(_) => (tokens.float.rise_px, tokens.float.fade_duration_ms),
			ResolvedMotion::FadeOnly { duration_ms }
			| ResolvedMotion::Duration { duration_ms, .. } => (0.0, duration_ms),
			ResolvedMotion::Instant | ResolvedMotion::SteadyOn => (0.0, 0),
		};
		self.rise_px = rise_px;
		self.position.apply(target, motion, policy, now);
		let fade = MotionModel::Duration(DurationModel {
			duration_ms: fade_ms,
			curve:       Easing::EaseOut,
		});
		self.opacity.retarget(target, fade, policy, now);
	}

	/// Samples the float at `now`.
	pub fn sample(&mut self, now: FrameInstant) -> FloatFrame {
		let position = self.position.update(now);
		let opacity = self.opacity.update(now);
		FloatFrame {
			opacity:  opacity.value.clamp(0.0, 1.0),
			offset_y: (1.0 - position.value) * self.rise_px,
			settled:  position.at_rest && opacity.at_rest,
		}
	}

	/// The frame at the last sample.
	#[must_use]
	pub fn current(&self) -> FloatFrame {
		FloatFrame {
			opacity:  self.opacity.value().clamp(0.0, 1.0),
			offset_y: (1.0 - self.position.value()) * self.rise_px,
			settled:  self.is_settled(),
		}
	}

	/// Whether the last sample found the rise and the fade at rest.
	#[must_use]
	pub const fn is_settled(&self) -> bool {
		self.position.is_at_rest() && self.opacity.is_at_rest()
	}
}

impl Advance for FloatMotion {
	fn advance(&mut self, frame: &MotionFrame) -> bool {
		!self.sample(frame.now()).settled
	}
}
