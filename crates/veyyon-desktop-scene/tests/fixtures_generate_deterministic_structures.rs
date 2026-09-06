//! WHY THIS TEST EXISTS:
//! Perceptual diffing and clutter metric assertions rely on pixel-stable
//! rasterization. Any non-determinism in fixture constructors (such as reading
//! system clocks, unseeded hash maps, or ambient environment) creates
//! non-reproducible metric reports and spurious golden test breaches.
//!
//! THE CLASS THIS CLOSES: Non-deterministic fixture values inducing noise in
//! visual comparison passes.
//!
//! WHAT IT DOES NOT CATCH: It tests structural equality between identical
//! seeds; it does not assert that two different seeds produce different
//! outputs.

use strum::IntoEnumIterator;
use veyyon_desktop_model::{BadgeKind, BlockKind, MessageRole, QueuePartition};
use veyyon_desktop_scene::{
	FixtureText, content_block_fixture, entry_meta_fixture, session_badge_fixture, session_fixture,
	session_summary_fixture, transcript_entry_fixture, usage_totals_fixture,
};

#[test]
fn test_fixture_text_constants_are_stable_and_identical() {
	assert_eq!(FixtureText::BRANCH_EXTREME_90, FixtureText::BRANCH_EXTREME_90);
	assert_eq!(FixtureText::CJK, FixtureText::CJK);
	assert_eq!(FixtureText::RTL, FixtureText::RTL);
	assert_eq!(FixtureText::EMOJI_ZWJ_CLUSTER, FixtureText::EMOJI_ZWJ_CLUSTER);
	assert_eq!(FixtureText::GRAPHEME_CLUSTER_SPLIT, FixtureText::GRAPHEME_CLUSTER_SPLIT);
}

#[test]
fn test_session_summary_fixture_is_deterministic() {
	let a = session_summary_fixture(42);
	let b = session_summary_fixture(42);
	assert_eq!(
		a, b,
		"session summary fixture must produce identical structures for identical seeds"
	);
}

#[test]
fn test_session_fixture_is_deterministic() {
	let badge = Some(session_badge_fixture(BadgeKind::Approval));
	let a = session_fixture(7, QueuePartition::Live, badge.clone());
	let b = session_fixture(7, QueuePartition::Live, badge);
	assert_eq!(a, b, "session fixture must produce identical structures for identical seeds");
}

#[test]
fn test_transcript_entry_fixture_is_deterministic_for_all_roles() {
	for role in MessageRole::iter() {
		let a = transcript_entry_fixture(13, role);
		let b = transcript_entry_fixture(13, role);
		assert_eq!(a, b, "transcript entry fixture for role {role:?} must be deterministic");
	}
}

#[test]
fn test_content_block_fixture_is_deterministic_for_all_kinds() {
	for kind in BlockKind::iter() {
		let a = content_block_fixture(99, kind);
		let b = content_block_fixture(99, kind);
		assert_eq!(a, b, "content block fixture for kind {kind:?} must be deterministic");
	}
}

#[test]
fn test_metadata_and_usage_fixtures_are_deterministic() {
	let usage_a = usage_totals_fixture(55);
	let usage_b = usage_totals_fixture(55);
	assert_eq!(usage_a, usage_b);

	let meta_a = entry_meta_fixture(55);
	let meta_b = entry_meta_fixture(55);
	assert_eq!(meta_a, meta_b);
}
