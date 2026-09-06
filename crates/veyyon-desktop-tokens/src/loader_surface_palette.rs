use std::path::Path;

use crate::{
	error::TokenError,
	loader::{find_key_line_col, parse_toml, read_file},
	schema::ScaleTokens,
	section::Section,
	surface::PaletteSurfaceTokens,
};

/// Loads command palette tokens from `surface/palette.toml`.
pub fn load_palette(path: &Path, scale: &ScaleTokens) -> Result<PaletteSurfaceTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = Section::root(path, &text, &val)?;
	root.only(&["meta", "geometry", "input", "results"])?;
	root.meta("surface_palette")?;

	let geom = root.sub("geometry")?;
	geom.only(&["width_px", "max_height_px", "radius", "elevation_level"])?;
	let level = geom.integer("elevation_level")?;
	let elevation_level = u8::try_from(level)
		.ok()
		.filter(|l| *l <= 4)
		.ok_or_else(|| {
			let (line, column) = find_key_line_col(&text, "geometry", "elevation_level");
			TokenError::OffScale {
				path: path.to_path_buf(),
				line,
				column,
				value: level.to_string(),
				scale_name: "elevation.level".to_string(),
				allowed: "0..4".to_string(),
			}
		})?;

	let input = root.sub("input")?;
	input.only(&["row_height_px", "inset", "search_icon_px"])?;

	let results = root.sub("results")?;
	results.only(&[
		"row_height_px",
		"group_header_height_px",
		"footer_height_px",
		"key_hint_size",
	])?;

	Ok(PaletteSurfaceTokens {
		width_px: geom.number("width_px")?,
		max_height_px: geom.number("max_height_px")?,
		radius: geom.radius("radius", scale)?,
		elevation_level,
		input_row_height_px: input.number("row_height_px")?,
		input_inset: input.spacing("inset", scale)?,
		input_search_icon_px: input.number("search_icon_px")?,
		results_row_height_px: results.number("row_height_px")?,
		results_group_header_height_px: results.number("group_header_height_px")?,
		results_footer_height_px: results.number("footer_height_px")?,
		results_key_hint_size: results.type_size("key_hint_size", scale)?,
	})
}
