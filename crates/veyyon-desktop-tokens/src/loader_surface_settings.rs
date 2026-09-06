use std::path::Path;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file},
	schema::ScaleTokens,
	section::Section,
	surface::SettingsSurfaceTokens,
};

/// Loads settings surface tokens from `surface/settings.toml`.
pub fn load_settings(
	path: &Path,
	scale: &ScaleTokens,
) -> Result<SettingsSurfaceTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = Section::root(path, &text, &val)?;
	root.only(&["meta", "layout", "typography"])?;
	root.meta("surface_settings")?;

	let layout = root.sub("layout")?;
	layout.only(&["row_height_px", "row_gap", "group_gap", "control_column_width_px"])?;

	let typo = root.sub("typography")?;
	typo.only(&["label_size", "description_size"])?;

	Ok(SettingsSurfaceTokens {
		row_height_px:           layout.number("row_height_px")?,
		row_gap:                 layout.spacing("row_gap", scale)?,
		group_gap:               layout.spacing("group_gap", scale)?,
		control_column_width_px: layout.number("control_column_width_px")?,
		label_size:              typo.type_size("label_size", scale)?,
		description_size:        typo.type_size("description_size", scale)?,
	})
}
