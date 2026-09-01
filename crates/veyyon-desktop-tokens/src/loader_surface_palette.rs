use std::path::Path;

use toml::Value;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file, validate_table_keys},
	loader_surface::{resolve_radius_opt, resolve_spacing_opt, resolve_type_size_opt},
	schema::{RadiusStep, ScaleTokens, SpacingStep, TypeSizeStep},
	surface::PaletteSurfaceTokens,
};

/// Loads command palette tokens from `surface/palette.toml`.
pub fn load_palette(path: &Path, scale: &ScaleTokens) -> Result<PaletteSurfaceTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = val.as_table().ok_or_else(|| TokenError::MissingKey {
		path:    path.to_path_buf(),
		section: "root".to_string(),
		key:     "geometry".to_string(),
	})?;
	validate_table_keys(path, &text, "root", root, &["meta", "geometry", "input", "results"])?;

	let geom = root
		.get("geometry")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "geometry".to_string(),
		})?;
	validate_table_keys(path, &text, "geometry", geom, &[
		"width_px",
		"max_height_px",
		"radius",
		"elevation_level",
	])?;
	let width_px = geom
		.get("width_px")
		.and_then(Value::as_integer)
		.unwrap_or(576) as f32;
	let max_height_px = geom
		.get("max_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(420) as f32;
	let radius = resolve_radius_opt(
		path,
		&text,
		"geometry",
		"radius",
		geom.get("radius"),
		RadiusStep::Xxl,
		scale,
	)?;
	let elevation_level = geom
		.get("elevation_level")
		.and_then(Value::as_integer)
		.unwrap_or(4) as u8;

	let input =
		root
			.get("input")
			.and_then(Value::as_table)
			.ok_or_else(|| TokenError::MissingKey {
				path:    path.to_path_buf(),
				section: "root".to_string(),
				key:     "input".to_string(),
			})?;
	let input_row_height_px = input
		.get("row_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(40) as f32;
	let input_inset = resolve_spacing_opt(
		path,
		&text,
		"input",
		"inset",
		input.get("inset"),
		SpacingStep::S8,
		scale,
	)?;
	let input_search_icon_px = input
		.get("search_icon_px")
		.and_then(Value::as_integer)
		.unwrap_or(16) as f32;

	let results = root
		.get("results")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "results".to_string(),
		})?;
	let results_row_height_px = results
		.get("row_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(32) as f32;
	let results_group_header_height_px = results
		.get("group_header_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(20) as f32;
	let results_footer_height_px = results
		.get("footer_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(32) as f32;
	let results_key_hint_size = resolve_type_size_opt(
		path,
		&text,
		"results",
		"key_hint_size",
		results.get("key_hint_size"),
		TypeSizeStep::Micro,
		scale,
	)?;

	Ok(PaletteSurfaceTokens {
		width_px,
		max_height_px,
		radius,
		elevation_level,
		input_row_height_px,
		input_inset,
		input_search_icon_px,
		results_row_height_px,
		results_group_header_height_px,
		results_footer_height_px,
		results_key_hint_size,
	})
}
