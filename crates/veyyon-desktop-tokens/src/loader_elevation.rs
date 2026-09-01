use std::path::Path;

use toml::Value;

use crate::{
	elevation::{ElevationLevel, ElevationTokens},
	error::TokenError,
	loader::{parse_toml, read_file, validate_table_keys},
};

/// Parses and validates elevation.toml.
pub fn load_elevation(path: &Path) -> Result<ElevationTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = val.as_table().ok_or_else(|| TokenError::MissingKey {
		path:    path.to_path_buf(),
		section: "root".to_string(),
		key:     "level".to_string(),
	})?;

	validate_table_keys(path, &text, "root", root, &["meta", "level"])?;

	let levels_arr =
		root
			.get("level")
			.and_then(Value::as_array)
			.ok_or_else(|| TokenError::MissingKey {
				path:    path.to_path_buf(),
				section: "root".to_string(),
				key:     "level".to_string(),
			})?;

	if levels_arr.len() != 5 {
		return Err(TokenError::CeilingExceeded {
			path:         path.to_path_buf(),
			section:      "elevation levels".to_string(),
			count:        levels_arr.len(),
			ceiling:      5,
			spec_section: "6.5",
		});
	}

	let mut levels: Vec<ElevationLevel> = Vec::with_capacity(5);
	for item in levels_arr {
		let tbl = item.as_table().ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "level".to_string(),
			key:     "index".to_string(),
		})?;
		let index = tbl.get("index").and_then(Value::as_integer).unwrap_or(0) as u8;
		let role = tbl
			.get("role")
			.and_then(Value::as_str)
			.unwrap_or("")
			.to_string();
		let ground_role = tbl
			.get("ground_role")
			.and_then(Value::as_str)
			.unwrap_or("")
			.to_string();
		let grain_enabled = tbl
			.get("grain_enabled")
			.and_then(Value::as_bool)
			.unwrap_or(false);
		let grain_texture = tbl
			.get("grain_texture")
			.and_then(Value::as_str)
			.map(ToString::to_string);
		let grain_opacity = tbl
			.get("grain_opacity")
			.and_then(Value::as_float)
			.map(|f| f as f32);
		let blur_px = tbl
			.get("blur_px")
			.and_then(|v| match v {
				Value::Integer(i) => Some(*i as f32),
				Value::Float(f) => Some(*f as f32),
				_ => None,
			})
			.unwrap_or(0.0);
		let saturation = tbl
			.get("saturation")
			.and_then(Value::as_float)
			.map(|f| f as f32);
		let ground_opacity = tbl
			.get("ground_opacity")
			.and_then(Value::as_float)
			.map(|f| f as f32);
		let edge = tbl
			.get("edge")
			.and_then(Value::as_str)
			.unwrap_or("none")
			.to_string();
		let has_shadow = tbl
			.get("has_shadow")
			.and_then(Value::as_bool)
			.unwrap_or(false);
		let shadow_x = tbl.get("shadow_x").and_then(|v| match v {
			Value::Integer(i) => Some(*i as f32),
			Value::Float(f) => Some(*f as f32),
			_ => None,
		});
		let shadow_y = tbl.get("shadow_y").and_then(|v| match v {
			Value::Integer(i) => Some(*i as f32),
			Value::Float(f) => Some(*f as f32),
			_ => None,
		});
		let shadow_blur = tbl.get("shadow_blur").and_then(|v| match v {
			Value::Integer(i) => Some(*i as f32),
			Value::Float(f) => Some(*f as f32),
			_ => None,
		});
		let shadow_spread = tbl.get("shadow_spread").and_then(|v| match v {
			Value::Integer(i) => Some(*i as f32),
			Value::Float(f) => Some(*f as f32),
			_ => None,
		});
		let shadow_opacity = tbl
			.get("shadow_opacity")
			.and_then(Value::as_float)
			.map(|f| f as f32);

		levels.push(ElevationLevel {
			index,
			role,
			ground_role,
			grain_enabled,
			grain_texture,
			grain_opacity,
			blur_px,
			saturation,
			ground_opacity,
			edge,
			has_shadow,
			shadow_x,
			shadow_y,
			shadow_blur,
			shadow_spread,
			shadow_opacity,
		});
	}

	let arr: [ElevationLevel; 5] = levels.try_into().map_err(|_| TokenError::MissingKey {
		path:    path.to_path_buf(),
		section: "elevation".to_string(),
		key:     "level".to_string(),
	})?;

	Ok(ElevationTokens { levels: arr })
}
