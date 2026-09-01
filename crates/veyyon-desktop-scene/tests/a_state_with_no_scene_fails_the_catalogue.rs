//! WHY THIS TEST EXISTS:
//! UI states such as empty, loading, reconnecting, or error states frequently
//! ship without visual inspection when scene registries are authored manually.
//! By deriving the required state space from protocol enums at runtime, any
//! unmapped or omitted state immediately triggers a catalogue failure naming
//! the exact missing scene identifier.
//!
//! THE CLASS THIS CLOSES: UI states shipping without a corresponding scene
//! definition in the catalogue.
//!
//! WHAT IT DOES NOT CATCH: It validates that a scene descriptor is registered
//! for every protocol state; it does not validate the aesthetic quality or
//! visual layout of the rendered output.

use veyyon_desktop_scene::{SceneError, SceneRegistry, required_states};

#[test]
fn test_default_registry_covers_all_required_states() {
	let registry = SceneRegistry::new();
	let missing = registry.missing_scenes();
	assert!(
		missing.is_empty(),
		"default catalogue must have zero missing scenes, but found: {missing:?}"
	);
	assert!(
		registry.validate_completeness().is_ok(),
		"completeness validation must succeed for full registry"
	);
}

#[test]
fn test_required_state_count_matches_protocol_enumeration_sum() {
	let states = required_states();
	// 6 connection states + (30 capabilities * 4 gate variants) + 12 roles
	// + 15 block kinds + 19 error scopes + 8 badges + 5 sections + 2 row shapes
	// = 6 + 120 + 12 + 15 + 19 + 8 + 5 + 2 = 187
	assert_eq!(states.len(), 187, "required state count must equal 187 derived from protocol enums");
}

#[test]
fn test_empty_registry_reports_all_required_states_as_missing() {
	let registry = SceneRegistry::empty();
	let missing = registry.missing_scenes();
	assert_eq!(missing.len(), 187, "empty catalogue must report all 187 required states as missing");

	match registry.validate_completeness() {
		Err(SceneError::MissingScenes(missing_list)) => {
			assert_eq!(missing_list.len(), 187);
			assert!(missing_list.contains(&"shell/connection-detached".to_string()));
		},
		other => panic!("expected MissingScenes error, got: {other:?}"),
	}
}

#[test]
fn test_removing_single_required_scene_fails_completeness_by_exact_name() {
	let mut registry = SceneRegistry::new();
	let target_scene = "shell/connection-detached";

	let removed = registry.remove(target_scene);
	assert!(removed.is_some(), "scene must exist prior to removal");

	let missing = registry.missing_scenes();
	assert_eq!(
		missing,
		vec![target_scene.to_string()],
		"missing list must contain exactly the removed scene name"
	);

	match registry.validate_completeness() {
		Err(SceneError::MissingScenes(missing_list)) => {
			assert_eq!(missing_list, vec![target_scene.to_string()]);
		},
		other => panic!("expected MissingScenes error naming {target_scene}, got: {other:?}"),
	}
}
