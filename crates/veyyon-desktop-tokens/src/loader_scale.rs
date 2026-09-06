use std::path::Path;

use crate::{
	error::TokenError,
	loader::{find_key_line_col, parse_toml, read_file},
	schema::{
		MonoSizeStep, RadiusStep, ScaleTokens, SpacingStep, StrokeStep, TypeSize, TypeSizeStep,
		TypeWeightStep,
	},
	section::Section,
};

/// Rejects a scale with more entries than its section 6 ceiling allows.
fn ceiling(
	section: &Section<'_>,
	what: &str,
	limit: usize,
	spec_section: &'static str,
) -> Result<(), TokenError> {
	let count = section.table().len();
	if count > limit {
		return Err(TokenError::CeilingExceeded {
			path: section.path().to_path_buf(),
			section: what.to_string(),
			count,
			ceiling: limit,
			spec_section,
		});
	}
	Ok(())
}

/// Parses and validates scale.toml.
pub fn load_scale(path: &Path) -> Result<ScaleTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = Section::root(path, &text, &val)?;
	root.only(&["meta", "spacing", "radius", "type", "stroke"])?;
	root.meta("scale")?;

	let spacing_tbl = root.sub("spacing")?;
	ceiling(&spacing_tbl, "spacing scale", 16, "6.1")?;
	let mut spacing = [0.0f32; 14];
	for step in SpacingStep::all() {
		spacing[step as usize] = spacing_tbl.number(step.as_token())?;
	}

	let radius_tbl = root.sub("radius")?;
	ceiling(&radius_tbl, "corner radii", 8, "6.2")?;
	let mut radius = [0.0f32; 8];
	for step in RadiusStep::all() {
		radius[step as usize] = radius_tbl.number(step.as_token())?;
	}

	let type_tbl = root.sub("type")?;
	type_tbl.only(&["size", "weight", "mono"])?;

	let size_tbl = type_tbl.sub("size")?;
	ceiling(&size_tbl, "typographic sizes", 6, "6.3")?;
	let mut type_sizes = [TypeSize { size: 0.0, line_height: 0.0, tracking_em: 0.0 }; 6];
	for step in TypeSizeStep::all() {
		let entry = size_tbl.sub(step.as_token())?;
		entry.only(&["size", "line_height", "tracking_em"])?;
		type_sizes[step as usize] = TypeSize {
			size:        entry.number("size")?,
			line_height: entry.number("line_height")?,
			tracking_em: entry.number("tracking_em")?,
		};
	}

	let weight_tbl = type_tbl.sub("weight")?;
	ceiling(&weight_tbl, "typographic weights", 3, "6.3")?;
	let mut type_weights = [0u16; 3];
	for step in TypeWeightStep::all() {
		let weight = weight_tbl.integer(step.as_token())?;
		type_weights[step as usize] = u16::try_from(weight).map_err(|_| {
			let (line, column) = find_key_line_col(&text, "type.weight", step.as_token());
			TokenError::OffScale {
				path: path.to_path_buf(),
				line,
				column,
				value: weight.to_string(),
				scale_name: format!("type.weight.{}", step.as_token()),
				allowed: "a CSS font weight, 1 to 1000".to_string(),
			}
		})?;
	}

	let mono_tbl = type_tbl.sub("mono")?;
	let mut mono_sizes = [TypeSize { size: 0.0, line_height: 0.0, tracking_em: 0.0 }; 2];
	for step in MonoSizeStep::all() {
		let entry = mono_tbl.sub(step.as_token())?;
		entry.only(&["size", "line_height"])?;
		mono_sizes[step as usize] = TypeSize {
			size:        entry.number("size")?,
			line_height: entry.number("line_height")?,
			tracking_em: 0.0,
		};
	}

	let stroke_tbl = root.sub("stroke")?;
	let mut strokes = [0.0f32; 3];
	for step in StrokeStep::all() {
		strokes[step as usize] = stroke_tbl.number(step.as_token())?;
	}

	Ok(ScaleTokens { spacing, radius, type_sizes, type_weights, mono_sizes, strokes })
}
