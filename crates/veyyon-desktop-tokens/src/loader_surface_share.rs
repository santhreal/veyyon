use std::path::Path;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file},
	scale::ScaleTokens,
	section::Section,
	surface::ShareSurfaceTokens,
};

/// Loads share surface tokens from `surface/share.toml`.
pub fn load_share(path: &Path, scale: &ScaleTokens) -> Result<ShareSurfaceTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = Section::root(path, &text, &val)?;
	root.only(&["meta", "layout"])?;
	root.meta("surface_share")?;

	let layout = root.sub("layout")?;
	layout.only(&["card_width_px", "card_height_px", "row_height_px", "row_gap", "padding"])?;

	Ok(ShareSurfaceTokens {
		card_width_px:  layout.number("card_width_px")?,
		card_height_px: layout.number("card_height_px")?,
		row_height_px:  layout.number("row_height_px")?,
		row_gap:        layout.spacing("row_gap", scale)?,
		padding:        layout.spacing("padding", scale)?,
	})
}
