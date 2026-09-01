use std::path::Path;

use toml::Value;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file, validate_table_keys},
	schema::{
		MonoSizeStep, RadiusStep, ScaleTokens, SpacingStep, StrokeStep, TypeSize, TypeSizeStep,
		TypeWeightStep,
	},
};

/// Parses and validates scale.toml.
pub fn load_scale(path: &Path) -> Result<ScaleTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = val.as_table().ok_or_else(|| TokenError::MissingKey {
		path:    path.to_path_buf(),
		section: "root".to_string(),
		key:     "spacing".to_string(),
	})?;

	validate_table_keys(path, &text, "root", root, &[
		"meta", "spacing", "radius", "type", "stroke",
	])?;

	let spacing_tbl = root
		.get("spacing")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "spacing".to_string(),
		})?;

	if spacing_tbl.len() > 16 {
		return Err(TokenError::CeilingExceeded {
			path:         path.to_path_buf(),
			section:      "spacing scale".to_string(),
			count:        spacing_tbl.len(),
			ceiling:      16,
			spec_section: "6.1",
		});
	}

	let mut spacing = [0.0f32; 14];
	for step in SpacingStep::all() {
		let key = step.as_token();
		let item = spacing_tbl.get(key).ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "spacing".to_string(),
			key:     key.to_string(),
		})?;
		let val = match item {
			Value::Integer(i) => *i as f32,
			Value::Float(f) => *f as f32,
			_ => 0.0,
		};
		spacing[step as usize] = val;
	}

	let radius_tbl = root
		.get("radius")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "radius".to_string(),
		})?;

	if radius_tbl.len() > 8 {
		return Err(TokenError::CeilingExceeded {
			path:         path.to_path_buf(),
			section:      "corner radii".to_string(),
			count:        radius_tbl.len(),
			ceiling:      8,
			spec_section: "6.2",
		});
	}

	let mut radius = [0.0f32; 8];
	for step in RadiusStep::all() {
		let key = step.as_token();
		let item = radius_tbl.get(key).ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "radius".to_string(),
			key:     key.to_string(),
		})?;
		let val = match item {
			Value::Integer(i) => *i as f32,
			Value::Float(f) => *f as f32,
			_ => 0.0,
		};
		radius[step as usize] = val;
	}

	let type_tbl =
		root
			.get("type")
			.and_then(Value::as_table)
			.ok_or_else(|| TokenError::MissingKey {
				path:    path.to_path_buf(),
				section: "root".to_string(),
				key:     "type".to_string(),
			})?;

	let size_tbl = type_tbl
		.get("size")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "type".to_string(),
			key:     "size".to_string(),
		})?;

	if size_tbl.len() > 6 {
		return Err(TokenError::CeilingExceeded {
			path:         path.to_path_buf(),
			section:      "typographic sizes".to_string(),
			count:        size_tbl.len(),
			ceiling:      6,
			spec_section: "6.3",
		});
	}

	let mut type_sizes = [TypeSize { size: 0.0, line_height: 0.0, tracking_em: 0.0 }; 6];
	for step in TypeSizeStep::all() {
		let key = step.as_token();
		let entry =
			size_tbl
				.get(key)
				.and_then(Value::as_table)
				.ok_or_else(|| TokenError::MissingKey {
					path:    path.to_path_buf(),
					section: "type.size".to_string(),
					key:     key.to_string(),
				})?;
		let size = entry.get("size").and_then(Value::as_integer).unwrap_or(0) as f32;
		let line_height = entry
			.get("line_height")
			.and_then(Value::as_integer)
			.unwrap_or(0) as f32;
		let tracking_em = entry
			.get("tracking_em")
			.and_then(Value::as_float)
			.unwrap_or(0.0) as f32;
		type_sizes[step as usize] = TypeSize { size, line_height, tracking_em };
	}

	let weight_tbl = type_tbl
		.get("weight")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "type".to_string(),
			key:     "weight".to_string(),
		})?;

	if weight_tbl.len() > 3 {
		return Err(TokenError::CeilingExceeded {
			path:         path.to_path_buf(),
			section:      "typographic weights".to_string(),
			count:        weight_tbl.len(),
			ceiling:      3,
			spec_section: "6.3",
		});
	}

	let mut type_weights = [400u16; 3];
	for step in TypeWeightStep::all() {
		let key = step.as_token();
		let w = weight_tbl
			.get(key)
			.and_then(Value::as_integer)
			.unwrap_or(400) as u16;
		type_weights[step as usize] = w;
	}

	let mono_tbl = type_tbl
		.get("mono")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "type".to_string(),
			key:     "mono".to_string(),
		})?;

	let mut mono_sizes = [TypeSize { size: 0.0, line_height: 0.0, tracking_em: 0.0 }; 2];
	for step in MonoSizeStep::all() {
		let key = step.as_token();
		let entry =
			mono_tbl
				.get(key)
				.and_then(Value::as_table)
				.ok_or_else(|| TokenError::MissingKey {
					path:    path.to_path_buf(),
					section: "type.mono".to_string(),
					key:     key.to_string(),
				})?;
		let size = entry.get("size").and_then(Value::as_integer).unwrap_or(0) as f32;
		let line_height = entry
			.get("line_height")
			.and_then(Value::as_integer)
			.unwrap_or(0) as f32;
		mono_sizes[step as usize] = TypeSize { size, line_height, tracking_em: 0.0 };
	}

	let stroke_tbl = root
		.get("stroke")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "stroke".to_string(),
		})?;

	let mut strokes = [1.0f32; 3];
	for step in StrokeStep::all() {
		let key = step.as_token();
		let s = stroke_tbl
			.get(key)
			.and_then(|v| match v {
				Value::Float(f) => Some(*f as f32),
				Value::Integer(i) => Some(*i as f32),
				_ => None,
			})
			.unwrap_or(1.0);
		strokes[step as usize] = s;
	}

	Ok(ScaleTokens { spacing, radius, type_sizes, type_weights, mono_sizes, strokes })
}
