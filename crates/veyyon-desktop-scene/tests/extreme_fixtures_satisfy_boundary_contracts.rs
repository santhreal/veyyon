//! WHY THIS TEST EXISTS:
//! Clutter, text overflow, and clipping defects manifest primarily at data
//! extremes: pathologically long branches, minimal single-character names,
//! multi-byte CJK/RTL layouts, and compound emoji graphemes. If extreme
//! fixtures are not genuinely extreme, visual clipping and grapheme truncation
//! bugs bypass test gates in silence.
//!
//! THE CLASS THIS CLOSES: False-positive layout validations caused by synthetic
//! fixtures failing to exert true boundary conditions.
//!
//! WHAT IT DOES NOT CATCH: It validates the mathematical and unicode properties
//! of fixture inputs; font fallback and platform glyph rasterization are
//! verified downstream.

use std::collections::BTreeSet;

use strum::IntoEnumIterator;
use unicode_segmentation::UnicodeSegmentation;
use veyyon_desktop_model::{BlockKind, MessageRole};
use veyyon_desktop_scene::{FixtureText, Reachability, block_reachability, role_reachability};

#[test]
fn test_branch_extreme_fixture_is_exactly_ninety_characters() {
	let char_count = FixtureText::BRANCH_EXTREME_90.chars().count();
	assert_eq!(
		char_count, 90,
		"extreme branch name must be exactly 90 characters, got {char_count}"
	);
}

#[test]
fn test_project_extreme_fixture_is_single_character() {
	let char_count = FixtureText::PROJECT_EXTREME_SINGLE.chars().count();
	assert_eq!(char_count, 1, "extreme project name must be exactly 1 character, got {char_count}");
}

#[test]
fn test_emoji_cluster_is_single_grapheme_and_multiple_code_points() {
	let s = FixtureText::EMOJI_ZWJ_CLUSTER;
	let grapheme_count = s.graphemes(true).count();
	let char_count = s.chars().count();

	assert_eq!(grapheme_count, 1, "emoji ZWJ cluster must segment as exactly one visual grapheme");
	assert!(
		char_count > 1,
		"emoji ZWJ cluster must contain more than one unicode code point, got {char_count}"
	);
}

#[test]
fn test_naive_byte_truncation_splits_grapheme_cluster() {
	let s = FixtureText::GRAPHEME_CLUSTER_SPLIT;
	let graphemes: Vec<&str> = s.graphemes(true).collect();
	assert_eq!(graphemes.len(), 4, "expected 4 graphemes: c, a, f, e + acute");
	assert_eq!(graphemes[3], "e\u{0301}");

	// Naive byte truncation at byte index 4 truncates "cafe\u{0301}" to "cafe",
	// splitting the combining acute accent from the base character 'e'.
	let naive_bytes = &s.as_bytes()[0..4];
	let naive_str = std::str::from_utf8(naive_bytes).expect("ASCII prefix is valid utf8");
	let naive_graphemes: Vec<&str> = naive_str.graphemes(true).collect();

	assert_eq!(naive_graphemes.len(), 4);
	assert_eq!(naive_graphemes[3], "e", "naive truncation stripped combining accent");
	assert_ne!(
		naive_graphemes[3], graphemes[3],
		"naive truncation must alter the terminal grapheme cluster"
	);
}

#[test]
fn test_role_reachability_partitions_all_twelve_roles() {
	let mut reachable = BTreeSet::new();
	let mut unreachable = BTreeSet::new();

	for role in MessageRole::iter() {
		match role_reachability(role) {
			Reachability::Reachable => {
				reachable.insert(role);
			},
			Reachability::Unreachable => {
				unreachable.insert(role);
			},
		}
	}

	assert_eq!(reachable.len(), 8, "exactly 8 roles must be reachable");
	assert_eq!(unreachable.len(), 4, "exactly 4 roles must be unreachable");
	assert_eq!(
		reachable.len() + unreachable.len(),
		12,
		"roles must partition the entire 12-variant enum"
	);
}

#[test]
fn test_block_reachability_partitions_all_sixteen_kinds() {
	let mut reachable = BTreeSet::new();
	let mut unreachable = BTreeSet::new();

	for kind in BlockKind::iter() {
		match block_reachability(kind) {
			Reachability::Reachable => {
				reachable.insert(kind);
			},
			Reachability::Unreachable => {
				unreachable.insert(kind);
			},
		}
	}

	assert_eq!(reachable.len(), 10, "exactly 10 block kinds must be reachable");
	assert_eq!(unreachable.len(), 6, "exactly 6 block kinds must be unreachable");
	assert_eq!(
		reachable.len() + unreachable.len(),
		16,
		"block kinds must partition the entire 16-variant enum"
	);
}
