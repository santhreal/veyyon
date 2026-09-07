//! Motion driver for the two-step streaming caret (`MotionRole::Caret`).
//!
//! 900ms period (450ms on, 450ms off) when streaming is active.
//! Under reduced motion or when streaming is idle, remains `SteadyOn` at
//! opacity 1.0 and settled at rest with zero perpetual redraws.

use std::time::Instant;

use crate::{
	registry::{AnimatorKey, AnimatorRegistry, SurfaceId},
	role::{MotionModel, MotionRole},
	tokens::MotionTokens,
};

/// Motion driver for the two-step streaming caret (`MotionRole::Caret`).
#[derive(Debug)]
pub struct CaretMotion {
	surface_id: SurfaceId,
	slot:       u64,
	registry:   AnimatorRegistry,
}

impl CaretMotion {
	/// Creates a new caret motion driver.
	#[must_use]
	pub fn new(surface_id: SurfaceId, slot: u64) -> Self {
		Self { surface_id, slot, registry: AnimatorRegistry::new() }
	}

	/// Samples caret opacity (1.0 or 0.0) and settled state.
	pub fn sample(
		&mut self,
		streaming: bool,
		now: Instant,
		tokens: &MotionTokens,
		reduced: bool,
	) -> (f32, bool) {
		let key = AnimatorKey::new(self.surface_id, MotionRole::Caret, self.slot);
		if !streaming || reduced {
			return (1.0, true);
		}
		let model = MotionModel::TwoStep(tokens.caret);
		let anim = self.registry.get_or_create(key, 1.0, model, now);
		let (opacity, ..) = anim.sample_at(now);
		(opacity, false)
	}

	/// Returns true if the caret is settled (idle or steady on).
	#[must_use]
	pub fn is_settled(&self) -> bool {
		self
			.registry
			.is_at_rest(&AnimatorKey::new(self.surface_id, MotionRole::Caret, self.slot))
	}
}
