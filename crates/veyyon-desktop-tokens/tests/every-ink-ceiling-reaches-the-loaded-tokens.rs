//! WHY: the ink ceilings in §6.6 are what the scene clutter metric measures a
//! rendered surface against, so a ceiling that fails to reach the loaded
//! tokens does not loosen a rule, it deletes one: the metric then compares a
//! frame against a value nobody chose. The earlier suite pinned five of the
//! eight surfaces by hand, and `block_chrome`, `right_panel_chrome` and
//! `terminal_drawer_chrome` were free to drift.
//!
//! This sweeps the surfaces declared in `ceilings.toml` at run time and pins
//! the whole set by exact equality, so a surface added to the file, a surface
//! the loader drops, and a number edited without a decision each arrive as a
//! failure naming the surface.
//!
//! It does not catch a number changed in both the file and this test in one
//! edit, which is the reviewable diff the ceiling exists to force.

use std::{fs, path::Path};

use toml::Value;
use veyyon_desktop_tokens::{load_from_dir, schema::SurfaceCeilings};

/// The surfaces of `ceilings.toml`, sorted by name, excluding the density
/// region, which states a pair of rates rather than a count.
fn declared_surfaces(tokens_dir: &Path) -> Vec<String> {
	let text = fs::read_to_string(tokens_dir.join("ceilings.toml")).expect("read ceilings.toml");
	let value: Value = toml::from_str(&text).expect("parse ceilings.toml");
	let table = value
		.get("ceilings")
		.and_then(Value::as_table)
		.expect("ceilings.toml declares a [ceilings] table");
	let mut names: Vec<String> = table
		.keys()
		.filter(|key| key.as_str() != "density_region")
		.cloned()
		.collect();
	names.sort();
	names
}

fn row(name: &str, ceilings: &SurfaceCeilings) -> (String, usize, usize, usize, usize) {
	(
		name.to_string(),
		ceilings.edges,
		ceilings.distinct_gaps,
		ceilings.text_sizes,
		ceilings.interactive_elements,
	)
}

#[test]
fn every_ink_ceiling_reaches_the_loaded_tokens() {
	let tokens_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tokens");
	let tokens = load_from_dir(&tokens_dir).expect("load tokens");
	let c = &tokens.ceilings;

	let observed: Vec<(String, usize, usize, usize, usize)> = declared_surfaces(&tokens_dir)
		.into_iter()
		.map(|name| {
			let ceilings = match name.as_str() {
				"queue_card" => &c.queue_card,
				"queue_line" => &c.queue_line,
				"transcript_turn" => &c.transcript_turn,
				"block_chrome" => &c.block_chrome,
				"composer" => &c.composer,
				"right_panel_chrome" => &c.right_panel_chrome,
				"terminal_drawer_chrome" => &c.terminal_drawer_chrome,
				"whole_window" => &c.whole_window,
				other => panic!("{other} is declared in ceilings.toml and reaches no field"),
			};
			row(&name, ceilings)
		})
		.collect();

	// (surface, edges, distinct gaps, text sizes, interactive elements) per §6.6.
	let expected: Vec<(String, usize, usize, usize, usize)> = [
		("block_chrome", 1, 2, 2, 2),
		("composer", 3, 4, 3, 8),
		("queue_card", 2, 3, 3, 3),
		("queue_line", 1, 2, 2, 2),
		("right_panel_chrome", 2, 3, 3, 6),
		("terminal_drawer_chrome", 2, 2, 2, 5),
		("transcript_turn", 1, 3, 3, 4),
		("whole_window", 16, 8, 6, 105),
	]
	.into_iter()
	.map(|(name, edges, gaps, sizes, controls)| (name.to_string(), edges, gaps, sizes, controls))
	.collect();

	assert_eq!(observed, expected);
}

#[test]
fn the_density_region_states_a_sample_box_and_a_rate() {
	let tokens_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tokens");
	let tokens = load_from_dir(&tokens_dir).expect("load tokens");

	let density = tokens.ceilings.density_region;
	assert_eq!(density.sample_box_px, 100.0);
	assert_eq!(density.max_interactive_per_1000px2, 2.08);
}
