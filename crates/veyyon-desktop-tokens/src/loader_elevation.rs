use std::path::Path;

use toml::Value;

use crate::{
	elevation::{ElevationLevel, ElevationTokens, FloatShadowModel, ShadowCurve},
	error::TokenError,
	loader::{find_key_line_col, parse_toml, read_file},
	section::Section,
};

const ALWAYS: [&str; 6] = ["index", "role", "ground_role", "grain_enabled", "blur_px", "edge"];
const GRAIN: [&str; 2] = ["grain_texture", "grain_opacity"];
const GLASS: [&str; 2] = ["saturation", "ground_opacity"];
const SHADOW: [&str; 1] = ["shadow_opacity"];
const CURVE: [&str; 11] = [
	"y_ratio",
	"y_min_px",
	"y_max_px",
	"blur_ratio",
	"blur_min_px",
	"blur_max_px",
	"spread_ratio",
	"spread_min_px",
	"spread_max_px",
	"dark_opacity",
	"light_opacity",
];

/// One curve of the float shadow model. Every key is required: a curve missing
/// a bound would have to invent the range it draws inside.
fn parse_curve(curve: &Section<'_>) -> Result<ShadowCurve, TokenError> {
	curve.only(&CURVE)?;
	Ok(ShadowCurve {
		y_ratio:       curve.number("y_ratio")?,
		y_min_px:      curve.number("y_min_px")?,
		y_max_px:      curve.number("y_max_px")?,
		blur_ratio:    curve.number("blur_ratio")?,
		blur_min_px:   curve.number("blur_min_px")?,
		blur_max_px:   curve.number("blur_max_px")?,
		spread_ratio:  curve.number("spread_ratio")?,
		spread_min_px: curve.number("spread_min_px")?,
		spread_max_px: curve.number("spread_max_px")?,
		dark_opacity:  curve.number("dark_opacity")?,
		light_opacity: curve.number("light_opacity")?,
	})
}

/// One `[[level]]` entry. A key is present when, and only when, the flag that
/// gives it meaning is set: a shadow parameter on a level without a shadow is
/// a value nothing reads, and a level with a shadow and no parameters is a
/// shadow the loader would have to invent.
fn parse_level(level: &Section<'_>, expected_index: u8) -> Result<ElevationLevel, TokenError> {
	let grain_enabled = level.boolean("grain_enabled")?;
	let blur_px = level.number("blur_px")?;
	let has_shadow = level.boolean("has_shadow")?;

	let mut expected: Vec<&'static str> = ALWAYS.to_vec();
	expected.push("has_shadow");
	if grain_enabled {
		expected.extend(GRAIN);
	}
	if blur_px > 0.0 {
		expected.extend(GLASS);
	}
	if has_shadow {
		expected.extend(SHADOW);
	}
	level.only(&expected)?;

	let index = level.integer("index")?;
	if index != i64::from(expected_index) {
		let (line, column) = find_key_line_col(level.text(), level.name(), "index");
		return Err(TokenError::OffScale {
			path: level.path().to_path_buf(),
			line,
			column,
			value: index.to_string(),
			scale_name: format!("{}.index", level.name()),
			allowed: format!("{expected_index}, the level's position in the list"),
		});
	}

	let optional = |key: &str, on: bool| -> Result<Option<f32>, TokenError> {
		if on {
			level.number(key).map(Some)
		} else {
			Ok(None)
		}
	};

	Ok(ElevationLevel {
		index: expected_index,
		role: level.string("role")?.to_string(),
		ground_role: level.string("ground_role")?.to_string(),
		grain_enabled,
		grain_texture: if grain_enabled {
			Some(level.string("grain_texture")?.to_string())
		} else {
			None
		},
		grain_opacity: optional("grain_opacity", grain_enabled)?,
		blur_px,
		saturation: optional("saturation", blur_px > 0.0)?,
		ground_opacity: optional("ground_opacity", blur_px > 0.0)?,
		edge: level.string("edge")?.to_string(),
		has_shadow,
		shadow_opacity: optional("shadow_opacity", has_shadow)?,
	})
}

/// Parses and validates elevation.toml.
pub fn load_elevation(path: &Path) -> Result<ElevationTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = Section::root(path, &text, &val)?;
	root.only(&["meta", "level", "float_shadow", "frost"])?;
	root.meta("elevation")?;

	let levels_value = root.get("level")?;
	let Value::Array(levels_arr) = levels_value else {
		return Err(TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "level".to_string(),
		});
	};
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
	for (position, item) in levels_arr.iter().enumerate() {
		let name = format!("level.{position}");
		let table = item.as_table().ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: name.clone(),
			key:     "index".to_string(),
		})?;
		let level = root.named(name, table);
		levels.push(parse_level(&level, position as u8)?);
	}

	let arr: [ElevationLevel; 5] = levels.try_into().map_err(|_| TokenError::MissingKey {
		path:    path.to_path_buf(),
		section: "elevation".to_string(),
		key:     "level".to_string(),
	})?;

	let shadow = root.sub("float_shadow")?;
	shadow.only(&[
		"default_rise_px",
		"inner_highlight_y_px",
		"inner_highlight_dark",
		"inner_highlight_light",
		"key",
		"ambient",
	])?;
	let frost = root.sub("frost")?;
	frost.only(&["overlay_blur_px"])?;

	Ok(ElevationTokens {
		levels:          arr,
		float_shadow:    FloatShadowModel {
			default_rise_px:       shadow.number("default_rise_px")?,
			key:                   parse_curve(&shadow.sub("key")?)?,
			ambient:               parse_curve(&shadow.sub("ambient")?)?,
			inner_highlight_y_px:  shadow.number("inner_highlight_y_px")?,
			inner_highlight_dark:  shadow.number("inner_highlight_dark")?,
			inner_highlight_light: shadow.number("inner_highlight_light")?,
		},
		overlay_blur_px: frost.number("overlay_blur_px")?,
	})
}
