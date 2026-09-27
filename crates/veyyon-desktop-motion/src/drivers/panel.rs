//! Motion driver for resizable panels, drawers, and split panes
//! (`MotionRole::Panel`).
//!
//! The width follows the pointer while dragged. On release it springs to the
//! snap target from the width and velocity the drag left it with.

use veyyon_gpui::motion::{
	Advance, Animator, FrameInstant, MotionFrame, MotionPolicy, MotionRole, MotionTokens,
	ResolvedMotion, Timestamp as _, resolve_motion,
};

/// Drag samples closer together than this, in seconds, do not update the
/// drag velocity.
const MIN_DRAG_INTERVAL_SECONDS: f32 = 0.001;

/// The last pointer sample of a drag.
#[derive(Debug, Clone, Copy)]
struct DragSample {
	at:    FrameInstant,
	width: f32,
}

/// A panel width: tracked directly while dragged, sprung on release.
#[derive(Debug, Clone, Copy)]
pub struct PanelMotion {
	width:         Animator<FrameInstant>,
	current_width: f32,
	bounds:        Option<(f32, f32)>,
	last_drag:     Option<DragSample>,
	drag_velocity: f32,
	dragging:      bool,
}

impl PanelMotion {
	/// A panel at rest at `initial_width`.
	#[must_use]
	pub const fn new(initial_width: f32) -> Self {
		Self {
			width:         Animator::at_rest(initial_width),
			current_width: initial_width,
			bounds:        None,
			last_drag:     None,
			drag_velocity: 0.0,
			dragging:      false,
		}
	}

	/// A panel at rest at `initial_width`, clamped to `min_width..=max_width`,
	/// which bounds every later width.
	#[must_use]
	pub const fn with_bounds(initial_width: f32, min_width: f32, max_width: f32) -> Self {
		let mut motion = Self::new(initial_width.clamp(min_width, max_width));
		motion.bounds = Some((min_width, max_width));
		motion
	}

	/// Sets the bounds `(min_width, max_width)` every later width is clamped to.
	pub const fn set_bounds(&mut self, min_width: f32, max_width: f32) {
		self.bounds = Some((min_width, max_width));
	}

	/// The bounds `(min_width, max_width)`, if set.
	#[must_use]
	pub const fn bounds(&self) -> Option<(f32, f32)> {
		self.bounds
	}

	fn clamp(&self, width: f32) -> f32 {
		self
			.bounds
			.map_or(width, |(min, max)| width.clamp(min, max))
	}

	/// Places the panel at `width` under the pointer at `now` and measures the
	/// drag velocity from the previous drag sample.
	pub fn set_direct(&mut self, width: f32, now: FrameInstant) {
		let width = self.clamp(width);
		if let Some(previous) = self.last_drag {
			let interval = now.seconds_since(previous.at);
			if interval > MIN_DRAG_INTERVAL_SECONDS {
				self.drag_velocity = (width - previous.width) / interval;
			}
		}
		self.last_drag = Some(DragSample { at: now, width });
		self.current_width = width;
		self.dragging = true;
	}

	/// Ends the drag and springs toward `snap_target` from the dragged width
	/// and velocity. Reduced motion places the panel on the target.
	pub fn release_to_snap(
		&mut self,
		snap_target: f32,
		tokens: &MotionTokens,
		policy: MotionPolicy,
		now: FrameInstant,
	) {
		self.dragging = false;
		let target = self.clamp(snap_target);
		if let motion @ ResolvedMotion::Spring(_) =
			resolve_motion(MotionRole::Panel, tokens, policy.reduced())
		{
			self.width.start(
				self.current_width,
				self.drag_velocity,
				target,
				motion.model(),
				policy,
				now,
			);
		} else {
			self.width.snap(target);
			self.current_width = target;
			self.drag_velocity = 0.0;
		}
	}

	/// Samples the width at `now` and returns it with whether it is at rest. A
	/// dragged panel is where the pointer put it and is not at rest.
	pub fn sample(&mut self, now: FrameInstant) -> (f32, bool) {
		if self.dragging {
			return (self.current_width, false);
		}
		let sample = self.width.update(now);
		self.current_width = self.clamp(sample.value);
		self.drag_velocity = if sample.at_rest { 0.0 } else { sample.velocity };
		(self.current_width, sample.at_rest)
	}

	/// The width at the last sample or drag.
	#[must_use]
	pub const fn current_width(&self) -> f32 {
		self.current_width
	}

	/// The drag or release velocity in pixels per second.
	#[must_use]
	pub const fn drag_velocity(&self) -> f32 {
		self.drag_velocity
	}

	/// Whether the panel is being dragged.
	#[must_use]
	pub const fn is_dragging(&self) -> bool {
		self.dragging
	}

	/// Whether the panel is released and the last sample found it at rest.
	#[must_use]
	pub const fn is_settled(&self) -> bool {
		!self.dragging && self.width.is_at_rest()
	}
}

impl Advance for PanelMotion {
	/// A dragged panel moves with pointer events, not with frames, so only a
	/// released spring requests the next frame.
	fn advance(&mut self, frame: &MotionFrame) -> bool {
		!self.dragging && !self.sample(frame.now()).1
	}
}
