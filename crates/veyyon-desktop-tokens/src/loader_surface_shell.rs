//! Loads `surface/shell.toml`: the window and titlebar geometry of §4.1.
//!
//! Every key is required. A loader that defaults a missing dimension to zero
//! produces a titlebar of no height or a window with no minimum, which renders
//! as a broken shell rather than as a failure, so the file has to say what it
//! means or fail to load.

use std::path::Path;

use toml::{Value, map::Map};

use crate::{
	error::TokenError,
	loader::{find_key_line_col, parse_toml, read_file, validate_table_keys},
	loader_surface::resolve_spacing,
	schema::ScaleTokens,
	surface::ShellSurfaceTokens,
};

/// Reads a required table.
fn require_table<'a>(
	path: &Path,
	parent: &'a Map<String, Value>,
	section: &str,
) -> Result<&'a Map<String, Value>, TokenError> {
	parent
		.get(section)
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: section.to_string(),
			key:     section.to_string(),
		})
}

/// Reads a required pixel dimension declared as a plain number.
///
/// A dimension is rejected when absent, when it is not a number, and when it is
/// negative or not finite: a titlebar of -52px is not a smaller titlebar, it is
/// a layout that computes nonsense for every row below it.
fn require_px(
	path: &Path,
	text: &str,
	table: &Map<String, Value>,
	section: &str,
	key: &str,
) -> Result<f32, TokenError> {
	let raw = table
		.get(key)
		.and_then(Value::as_float)
		.or_else(|| {
			table
				.get(key)
				.and_then(Value::as_integer)
				.map(|value| value as f64)
		})
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: section.to_string(),
			key:     key.to_string(),
		})?;

	let value = raw as f32;
	if !value.is_finite() || value < 0.0 {
		let (line, column) = find_key_line_col(text, section, key);
		return Err(TokenError::OffScale {
			path: path.to_path_buf(),
			line,
			column,
			value: raw.to_string(),
			scale_name: format!("{section}.{key}"),
			allowed: "a finite dimension of zero or more".to_string(),
		});
	}
	Ok(value)
}

/// Reads a required ratio in `0.0..=1.0`.
fn require_ratio(
	path: &Path,
	text: &str,
	table: &Map<String, Value>,
	section: &str,
	key: &str,
) -> Result<f32, TokenError> {
	let value = require_px(path, text, table, section, key)?;
	if value > 1.0 {
		let (line, column) = find_key_line_col(text, section, key);
		return Err(TokenError::OffScale {
			path: path.to_path_buf(),
			line,
			column,
			value: value.to_string(),
			scale_name: format!("{section}.{key}"),
			allowed: "0.0 to 1.0".to_string(),
		});
	}
	Ok(value)
}

/// Reads a spacing-referencing key, so a gap stays on the §6.1 scale.
fn require_spacing(
	path: &Path,
	text: &str,
	table: &Map<String, Value>,
	section: &str,
	key: &str,
	scale: &ScaleTokens,
) -> Result<f32, TokenError> {
	let value = table.get(key).ok_or_else(|| TokenError::MissingKey {
		path:    path.to_path_buf(),
		section: section.to_string(),
		key:     key.to_string(),
	})?;
	resolve_spacing(path, text, section, key, value, scale)
}

/// Parses and validates `surface/shell.toml`.
pub fn load_shell(path: &Path, scale: &ScaleTokens) -> Result<ShellSurfaceTokens, TokenError> {
	let text = read_file(path)?;
	let parsed = parse_toml(path, &text)?;
	let root = parsed.as_table().ok_or_else(|| TokenError::MissingKey {
		path:    path.to_path_buf(),
		section: "root".to_string(),
		key:     "window".to_string(),
	})?;
	validate_table_keys(path, &text, "root", root, &["meta", "window", "titlebar", "grain"])?;

	let window = require_table(path, root, "window")?;
	validate_table_keys(path, &text, "window", window, &["min_width_px", "min_height_px"])?;

	let titlebar = require_table(path, root, "titlebar")?;
	validate_table_keys(path, &text, "titlebar", titlebar, &[
		"height_px",
		"control_px",
		"control_gap_px",
		"inset_left_px",
		"inset_right_px",
	])?;

	let grain = require_table(path, root, "grain")?;
	validate_table_keys(path, &text, "grain", grain, &["tile_px", "opacity"])?;

	Ok(ShellSurfaceTokens {
		window_min_width_px:     require_px(path, &text, window, "window", "min_width_px")?,
		window_min_height_px:    require_px(path, &text, window, "window", "min_height_px")?,
		titlebar_height_px:      require_px(path, &text, titlebar, "titlebar", "height_px")?,
		titlebar_control_px:     require_px(path, &text, titlebar, "titlebar", "control_px")?,
		titlebar_control_gap_px: require_spacing(
			path,
			&text,
			titlebar,
			"titlebar",
			"control_gap_px",
			scale,
		)?,
		titlebar_inset_left_px:  require_spacing(
			path,
			&text,
			titlebar,
			"titlebar",
			"inset_left_px",
			scale,
		)?,
		titlebar_inset_right_px: require_spacing(
			path,
			&text,
			titlebar,
			"titlebar",
			"inset_right_px",
			scale,
		)?,
		grain_tile_px:           require_px(path, &text, grain, "grain", "tile_px")?,
		grain_opacity:           require_ratio(path, &text, grain, "grain", "opacity")?,
	})
}
