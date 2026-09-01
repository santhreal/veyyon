//! WHY THIS TEST EXISTS:
//! Contact sheet generation and CLI sweep commands select scene subsets using
//! glob patterns (such as `queue-card/*` or `shell/*`). A glob engine that
//! returns unconstrained results on unmatched patterns or misses prefix subsets
//! produces corrupted or irrelevant contact sheets.
//!
//! THE CLASS THIS CLOSES: Over-broad or leaky glob pattern matching during
//! scene selection.
//!
//! WHAT IT DOES NOT CATCH: It validates retrieval by prefix and wildcard
//! pattern; it does not execute the render pipelines of the retrieved scenes.

use veyyon_desktop_scene::SceneRegistry;

#[test]
fn test_glob_lookup_finds_all_scenes_under_prefix() {
	let registry = SceneRegistry::new();

	let queue_card_scenes = registry.find_glob("queue-card/*");
	assert!(!queue_card_scenes.is_empty(), "expected non-empty scene set for queue-card/*");

	for scene in &queue_card_scenes {
		assert!(
			scene.name.starts_with("queue-card/"),
			"scene '{}' must match prefix 'queue-card/'",
			scene.name
		);
	}

	let shell_scenes = registry.find_glob("shell/*");
	assert_eq!(shell_scenes.len(), 6, "expected exactly 6 connection scenes under shell/*");

	for scene in &shell_scenes {
		assert!(
			scene.name.starts_with("shell/"),
			"scene '{}' must match prefix 'shell/'",
			scene.name
		);
	}
}

#[test]
fn test_unmatched_glob_returns_empty_vector() {
	let registry = SceneRegistry::new();

	let unmatched = registry.find_glob("nonexistent-surface/*");
	assert!(
		unmatched.is_empty(),
		"unmatched glob must return empty result, got {} items",
		unmatched.len()
	);

	let unmatched_exact = registry.find_glob("queue-card/nonexistent-state");
	assert!(unmatched_exact.is_empty(), "unmatched exact pattern must return empty result");
}

#[test]
fn test_wildcard_all_returns_every_registered_scene() {
	let registry = SceneRegistry::new();

	let all_scenes = registry.find_glob("*");
	assert_eq!(
		all_scenes.len(),
		registry.len(),
		"wildcard '*' must return all {} registered scenes",
		registry.len()
	);
}

#[test]
fn test_exact_lookup_matches_single_scene() {
	let registry = SceneRegistry::new();

	let exact_scenes = registry.find_glob("queue-card/approval");
	assert_eq!(exact_scenes.len(), 1);
	assert_eq!(exact_scenes[0].name, "queue-card/approval");
}
