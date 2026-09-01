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
