use std::{collections::HashMap, time::Instant};

use serde::{Deserialize, Serialize};

use crate::role::{MotionModel, MotionRole};

/// Logical surface identifier for UI regions owning animations (§8.23).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceId {
	Shell,
	Queue,
	Session,
	Transcript,
	Composer,
	RunBar,
	OpeningLine,
	RightPanel,
	TerminalDrawer,
	Palette,
	AttentionStrip,
	Settings,
	Attach,
}

impl SurfaceId {
	/// Returns the canonical `snake_case` identifier for this logical surface.
	pub const fn name(&self) -> &'static str {
		match self {
			Self::Shell => "shell",
			Self::Queue => "queue",
			Self::Session => "session",
			Self::Transcript => "transcript",
			Self::Composer => "composer",
			Self::RunBar => "run_bar",
			Self::OpeningLine => "opening_line",
			Self::RightPanel => "right_panel",
			Self::TerminalDrawer => "terminal_drawer",
			Self::Palette => "palette",
			Self::AttentionStrip => "attention_strip",
			Self::Settings => "settings",
			Self::Attach => "attach",
		}
	}
}

/// Composed identity key for an animation (§8.23).
///
/// Animations are keyed by `(SurfaceId, MotionRole, slot_id)`, completely
/// decoupled from transient GPUI element nodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AnimatorKey {
	pub surface_id: SurfaceId,
	pub role:       MotionRole,
	pub slot_id:    u64,
}

impl AnimatorKey {
	#[inline]
	pub const fn new(surface_id: SurfaceId, role: MotionRole, slot_id: u64) -> Self {
		Self { surface_id, role, slot_id }
	}
}

/// Active animation state tracked in the registry.
#[derive(Debug, Clone, PartialEq)]
pub struct ActiveAnimation {
	pub key:              AnimatorKey,
	pub role:             MotionRole,
	pub start_value:      f32,
	pub start_velocity:   f32,
	pub current_value:    f32,
	pub target_value:     f32,
	pub current_velocity: f32,
	pub start_time:       Instant,
	pub model:            MotionModel,
	pub is_at_rest:       bool,
}

impl ActiveAnimation {
	/// Evaluates the animation at `now`. Returns `(position, velocity,
	/// is_at_rest)`.
	pub fn sample_at(&self, now: Instant) -> (f32, f32, bool) {
		if self.is_at_rest {
			return (self.target_value, 0.0, true);
		}

		let elapsed = now
			.checked_duration_since(self.start_time)
			.map_or(0.0_f32, |d| d.as_secs_f32());

		match self.model {
			MotionModel::Spring(spring) => {
				let s =
					spring.evaluate(self.start_value, self.start_velocity, self.target_value, elapsed);
				let at_rest = spring.is_at_rest(&s, self.target_value);
				(s.position, s.velocity, at_rest)
			},
			MotionModel::SpringFade(sf) => {
				let s = sf.spring.evaluate(
					self.start_value,
					self.start_velocity,
					self.target_value,
					elapsed,
				);
				let at_rest = sf.spring.is_at_rest(&s, self.target_value);
				(s.position, s.velocity, at_rest)
			},
			MotionModel::DirectThenSpring(d) => {
				let s = d.snap_spring.evaluate(
					self.start_value,
					self.start_velocity,
					self.target_value,
					elapsed,
				);
				let at_rest = d.snap_spring.is_at_rest(&s, self.target_value);
				(s.position, s.velocity, at_rest)
			},
			MotionModel::Duration(dur) => {
				let total = (dur.duration_ms as f32) / 1000.0;
				if total <= 0.0001 || elapsed >= total {
					(self.target_value, 0.0, true)
				} else {
					let p = dur.curve.evaluate(elapsed / total);
					let pos = (self.target_value - self.start_value).mul_add(p, self.start_value);
					let vel = (self.target_value - self.start_value) / total;
					(pos, vel, false)
				}
			},
			MotionModel::Flip(flip) => {
				let total = (flip.duration_ms as f32) / 1000.0;
				if total <= 0.0001 || elapsed >= total {
					(self.target_value, 0.0, true)
				} else {
					let p = flip.curve.evaluate(elapsed / total);
					let pos = (self.target_value - self.start_value).mul_add(p, self.start_value);
					let vel = (self.target_value - self.start_value) / total;
					(pos, vel, false)
				}
			},
			MotionModel::TwoStep(ts) => {
				let half = (ts.period_ms as f32) / 2000.0;
				if half <= 0.0001 {
					(self.target_value, 0.0, false)
				} else {
					let phase = ((elapsed / half).floor() as u64) % 2;
					let pos = if phase == 0 {
						self.target_value
					} else {
						self.start_value
					};
					(pos, 0.0, false)
				}
			},
		}
	}
}

/// Registry storing persistent animation states decoupled from UI element trees
/// (§8.23).
#[derive(Debug, Default)]
pub struct AnimatorRegistry {
	animations: HashMap<AnimatorKey, ActiveAnimation>,
}

impl AnimatorRegistry {
	pub fn new() -> Self {
		Self { animations: HashMap::new() }
	}

