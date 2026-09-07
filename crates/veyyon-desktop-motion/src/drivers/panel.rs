//! Motion driver for resizable panels, drawers, and split panes
//! (`MotionRole::Panel`).
//!
//! Provides direct position tracking while active/dragging, bounds enforcement,
//! and velocity-preserving spring snapping on release (§7.1, §8.23).

use std::time::Instant;

use crate::{
	curves::EasingCurve,
	registry::{AnimatorKey, AnimatorRegistry, SurfaceId},
	role::{
		DirectThenSpringModel, DurationModel, MotionModel, MotionRole, ResolvedMotion, resolve_motion,
	},
	spring::SpringModel,
	tokens::MotionTokens,
};

/// Motion driver for resizable panels and split panes (`MotionRole::Panel`).
///
/// Supports direct tracking while dragging, minimum/maximum width bounds,
/// and snapping via spring on release.
#[derive(Debug)]
pub struct PanelMotion {
	surface_id:    SurfaceId,
	slot:          u64,
	registry:      AnimatorRegistry,
	current_width: f32,
	bounds:        Option<(f32, f32)>,
	last_sample_t: Option<Instant>,
	last_width:    f32,
	drag_velocity: f32,
	dragging:      bool,
}

impl PanelMotion {
	/// Creates a new panel motion driver initialized at `initial_width`.
	#[must_use]
	pub fn new(surface_id: SurfaceId, slot: u64, initial_width: f32) -> Self {
		let mut registry = AnimatorRegistry::new();
		let key = AnimatorKey::new(surface_id, MotionRole::Panel, slot);
		let model = MotionModel::DirectThenSpring(DirectThenSpringModel {
			snap_spring: SpringModel { stiffness: 180.0, damping: 22.0, mass: 1.0 },
		});
		registry.get_or_create_with_initial(key, initial_width, initial_width, model, Instant::now());
		Self {
			surface_id,
			slot,
			registry,
			current_width: initial_width,
			bounds: None,
			last_sample_t: None,
			last_width: initial_width,
			drag_velocity: 0.0,
			dragging: false,
		}
	}

	/// Creates a panel motion driver with explicit minimum and maximum width
	/// bounds.
	#[must_use]
	pub fn with_bounds(
		surface_id: SurfaceId,
		slot: u64,
		initial_width: f32,
		min_width: f32,
		max_width: f32,
	) -> Self {
		let clamped = initial_width.clamp(min_width, max_width);
		let mut motion = Self::new(surface_id, slot, clamped);
		motion.bounds = Some((min_width, max_width));
		motion
	}

	/// Sets or updates the allowable width bounds `(min_width, max_width)`.
	pub const fn set_bounds(&mut self, min_width: f32, max_width: f32) {
		self.bounds = Some((min_width, max_width));
	}

	/// Returns the configured bounds `(min_width, max_width)` if set.
	#[must_use]
	pub const fn bounds(&self) -> Option<(f32, f32)> {
		self.bounds
	}

	/// Direct position update while dragging. Computes instantaneous drag
	/// velocity.
	pub fn set_direct(&mut self, width: f32, now: Instant) {
		let clamped_width = self
			.bounds
			.map_or(width, |(min_w, max_w)| width.clamp(min_w, max_w));
		if let Some(prev_t) = self.last_sample_t {
			let dt = now
				.checked_duration_since(prev_t)
				.map_or(0.0, |d| d.as_secs_f32());
			if dt > 0.001 {
				self.drag_velocity = (clamped_width - self.last_width) / dt;
			}
		}
		self.last_sample_t = Some(now);
		self.last_width = clamped_width;
		self.current_width = clamped_width;
		self.dragging = true;
	}

	/// Releases drag and begins snap-spring animation towards `snap_target`.
	pub fn release_to_snap(
		&mut self,
		snap_target: f32,
		tokens: &MotionTokens,
		reduced: bool,
		now: Instant,
	) {
		self.dragging = false;
		let target = self
			.bounds
			.map_or(snap_target, |(min_w, max_w)| snap_target.clamp(min_w, max_w));
		let key = AnimatorKey::new(self.surface_id, MotionRole::Panel, self.slot);
		if let ResolvedMotion::Spring(spring) = resolve_motion(MotionRole::Panel, tokens, reduced) {
			let model = MotionModel::Spring(spring);
			let anim =
				self
					.registry
					.get_or_create_with_initial(key, self.current_width, target, model, now);
			anim.start_value = self.current_width;
			anim.start_velocity = self.drag_velocity;
			anim.current_value = self.current_width;
			anim.target_value = target;
			anim.current_velocity = self.drag_velocity;
			anim.start_time = now;
			anim.model = model;
			anim.is_at_rest =
				(self.current_width - target).abs() < 0.001 && self.drag_velocity.abs() < 0.01;
		} else {
			let model = MotionModel::Duration(DurationModel {
				duration_ms: 0,
				curve:       EasingCurve::Linear,
			});
			let anim = self
				.registry
				.get_or_create_with_initial(key, target, target, model, now);
			anim.start_value = target;
			anim.start_velocity = 0.0;
			anim.current_value = target;
			anim.target_value = target;
			anim.current_velocity = 0.0;
			anim.is_at_rest = true;
			self.current_width = target;
		}
	}

	/// Samples the current panel width and settled state.
	pub fn sample(&mut self, now: Instant) -> (f32, bool) {
		if self.dragging {
			return (self.current_width, false);
		}
		let key = AnimatorKey::new(self.surface_id, MotionRole::Panel, self.slot);
		if let Some((pos, vel, at_rest)) = self.registry.sample_full(&key, now) {
			let clamped = self
				.bounds
				.map_or(pos, |(min_w, max_w)| pos.clamp(min_w, max_w));
			self.current_width = clamped;
			if at_rest {
				self.drag_velocity = 0.0;
			} else {
				self.drag_velocity = vel;
			}
			(clamped, at_rest)
		} else {
			(self.current_width, true)
		}
	}

	/// Returns the current panel width.
	#[must_use]
	pub const fn current_width(&self) -> f32 {
		self.current_width
	}

	/// Returns the instantaneous drag / release velocity in pixels per second.
	#[must_use]
	pub const fn drag_velocity(&self) -> f32 {
		self.drag_velocity
	}

	/// Returns true if the panel is actively being dragged.
	#[must_use]
	pub const fn is_dragging(&self) -> bool {
		self.dragging
	}

	/// Returns true if all panel animations are settled at rest.
	#[must_use]
	pub fn is_settled(&self) -> bool {
		!self.dragging
			&& self.registry.is_at_rest(&AnimatorKey::new(
				self.surface_id,
				MotionRole::Panel,
				self.slot,
			))
	}
}
