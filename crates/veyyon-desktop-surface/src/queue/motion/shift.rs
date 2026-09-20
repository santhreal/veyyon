//! Per-row move (shift) choreography for the queue rail (§5.2, §7.3).

use std::{collections::HashMap, time::Instant};

use veyyon_desktop_motion::{
	AnimatorKey, AnimatorRegistry, EasingCurve, FlipModel, MotionModel, MotionRole, MotionTokens,
	ResolvedMotion, SurfaceId, resolve_motion,
};

/// Tracks vertical row layout positions across frames and drives FLIP
/// transition offsets (§5.2, §7.3).
#[derive(Debug, Default)]
pub struct ShiftChoreography {
	last_positions:    HashMap<u64, f32>,
	current_positions: HashMap<u64, f32>,
}

impl ShiftChoreography {
	/// Creates an empty row-move choreography tracker.
	#[must_use]
	pub fn new() -> Self {
		Self { last_positions: HashMap::new(), current_positions: HashMap::new() }
	}

	/// Returns the recorded vertical layout position of a row if measured.
	#[must_use]
	pub fn row_position(&self, id: u64) -> Option<f32> {
		self.current_positions.get(&id).copied()
	}

	/// Records layout positions for the current frame.
	pub fn record_positions(
		&mut self,
		registry: &mut AnimatorRegistry,
		tokens: &MotionTokens,
		reduced_motion: bool,
		positions: &HashMap<u64, f32>,
		now: Instant,
	) {
		let resolved = resolve_motion(MotionRole::Shift, tokens, reduced_motion);
		for (&row_id, &curr_y) in positions {
			if let Some(&prev_y) = self.last_positions.get(&row_id) {
				let delta_y = prev_y - curr_y;
				if delta_y.abs() > 0.001 {
					let key = AnimatorKey::new(SurfaceId::Queue, MotionRole::Shift, row_id);
					match resolved {
						ResolvedMotion::Instant => {
							let model = MotionModel::Flip(FlipModel {
								duration_ms: 0,
								curve:       EasingCurve::EaseOut,
							});
							let active = registry.get_or_create(key, 0.0, model, now);
							active.start_value = 0.0;
							active.current_value = 0.0;
							active.target_value = 0.0;
							active.is_at_rest = true;
						},
						ResolvedMotion::Duration { duration_ms, curve } => {
							let model = MotionModel::Flip(FlipModel { duration_ms, curve });
							let current_offset = if let Some(active) = registry.sample(&key, now) {
								delta_y + active
							} else {
								delta_y
							};
							let active = registry.get_or_create(key, 0.0, model, now);
							active.start_value = current_offset;
							active.current_value = current_offset;
							active.target_value = 0.0;
							active.start_time = now;
							active.model = model;
							active.is_at_rest = false;
						},
						_ => {},
					}
				}
			}
		}
		self.last_positions.clone_from(positions);
		self.current_positions.clone_from(positions);
	}

	/// Returns the FLIP translation Y offset for `row_id` at timestamp `now`.
	#[must_use]
	pub fn shift_offset(&self, registry: &AnimatorRegistry, row_id: u64, now: Instant) -> f32 {
		let key = AnimatorKey::new(SurfaceId::Queue, MotionRole::Shift, row_id);
		registry.sample(&key, now).unwrap_or(0.0)
	}
}
