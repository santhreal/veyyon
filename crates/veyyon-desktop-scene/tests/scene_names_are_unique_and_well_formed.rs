//! WHY THIS TEST EXISTS:
//! Scene identifiers are invoked from command-line interfaces and contact-sheet
//! parameter sweeps. Inconsistent naming, uppercase characters, spaces, or
//! duplicate name collisions break automated CLI dispatch and headless render
//! scripts.
//!
//! THE CLASS THIS CLOSES: Duplicate or malformed scene identifiers causing
//! silent registry clobbering or CLI invocation failures.
//!
//! WHAT IT DOES NOT CATCH: It checks identifier syntax and uniqueness; it does
//! not assert that the underlying surface implementation matches the name.

use veyyon_desktop_scene::{FixtureSelection, Scene, SceneError, SceneRegistry, StateDescriptor};

#[test]
fn test_all_registered_scenes_have_unique_names() {
	let registry = SceneRegistry::new();
	let mut seen = std::collections::HashSet::new();

	for scene in registry.iter() {
		assert!(
			seen.insert(scene.name.clone()),
			"duplicate scene name found in registry: {}",
			scene.name
		);
	}
}

#[test]
fn test_all_registered_scenes_have_well_formed_names() {
	let registry = SceneRegistry::new();

	for scene in registry.iter() {
		let parts: Vec<&str> = scene.name.split('/').collect();
		assert_eq!(parts.len(), 2, "scene name '{}' must contain exactly one slash", scene.name);

		let surface = parts[0];
		let state = parts[1];

		assert!(!surface.is_empty(), "surface part must not be empty in '{}'", scene.name);
		assert!(!state.is_empty(), "state part must not be empty in '{}'", scene.name);

		assert!(
			surface
				.chars()
				.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
			"surface '{}' in '{}' must be lowercase alphanumeric with hyphens",
			surface,
			scene.name
		);

		assert!(
			state
				.chars()
				.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
			"state '{}' in '{}' must be lowercase alphanumeric with hyphens",
			state,
			scene.name
		);
	}
}

#[test]
fn test_registering_duplicate_scene_returns_typed_error() {
	let mut registry = SceneRegistry::new();
	let duplicate = Scene {
		name:              "queue-card/approval".to_string(),
		surface:           "queue-card".to_string(),
		state:             StateDescriptor::Custom {
			surface: "queue-card".to_string(),
			state:   "approval".to_string(),
		},
		fixture_selection: FixtureSelection::Extreme,
	};

	let result = registry.register(duplicate);
	assert_eq!(result, Err(SceneError::DuplicateScene("queue-card/approval".to_string())));
}

#[test]
fn test_registering_malformed_scene_names_fails_validation() {
	let mut registry = SceneRegistry::empty();

	let malformed_cases = [
		"UpperCase/state",
		"surface/UpperState",
		"surface/has space",
		"surface_with_underscore/state",
		"noslash",
		"too/many/slashes",
		"/leading-slash",
		"trailing-slash/",
		"",
	];

	for malformed in malformed_cases {
		let scene = Scene {
			name:              malformed.to_string(),
			surface:           "surface".to_string(),
			state:             StateDescriptor::Custom {
				surface: "surface".to_string(),
				state:   "state".to_string(),
			},
			fixture_selection: FixtureSelection::Typical,
		};

		let result = registry.register(scene);
		assert_eq!(
			result,
			Err(SceneError::InvalidSceneName(malformed.to_string())),
			"malformed name '{malformed}' must be rejected"
		);
	}
}
