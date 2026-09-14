use std::path::Path;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file},
	schema::{CeilingTokens, DensityRegionCeiling, SurfaceCeilings},
	section::Section,
};

/// Parses and validates ceilings.toml.
pub fn load_ceilings(path: &Path) -> Result<CeilingTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = Section::root(path, &text, &val)?;
	root.only(&["meta", "ceilings"])?;
	root.meta("ceilings")?;

	let ceilings = root.sub("ceilings")?;
	ceilings.only(&[
		"queue_card",
		"queue_line",
		"transcript_turn",
		"block_chrome",
		"composer",
		"right_panel_chrome",
		"terminal_drawer_chrome",
		"whole_window",
		"density_region",
	])?;

	let surface = |name: &str| -> Result<SurfaceCeilings, TokenError> {
		let section = ceilings.sub(name)?;
		section.only(&["edges", "distinct_gaps", "text_sizes", "interactive_elements"])?;
		Ok(SurfaceCeilings {
			edges:                section.count("edges")?,
			distinct_gaps:        section.count("distinct_gaps")?,
			text_sizes:           section.count("text_sizes")?,
			interactive_elements: section.count("interactive_elements")?,
		})
	};

	let density = ceilings.sub("density_region")?;
	density.only(&["sample_box_px", "max_interactive_per_1000px2"])?;

	Ok(CeilingTokens {
		queue_card:             surface("queue_card")?,
		queue_line:             surface("queue_line")?,
		transcript_turn:        surface("transcript_turn")?,
		block_chrome:           surface("block_chrome")?,
		composer:               surface("composer")?,
		right_panel_chrome:     surface("right_panel_chrome")?,
		terminal_drawer_chrome: surface("terminal_drawer_chrome")?,
		whole_window:           surface("whole_window")?,
		density_region:         DensityRegionCeiling {
			sample_box_px:               density.number("sample_box_px")?,
			max_interactive_per_1000px2: density.number("max_interactive_per_1000px2")?,
		},
	})
}
