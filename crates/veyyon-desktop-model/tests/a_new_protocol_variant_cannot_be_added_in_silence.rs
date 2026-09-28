//! WHY THIS SUITE EXISTS
//!
//! Every sweep in this crate and in the scene gate walks a hand-written `ALL`
//! array: 79 actions, 30 capabilities, 19 error scopes, 12 roles, 4 partitions.
//! An array is not the enum. Add an 80th action to `HostActionKind` and forget
//! to extend `HostActionKind::ALL`, and the sweeps do not fail — they iterate
//! 79 of 80 variants and pass, which is exactly the failure mode of having no
//! test at all.
//!
//! THE CLASS THIS CLOSES: a variant added to any protocol union that no sweep
//! reaches. `strum::EnumIter` derives the variant space from the enum itself,
//! so comparing `ALL` against `iter()` makes the array's staleness an error
//! rather than a silence. `ContentBlock` and `SessionBadge` carry fields and
//! cannot derive `EnumIter` directly, so they project to the fieldless
//! `BlockKind` and `BadgeKind`, which is also what the scene gate sweeps.
//!
//! WHAT IT DOES NOT CATCH: a variant that exists, is iterated, and is handled
//! wrongly. It proves reachability, not correctness. Drift between these enums
//! and the TypeScript host is not counted here: the host's declarations are
//! generated from them, which
//! `the_typescript_wire_is_generated_from_the_rust_types.rs` holds. The two
//! counts left are of unions that never cross the wire.

use strum::IntoEnumIterator;
use veyyon_desktop_model::{
	ALL_SECTION_NAMES, BadgeKind, BlockKind, Capability, ErrorScope, HostActionKind, MessageRole,
	QueuePartition, SnapshotSectionKind,
};

/// Assert that a hand-written `ALL` array names every variant of its enum, in
/// the enum's own declaration order.
fn assert_all_is_the_whole_enum<T>(all: &[T], enum_name: &str)
where
	T: IntoEnumIterator + PartialEq + std::fmt::Debug,
{
	let derived: Vec<T> = T::iter().collect();

	assert_eq!(
		all.len(),
		derived.len(),
		"{enum_name}::ALL has {} entries but the enum has {} variants. A variant was added without \
		 extending ALL, so every sweep over ALL silently skips it.",
		all.len(),
		derived.len(),
	);

	for (index, (from_array, from_enum)) in all.iter().zip(derived.iter()).enumerate() {
		assert_eq!(
			from_array, from_enum,
			"{enum_name}::ALL[{index}] is {from_array:?} but the enum's variant at that position is \
			 {from_enum:?}. ALL must list every variant in declaration order.",
		);
	}
}

#[test]
fn every_action_capability_scope_role_and_partition_is_named_by_its_all_array() {
	assert_all_is_the_whole_enum(&HostActionKind::ALL, "HostActionKind");
	assert_all_is_the_whole_enum(&Capability::ALL, "Capability");
	assert_all_is_the_whole_enum(&ErrorScope::ALL, "ErrorScope");
	assert_all_is_the_whole_enum(&MessageRole::ALL, "MessageRole");
	assert_all_is_the_whole_enum(&QueuePartition::ALL, "QueuePartition");
	// Four placements, not the five sections the rail draws: `Unsent` is derived
	// from a session holding an unsubmitted draft, so it is never a placement the
	// operator chooses or the window persists (§5.2).
	assert_eq!(QueuePartition::ALL.len(), 4, "the queue has 4 placements");
}

/// `ContentBlock`, `SessionBadge`, and `SnapshotSection` have payload-carrying
/// variants, so they project to fieldless discriminant kinds for sweeping.
#[test]
fn the_field_carrying_unions_project_to_a_sweepable_kind() {
	let sections: Vec<SnapshotSectionKind> = SnapshotSectionKind::iter().collect();
	assert_eq!(
		ALL_SECTION_NAMES.len(),
		sections.len(),
		"ALL_SECTION_NAMES has {} entries but SnapshotSection has {} variants.",
		ALL_SECTION_NAMES.len(),
		sections.len()
	);
	for (index, (name, kind)) in ALL_SECTION_NAMES.iter().zip(sections.iter()).enumerate() {
		assert_eq!(
			*name,
			format!("{kind:?}"),
			"ALL_SECTION_NAMES[{index}] is '{name}' but SnapshotSectionKind variant at that position \
			 is '{kind:?}'"
		);
	}

	assert_eq!(BadgeKind::iter().count(), 8, "the queue has 8 status badges");

	// A projection is only useful if it round-trips from a real value, which is
	// what the scene gate does when it turns a fixture badge into a scene name.
	let working = veyyon_desktop_model::SessionBadge::Working { started_at_ms: 1_000 };
	assert_eq!(BadgeKind::from(&working), BadgeKind::Working);

	let text = veyyon_desktop_model::ContentBlock::Text { text: "x".to_string() };
	assert_eq!(BlockKind::from(&text), BlockKind::Text);

	// Distinctness: a projection that collapsed two variants onto one kind would
	// let the gate believe it covered a block it never rendered.
	let blocks: Vec<BlockKind> = BlockKind::iter().collect();
	let unique: std::collections::HashSet<BlockKind> = blocks.iter().copied().collect();
	assert_eq!(unique.len(), blocks.len(), "every block kind must be distinct");
}
