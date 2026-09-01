use std::path::Path;

use toml::Value;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file, validate_table_keys},
	loader_surface::{resolve_spacing_opt, resolve_type_size_opt},
	schema::{ScaleTokens, SpacingStep, TypeSizeStep},
	surface::SettingsSurfaceTokens,
};

/// Loads settings surface tokens from `surface/settings.toml`.
pub fn load_settings(
	path: &Path,
	scale: &ScaleTokens,
) -> Result<SettingsSurfaceTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = val.as_table().ok_or_else(|| TokenError::MissingKey {
		path:    path.to_path_buf(),
		section: "root".to_string(),
		key:     "layout".to_string(),
	})?;
	validate_table_keys(path, &text, "root", root, &["meta", "layout", "typography"])?;

	let layout = root
		.get("layout")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "layout".to_string(),
		})?;
	let row_height_px = layout
		.get("row_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(44) as f32;
	let row_gap = resolve_spacing_opt(
		path,
		&text,
		"layout",
		"row_gap",
		layout.get("row_gap"),
		SpacingStep::S4,
		scale,
	)?;
	let group_gap = resolve_spacing_opt(
		path,
		&text,
		"layout",
		"group_gap",
		layout.get("group_gap"),
		SpacingStep::S10,
		scale,
	)?;
	let control_column_width_px = layout
		.get("control_column_width_px")
		.and_then(Value::as_integer)
		.unwrap_or(240) as f32;

	let typo = root
		.get("typography")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "typography".to_string(),
		})?;
	let label_size = resolve_type_size_opt(
		path,
		&text,
		"typography",
		"label_size",
		typo.get("label_size"),
		TypeSizeStep::Read,
		scale,
	)?;
	let description_size = resolve_type_size_opt(
		path,
		&text,
		"typography",
		"description_size",
		typo.get("description_size"),
		TypeSizeStep::Small,
		scale,
	)?;

	Ok(SettingsSurfaceTokens {
		row_height_px,
		row_gap,
		group_gap,
		control_column_width_px,
		label_size,
		description_size,
	})
}
