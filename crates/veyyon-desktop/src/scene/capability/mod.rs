//! Capability gate scene construction (§1.2, §4.3, §9.5).

pub mod mapping;
pub mod surface;

pub use mapping::{action_of, target_surface_of};
use surface::seed_capability_surface;
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ConnectionState, QueuePartition, RequestId,
};
use veyyon_desktop_scene::{FixtureText, GateVariant};

use crate::scene::{
	SceneBuildError,
	seed::{Built, SCENE_CLOCK_MS, Seed},
};

/// Seeds the reachable desktop surface for one capability in one gate state.
pub fn capability_gate(
	name: &str,
	capability: Capability,
	gate: GateVariant,
) -> Result<Built, SceneBuildError> {
	let mut seed = if capability == Capability::Lifecycle {
		Seed::connection(ConnectionState::Reconnecting {
			attempt:     1,
			retry_at_ms: SCENE_CLOCK_MS + 5000,
			message:     "connection reset by peer".to_string(),
		})
	} else {
		Seed::attached()
	};

	let session = seed.session(QueuePartition::Live, None);
	seed_capability_surface(&mut seed, &session, capability);

	let status = match gate {
		GateVariant::Enabled => CapabilityStatus::Available,
		GateVariant::Unknown => CapabilityStatus::UnknownUntilAttached,
		GateVariant::Unavailable => CapabilityStatus::Unavailable {
			reason: format!("{} is not available on this host", capability.as_str()),
		},
		GateVariant::Pending => {
			let action = action_of(capability).ok_or_else(|| SceneBuildError::Unreachable {
				scene:  name.to_string(),
				reason: format!(
					"no host action is gated by {}, so no request of it can be in flight",
					capability.as_str()
				),
			})?;
			let target = target_surface_of(capability, &session);
			seed
				.registry
				.register(RequestId(1), action, target, SCENE_CLOCK_MS - 500, 30_000);
			CapabilityStatus::Available
		},
	};

	seed.store.capabilities.set(capability, status);
	let mut built = seed.finish();
	if matches!(capability, Capability::TurnControl | Capability::BackgroundSubmission) {
		built.composer_text = FixtureText::MESSAGE_TYPICAL.to_string();
	}
	Ok(built)
}
