//! Channel and spring evaluation for retained motion.
//!
//! Sampling evaluates positions and velocities against timestamps without
//! integrating intermediate frames. Direct input cancels interpolated legs.

use super::{Damage, Motion, MotionKey, RetainedKey, Sample, registry::ActivityClient};
impl Motion {
	pub(super) fn event_sample(&self, index: usize, now: u64) -> Sample {
		self.tracks[index]
			.map(|track| track.at(now))
			.unwrap_or(Sample { value: 0.0, velocity: 0.0, settled: true })
	}

	/// Pointer drag or direct terminal/scroll input. The event commits the value
	/// and cancels any interpolated leg in the same transaction.
	pub fn set_direct(&mut self, key: MotionKey, value: f32, damage: Damage) -> f32 {
		if let Some(index) = self.find(key) {
			self.tracks[index] = None;
			self.index.remove(key);
		}
		self.damage.mark(damage);
		value
	}

	/// Sample a property during render. A track that has settled on a non-zero
	/// target keeps holding it, so the `settled` argument is the value a
	/// property takes with no track at all: its rest. A remount therefore
	/// cannot replay an entrance, and a property that reached a non-rest value
	/// cannot snap back to rest a frame after it arrived.
	pub fn sample(&self, key: MotionKey, settled: f32, now: u64) -> f32 {
		if self.reduced {
			return settled;
		}
		self
			.find(key)
			.and_then(|index| self.tracks[index].map(|track| track.at(now).value))
			.unwrap_or(settled)
	}

	pub fn velocity(&self, key: MotionKey, now: u64) -> f32 {
		self
			.find(key)
			.and_then(|index| self.tracks[index].map(|track| track.at(now).velocity))
			.unwrap_or(0.0)
	}

	pub fn register_activity(
		&mut self,
		owner: RetainedKey,
		phase_offset: u8,
		damage: Damage,
	) -> bool {
		if self.reduced {
			return false;
		}
		if self
			.activity
			.iter()
			.flatten()
			.any(|client| client.owner == owner)
		{
			return true;
		}
		let Some(slot) = self.activity.iter_mut().find(|slot| slot.is_none()) else {
			return false;
		};
		*slot = Some(ActivityClient { owner, offset: phase_offset % 8, damage });
		self.damage.mark(damage);
		true
	}

	pub fn unregister_activity(&mut self, owner: RetainedKey) {
		if let Some(slot) = self
			.activity
			.iter_mut()
			.find(|slot| matches!(slot, Some(client) if client.owner == owner))
		{
			*slot = None;
		}
	}

	pub fn activity_registered(&self, owner: RetainedKey) -> bool {
		self
			.activity
			.iter()
			.flatten()
			.any(|client| client.owner == owner)
	}

	pub fn activity_phase(&self, owner: RetainedKey, now: u64) -> u8 {
		if self.reduced {
			return 0;
		}
		let offset = self
			.activity
			.iter()
			.flatten()
			.find(|client| client.owner == owner)
			.map(|client| client.offset)
			.unwrap_or(0);
		(((now / 200) as u8).wrapping_add(offset)) % 8
	}
}
