//! Primitive kind enumeration inventory and group completeness tests (§6.7,
//! §8.24).

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{PrimitiveGroup, PrimitiveKind};

#[test]
fn the_primitive_kind_enumeration_has_exactly_forty_one_variants_within_ceiling() {
	let kinds: Vec<PrimitiveKind> = PrimitiveKind::iter().collect();
	assert_eq!(
		kinds.len(),
		41,
		"Expected exactly 41 primitive components in the kit, got {}",
		kinds.len()
	);
	assert!(kinds.len() <= 44, "Primitive component count {} exceeds ceiling of 44", kinds.len());
}

#[test]
fn every_primitive_group_has_at_least_one_primitive_component() {
	for group in PrimitiveGroup::iter() {
		let has_member = PrimitiveKind::iter().any(|k| k.group() == group);
		assert!(has_member, "Primitive group {group:?} has no member components");
	}
}
