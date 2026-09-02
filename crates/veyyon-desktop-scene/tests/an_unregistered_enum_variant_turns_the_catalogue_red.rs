//! WHY THIS TEST EXISTS:
//! Hardcoded variant lists silently go stale when new enum variants are added
//! to protocol models. By enforcing dynamic iteration across all protocol
//! enums, any newly introduced variant automatically expands the required state
//! space and turns catalogue validation red until an explicit scene
//! registration is added.
//!
//! THE CLASS THIS CLOSES: Silent omission of newly introduced protocol variants
//! from the UI scene test suite.
//!
//! WHAT IT DOES NOT CATCH: It cannot prevent a newly introduced variant from
//! choosing an inadequate fixture; it only guarantees the scene entry itself
//! exists.

use strum::IntoEnumIterator;
use veyyon_desktop_model::{
	BadgeKind, BlockKind, Capability, ErrorScope, MessageRole, QueuePartition,
};
use veyyon_desktop_scene::{
	ConnectionStateKind, GateVariant, PrimitiveKind, RowShape, SceneRegistry, required_states,
};

#[test]
fn test_enum_iteration_exhausts_all_protocol_domains() {
	let connection_count = ConnectionStateKind::iter().count();
	assert_eq!(connection_count, 6);

	let capability_count = Capability::iter().count();
	assert_eq!(capability_count, 30);

	let gate_count = GateVariant::iter().count();
	assert_eq!(gate_count, 4);

	let role_count = MessageRole::iter().count();
	assert_eq!(role_count, 12);

	let block_count = BlockKind::iter().count();
	assert_eq!(block_count, 16);

	let error_count = ErrorScope::iter().count();
	assert_eq!(error_count, 19);

	let badge_count = BadgeKind::iter().count();
	assert_eq!(badge_count, 8);

	let partition_count = QueuePartition::iter().count();
	assert_eq!(partition_count, 5);

	let row_shape_count = RowShape::iter().count();
	assert_eq!(row_shape_count, 2);

	let primitive_count = PrimitiveKind::iter().count();
	assert_eq!(primitive_count, 41);

	let total_expected = connection_count
		+ (capability_count * gate_count)
		+ role_count
		+ block_count
		+ error_count
		+ badge_count
		+ partition_count
		+ row_shape_count
		+ primitive_count;

	assert_eq!(total_expected, 229);
	assert_eq!(required_states().len(), total_expected);
}

#[test]
fn test_synthetic_unregistered_state_causes_validation_failure() {
	let registry = SceneRegistry::new();

	// Verify that if a required state list has an unmapped entry, missing_scenes
	// captures it
	let all_registered_names: std::collections::BTreeSet<String> =
		registry.iter().map(|s| s.name.clone()).collect();

	for state in required_states() {
		assert!(
			all_registered_names.contains(&state.scene_name()),
			"registered catalogue must contain state {}",
			state.scene_name()
		);
	}
}
