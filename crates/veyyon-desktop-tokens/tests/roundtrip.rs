use std::path::Path;

use veyyon_desktop_tokens::{dump_to_dir, load_from_dir};
use veyyon_test_scratch::scratch_dir;

#[test]
fn test_tokens_dump_and_load_roundtrip() {
	let shipped_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tokens");
	let original = load_from_dir(&shipped_dir).expect("load shipped tokens");

	let tree = scratch_dir("tokens-roundtrip");
	dump_to_dir(&original, tree.path()).expect("dump tokens");

	let reloaded = load_from_dir(tree.path()).expect("reload dumped tokens");
	assert_eq!(original, reloaded, "reloaded tokens must be identical to original tokens");
}

#[test]
fn test_tokens_dump_and_load_roundtrip_with_modified_surface_fields() {
	let shipped_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tokens");
	let mut original = load_from_dir(&shipped_dir).expect("load shipped tokens");

	// Mutate fields across different surfaces to non-default values
	original.surface.queue.width_default_px = 300.0;
	original.surface.queue.max_hover_actions = 4;
	original.surface.composer.rest_height_px = 80.0;
	original.surface.shell.window_min_width_px = 1024.0;
	original.surface.panels.right_panel_default_width_px = 600.0;

	let tree = scratch_dir("tokens-roundtrip-modified");
	dump_to_dir(&original, tree.path()).expect("dump modified tokens");

	let reloaded = load_from_dir(tree.path()).expect("reload dumped modified tokens");
	assert_eq!(
		original, reloaded,
		"reloaded tokens with modified surface fields must match original modified tokens"
	);
}
