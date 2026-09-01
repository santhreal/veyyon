use std::path::Path;

use toml::Value;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file, validate_table_keys},
	schema::{CeilingTokens, DensityRegionCeiling, SurfaceCeilings},
};

/// Parses and validates ceilings.toml.
pub fn load_ceilings(path: &Path) -> Result<CeilingTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = val.as_table().ok_or_else(|| TokenError::MissingKey {
		path:    path.to_path_buf(),
		section: "root".to_string(),
		key:     "ceilings".to_string(),
	})?;

	validate_table_keys(path, &text, "root", root, &["meta", "ceilings"])?;

	let ceilings_tbl = root
		.get("ceilings")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "ceilings".to_string(),
		})?;

	fn parse_surface_ceiling(
		path: &Path,
		tbl: &toml::map::Map<String, Value>,
		name: &str,
	) -> Result<SurfaceCeilings, TokenError> {
		let section =
			tbl.get(name)
				.and_then(Value::as_table)
				.ok_or_else(|| TokenError::MissingKey {
					path:    path.to_path_buf(),
					section: format!("ceilings.{name}"),
					key:     "edges".to_string(),
				})?;
		let edges = section
			.get("edges")
			.and_then(Value::as_integer)
			.unwrap_or(0) as usize;
		let distinct_gaps = section
			.get("distinct_gaps")
			.and_then(Value::as_integer)
			.unwrap_or(0) as usize;
		let text_sizes = section
			.get("text_sizes")
			.and_then(Value::as_integer)
			.unwrap_or(0) as usize;
		let interactive_elements = section
			.get("interactive_elements")
			.and_then(Value::as_integer)
			.unwrap_or(0) as usize;
		Ok(SurfaceCeilings { edges, distinct_gaps, text_sizes, interactive_elements })
	}

	let queue_card = parse_surface_ceiling(path, ceilings_tbl, "queue_card")?;
	let queue_line = parse_surface_ceiling(path, ceilings_tbl, "queue_line")?;
	let transcript_turn = parse_surface_ceiling(path, ceilings_tbl, "transcript_turn")?;
	let block_chrome = parse_surface_ceiling(path, ceilings_tbl, "block_chrome")?;
	let composer = parse_surface_ceiling(path, ceilings_tbl, "composer")?;
	let right_panel_chrome = parse_surface_ceiling(path, ceilings_tbl, "right_panel_chrome")?;
	let terminal_drawer_chrome =
		parse_surface_ceiling(path, ceilings_tbl, "terminal_drawer_chrome")?;
	let whole_window = parse_surface_ceiling(path, ceilings_tbl, "whole_window")?;

	let density_sec = ceilings_tbl
		.get("density_region")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "ceilings.density_region".to_string(),
			key:     "sample_box_px".to_string(),
		})?;
	let sample_box_px = density_sec
		.get("sample_box_px")
		.and_then(|v| match v {
			Value::Integer(i) => Some(*i as f32),
			Value::Float(f) => Some(*f as f32),
			_ => None,
		})
		.unwrap_or(100.0);
	let max_interactive_per_1000px2 = density_sec
		.get("max_interactive_per_1000px2")
		.and_then(|v| match v {
			Value::Integer(i) => Some(*i as f32),
			Value::Float(f) => Some(*f as f32),
			_ => None,
		})
		.unwrap_or(2.08);

	Ok(CeilingTokens {
		queue_card,
		queue_line,
		transcript_turn,
		block_chrome,
		composer,
		right_panel_chrome,
		terminal_drawer_chrome,
		whole_window,
		density_region: DensityRegionCeiling { sample_box_px, max_interactive_per_1000px2 },
	})
}
