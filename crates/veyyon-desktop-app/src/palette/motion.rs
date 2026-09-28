//! The palette's open and close motion: a fade with a scale from
//! [`motion::POPOVER_SCALE`], under [`motion::POPOVER_OPEN`] and
//! [`motion::POPOVER_CLOSE`]. Under reduced motion both land at once.

use veyyon_desktop_ui::theme::motion;
use veyyon_gpui::{
	App, Window,
	motion::{Animator, FrameInstant, MotionDriver, MotionModel},
};

/// Where the palette is in its life.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
	/// Not drawn.
	Closed,
	/// Drawn and taking input.
	Open,
	/// Drawn while the close motion runs; takes no input.
	Closing,
}

/// The opacity and scale the card draws with, kept across frames.
pub struct Presence {
	phase:   Phase,
	opacity: Animator<FrameInstant>,
	scale:   Animator<FrameInstant>,
	driver:  MotionDriver,
}

impl Presence {
	/// A closed palette.
	pub fn new() -> Self {
		Self {
			phase:   Phase::Closed,
			opacity: Animator::at_rest(0.0),
			scale:   Animator::at_rest(motion::POPOVER_SCALE),
			driver:  MotionDriver::default(),
		}
	}

	/// The phase.
	pub const fn phase(&self) -> Phase {
		self.phase
	}

	/// Starts the open motion from where the palette is.
	pub fn open(&mut self, cx: &App) {
		if self.phase == Phase::Closed {
			self.opacity.snap(0.0);
			self.scale.snap(motion::POPOVER_SCALE);
		}
		self.phase = Phase::Open;
		drive(&mut self.opacity, 1.0, motion::POPOVER_OPEN, cx);
		drive(&mut self.scale, 1.0, motion::POPOVER_OPEN, cx);
	}

	/// Starts the close motion. Does nothing unless the palette is open.
	pub fn close(&mut self, cx: &App) {
		if self.phase != Phase::Open {
			return;
		}
		self.phase = Phase::Closing;
		drive(&mut self.opacity, 0.0, motion::POPOVER_CLOSE, cx);
		drive(&mut self.scale, motion::POPOVER_SCALE, motion::POPOVER_CLOSE, cx);
	}

	/// Advances both values to this frame, requests the next frame while
	/// either moves, and ends a close motion that came to rest. Returns the
	/// opacity and how far, 0 to 1, the card is from its resting place.
	pub fn step(&mut self, window: &mut Window, cx: &App) -> (f32, f32) {
		let mut frame = self.driver.begin(cx);
		frame.track(&mut self.opacity);
		frame.track(&mut self.scale);
		self.driver.end(frame, window);
		if self.phase == Phase::Closing && self.opacity.is_at_rest() {
			self.phase = Phase::Closed;
		}
		let travel = (1.0 - self.scale.value()) / (1.0 - motion::POPOVER_SCALE);
		(self.opacity.value(), travel.clamp(0.0, 1.0))
	}
}

/// Moves `value` toward `target` under `model`, or lands it at once under
/// reduced motion.
fn drive(value: &mut Animator<FrameInstant>, target: f32, model: MotionModel, cx: &App) {
	let policy = cx.motion_policy();
	if policy.reduced() {
		value.snap(target);
	} else {
		value.retarget(target, model, policy, cx.frame_instant());
	}
}
