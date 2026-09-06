//! WHY THIS SUITE EXISTS
//!
//! The desktop client and the TypeScript GUI host exchange domain state as
//! `SnapshotSection` payloads over newline-delimited JSON. If a variant's serde
//! shape, field name, integer width, nullability, or tag casing drifts from
//! `wire.ts`, deserialization fails with a `FatalProtocolError` and drops the
//! socket.
//!
//! THE CLASS THIS CLOSES: serde divergence between the TypeScript host wire
//! types and the Rust desktop model across all 26 snapshot section variants.
//!
//! WHAT IT DOES NOT CATCH: semantic validity of values inside the sections, or
//! layout/rendering logic within GPUI views.

use std::{fs, path::PathBuf};

use veyyon_desktop_model::{ALL_SECTION_NAMES, SnapshotSection};

#[test]
fn every_snapshot_section_in_the_shared_corpus_decodes_and_round_trips() {
	let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
	let fixture_path = manifest_dir.join("tests/fixtures/snapshot-sections.json");
	let raw_json = fs::read_to_string(&fixture_path)
		.expect("failed to read snapshot-sections.json test fixture");

	let parsed_values: Vec<serde_json::Value> =
		serde_json::from_str(&raw_json).expect("failed to parse fixture as json values");

	assert_eq!(
		parsed_values.len(),
		ALL_SECTION_NAMES.len(),
		"shared corpus fixture must contain exactly one entry per snapshot section"
	);

	let sections: Vec<SnapshotSection> = serde_json::from_str(&raw_json)
		.expect("failed to deserialize snapshot sections from fixture");

	assert_eq!(
		sections.len(),
		ALL_SECTION_NAMES.len(),
		"deserialized section count must match ALL_SECTION_NAMES length"
	);

	for (i, (section, expected_name)) in sections.iter().zip(ALL_SECTION_NAMES.iter()).enumerate() {
		assert_eq!(
			section.name(),
			*expected_name,
			"section at index {i} has variant name '{}' but expected '{expected_name}'",
			section.name()
		);

		let reserialized =
			serde_json::to_value(section).expect("failed to reserialize snapshot section to json");
		assert_eq!(
			&reserialized, &parsed_values[i],
			"reserialized JSON value for section '{expected_name}' does not match fixture JSON"
		);
	}
}
