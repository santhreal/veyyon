//! Motion driver for the queue rail (§5.2, §7.1, §7.3).
//!
//! Tracks persistent layout positions and animated visual transitions keyed by
//! row ID in the motion registry (`SurfaceId::Queue`), driving FLIP shift
//! transitions, tint washes, and section reveal springs with interruption
//! resilience.

use std::{
	collections::{HashMap, HashSet},
	time::Instant,
};

use veyyon_desktop_motion::{
	AnimatorKey, AnimatorRegistry, DurationModel, EasingCurve, FlipModel, MotionModel, MotionRole,
	MotionTokens, ResolvedMotion, SurfaceId, resolve_motion,
};

use crate::model::Section;

/// Motion driver owning persistent queue animation states.
#[derive(Debug)]
pub struct RailMotion {
	registry:          AnimatorRegistry,
	last_positions:    HashMap<u64, f32>,
	current_positions: HashMap<u64, f32>,
	collapsed:         HashSet<Section>,
	reduced_motion:    bool,
	tokens:            MotionTokens,
}

impl Default for RailMotion {
	fn default() -> Self {
		Self::new()
	}
}

impl RailMotion {
	/// Creates a new rail motion driver with reference motion tokens.
	#[must_use]
	pub fn new() -> Self {
		Self {
			registry:          AnimatorRegistry::new(),
			last_positions:    HashMap::new(),
			current_positions: HashMap::new(),
			collapsed:         HashSet::new(),
			reduced_motion:    false,
			tokens:            MotionTokens::reference(),
		}
	}

	/// Creates a rail motion driver with explicit motion tokens.
	#[must_use]
	pub fn with_tokens(tokens: MotionTokens) -> Self {
		Self {
			registry: AnimatorRegistry::new(),
			last_positions: HashMap::new(),
			current_positions: HashMap::new(),
			collapsed: HashSet::new(),
			reduced_motion: false,
			tokens,
		}
	}

	/// Sets whether reduced motion is active.
	pub const fn set_reduced_motion(&mut self, reduced: bool) {
		self.reduced_motion = reduced;
	}

	/// Returns whether reduced motion is active.
	#[must_use]
	pub const fn is_reduced_motion(&self) -> bool {
		self.reduced_motion
	}

	/// Returns whether the given section is currently collapsed.
	#[must_use]
	pub fn is_collapsed(&self, section: Section) -> bool {
		self.collapsed.contains(&section)
	}

	/// Toggles collapse state for collapsible sections (`Deferred` and
	/// `Parked`).
	pub fn toggle_collapsed(&mut self, section: Section, now: Instant) {
		let is_now_collapsed = if self.collapsed.contains(&section) {
			self.collapsed.remove(&section);
			false
		} else {
			self.collapsed.insert(section);
			true
		};
		let target = if is_now_collapsed { 0.0 } else { 1.0 };
		let key = AnimatorKey::new(SurfaceId::Queue, MotionRole::Reveal, section as u64);
		let resolved = resolve_motion(MotionRole::Reveal, &self.tokens, self.reduced_motion);
		let model = match resolved {
			ResolvedMotion::Spring(s) => MotionModel::Spring(s),
			ResolvedMotion::FadeOnly { duration_ms } => {
				MotionModel::Duration(DurationModel { duration_ms, curve: EasingCurve::EaseOut })
			},
			_ => MotionModel::Duration(DurationModel {
				duration_ms: 0,
				curve:       EasingCurve::Linear,
			}),
		};
		self.registry.update_target(key, target, model, now);
	}

	/// Records layout positions for the current frame, initiating FLIP shift
	/// animations for rows whose vertical positions have moved.
	pub fn record_positions(&mut self, positions: &HashMap<u64, f32>, now: Instant) {
		let resolved = resolve_motion(MotionRole::Shift, &self.tokens, self.reduced_motion);
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
							let active = self.registry.get_or_create(key, 0.0, model, now);
							active.start_value = 0.0;
							active.current_value = 0.0;
							active.target_value = 0.0;
							active.is_at_rest = true;
						},
						ResolvedMotion::Duration { duration_ms, curve } => {
							let model = MotionModel::Flip(FlipModel { duration_ms, curve });
							let current_offset = if let Some(active) = self.registry.sample(&key, now) {
								delta_y + active
							} else {
								delta_y
							};
							let active = self.registry.get_or_create(key, 0.0, model, now);
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
	pub fn shift_offset(&self, row_id: u64, now: Instant) -> f32 {
		let key = AnimatorKey::new(SurfaceId::Queue, MotionRole::Shift, row_id);
		self.registry.sample(&key, now).unwrap_or(0.0)
	}

	/// Returns reveal animation progress (0.0 = collapsed, 1.0 = expanded) for
	/// `section`.
	#[must_use]
	pub fn reveal_progress(&self, section: Section, now: Instant) -> f32 {
		let key = AnimatorKey::new(SurfaceId::Queue, MotionRole::Reveal, section as u64);
		if self.collapsed.contains(&section) {
			self.registry.sample(&key, now).unwrap_or(0.0)
		} else {
			self.registry.sample(&key, now).unwrap_or(1.0)
		}
	}

	/// Returns tint transition progress (0.0 to 1.0) for `slot` at `now`.
	#[must_use]
	pub fn tint_progress(&self, slot: u64, now: Instant) -> f32 {
		let key = AnimatorKey::new(SurfaceId::Queue, MotionRole::Tint, slot);
		self.registry.sample(&key, now).unwrap_or(1.0)
	}

	/// Updates tint animation target value for `slot`.
	pub fn set_tint(&mut self, slot: u64, target: f32, now: Instant) {
		let key = AnimatorKey::new(SurfaceId::Queue, MotionRole::Tint, slot);
		let resolved = resolve_motion(MotionRole::Tint, &self.tokens, self.reduced_motion);
		let model = match resolved {
			ResolvedMotion::Instant => MotionModel::Duration(DurationModel {
				duration_ms: 0,
				curve:       EasingCurve::Linear,
			}),
			ResolvedMotion::Duration { duration_ms, curve } => {
				MotionModel::Duration(DurationModel { duration_ms, curve })
			},
			_ => MotionModel::Duration(DurationModel {
				duration_ms: 120,
				curve:       EasingCurve::EaseOut,
			}),
		};
		self.registry.update_target(key, target, model, now);
	}

	/// Advances the animation registry and returns whether any active animations
	/// remain.
	pub fn has_active_animations(&mut self, now: Instant) -> bool {
		!self.registry.step_frame(now).is_empty()
	}

	/// Returns a reference to the underlying [`AnimatorRegistry`].
	#[must_use]
	pub const fn registry(&self) -> &AnimatorRegistry {
		&self.registry
	}

	/// Returns a mutable reference to the underlying [`AnimatorRegistry`].
	pub const fn registry_mut(&mut self) -> &mut AnimatorRegistry {
		&mut self.registry
	}
}