	/// Retrieves the animation for `key`, or starts a new animation towards
	/// `target`.
	pub fn get_or_create(
		&mut self,
		key: AnimatorKey,
		target: f32,
		model: MotionModel,
		now: Instant,
	) -> &mut ActiveAnimation {
		match self.animations.entry(key) {
			std::collections::hash_map::Entry::Occupied(mut entry) => {
				let existing = entry.get_mut();
				if (existing.target_value - target).abs() > 0.0001 {
					let (pos, vel, _) = existing.sample_at(now);
					existing.start_value = pos;
					existing.start_velocity = vel;
					existing.current_value = pos;
					existing.target_value = target;
					existing.current_velocity = vel;
					existing.start_time = now;
					existing.model = model;
					existing.is_at_rest = false;
				} else {
					let (pos, vel, at_rest) = existing.sample_at(now);
					existing.current_value = pos;
					existing.current_velocity = vel;
					existing.is_at_rest = at_rest;
				}
				entry.into_mut()
			},
			std::collections::hash_map::Entry::Vacant(entry) => {
				let initial = ActiveAnimation {
					key,
					role: key.role,
					start_value: 0.0,
					start_velocity: 0.0,
					current_value: 0.0,
					target_value: target,
					current_velocity: 0.0,
					start_time: now,
					model,
					is_at_rest: false,
				};
				entry.insert(initial)
			},
		}
	}

	/// Interrupts an existing animation and redirects it towards `new_target`.
	pub fn update_target(
		&mut self,
		key: AnimatorKey,
		new_target: f32,
		model: MotionModel,
		now: Instant,
	) {
		if let Some(existing) = self.animations.get_mut(&key) {
			let (pos, vel, _) = existing.sample_at(now);
			existing.start_value = pos;
			existing.start_velocity = vel;
			existing.current_value = pos;
			existing.target_value = new_target;
			existing.current_velocity = vel;
			existing.start_time = now;
			existing.model = model;
			existing.is_at_rest = false;
		} else {
			self.get_or_create(key, new_target, model, now);
		}
	}

	/// Steps all active animations to time `now` and returns keys of active
	/// animations.
	pub fn step_frame(&mut self, now: Instant) -> Vec<AnimatorKey> {
		let mut active = Vec::new();
		for (key, anim) in &mut self.animations {
			let (pos, vel, at_rest) = anim.sample_at(now);
			anim.current_value = pos;
			anim.current_velocity = vel;
			anim.is_at_rest = at_rest;
			if !at_rest {
				active.push(*key);
			}
		}
		active
	}

	pub fn sample(&self, key: &AnimatorKey, now: Instant) -> Option<f32> {
		self.animations.get(key).map(|anim| anim.sample_at(now).0)
	}

	pub fn is_at_rest(&self, key: &AnimatorKey) -> bool {
		self.animations.get(key).is_none_or(|anim| anim.is_at_rest)
	}

	pub fn remove(&mut self, key: &AnimatorKey) -> Option<ActiveAnimation> {
		self.animations.remove(key)
	}

	pub fn len(&self) -> usize {
		self.animations.len()
	}

	pub fn is_empty(&self) -> bool {
		self.animations.is_empty()
	}
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use super::*;
	use crate::spring::SpringModel;

	#[test]
	fn test_relayout_preserves_progress() {
		let mut registry = AnimatorRegistry::new();
		let key = AnimatorKey::new(SurfaceId::Queue, MotionRole::Reveal, 42);
		let spring = SpringModel::new(220.0, 26.0, 1.0).unwrap();
		let model = MotionModel::Spring(spring);

		let t0 = Instant::now();
		registry.get_or_create(key, 100.0, model, t0);

		let t1 = t0 + Duration::from_millis(50);
		let anim = registry.get_or_create(key, 100.0, model, t1);

		assert!(anim.current_value > 5.0 && anim.current_value < 90.0);
		assert!(anim.current_velocity > 0.0);
	}

	#[test]
	fn test_remount_preserves_progress() {
		let mut registry = AnimatorRegistry::new();
		let key = AnimatorKey::new(SurfaceId::Composer, MotionRole::Float, 101);
		let spring = SpringModel::new(300.0, 24.0, 1.0).unwrap();
		let model = MotionModel::Spring(spring);

		let t0 = Instant::now();
		registry.get_or_create(key, 100.0, model, t0);

		let t1 = t0 + Duration::from_millis(80);
		let val1 = registry.get_or_create(key, 100.0, model, t1).current_value;
		let val2 = registry.get_or_create(key, 100.0, model, t1).current_value;

		assert_eq!(val1, val2);
		assert!(val2 > 20.0);
	}

	#[test]
	fn test_interruption_retains_velocity_and_position() {
		let mut registry = AnimatorRegistry::new();
		let key = AnimatorKey::new(SurfaceId::RightPanel, MotionRole::Panel, 1);
		let spring = SpringModel::new(180.0, 22.0, 1.0).unwrap();
		let model = MotionModel::Spring(spring);

		let t0 = Instant::now();
		registry.get_or_create(key, 100.0, model, t0);

		let t_int = t0 + Duration::from_millis(40);
		let (pos, vel, _) = registry.animations.get(&key).unwrap().sample_at(t_int);

		assert!(pos > 10.0 && pos < 70.0);
		assert!(vel > 10.0);

		registry.update_target(key, 0.0, model, t_int);

		let anim = registry.animations.get(&key).unwrap();
		assert_eq!(anim.start_value, pos);
		assert_eq!(anim.start_velocity, vel);
		assert_eq!(anim.current_velocity, vel);
		assert_eq!(anim.target_value, 0.0);

		let t_after = t_int + Duration::from_millis(1);
		let (pos_after, ..) = anim.sample_at(t_after);
		assert!((pos_after - pos).abs() < 5.0);
	}
}
