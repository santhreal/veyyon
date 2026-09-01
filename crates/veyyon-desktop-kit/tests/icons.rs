//! Icon inventory and semantic uniqueness test (§8.25).

use veyyon_desktop_kit::validate_icon_uniqueness;

#[test]
fn all_icons_have_unique_semantic_meanings_and_valid_mappings() {
	assert!(
		validate_icon_uniqueness(),
		"Icon set contains duplicate meanings or unmapped IconName variants"
	);
}
