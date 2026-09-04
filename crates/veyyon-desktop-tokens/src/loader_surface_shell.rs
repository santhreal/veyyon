//! Loads `surface/shell.toml`: the window and titlebar geometry of §4.1.
//!
//! Every key is required. A loader that defaults a missing dimension to zero
//! produces a titlebar of no height or a window with no minimum, which renders
//! as a broken shell rather than as a failure, so the file has to say what it
//! means or fail to load.

use std::path::Path;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file},
	schema::ScaleTokens,
	section::Section,
	surface::ShellSurfaceTokens,
};

/// Parses and validates `surface/shell.toml`.
pub fn load_shell(path: &Path, scale: &ScaleTokens) -> Result<ShellSurfaceTokens, TokenError> {
	let text = read_file(path)?;
	let parsed = parse_toml(path, &text)?;
	let root = Section::root(path, &text, &parsed)?;
	root.only(&["meta", "window", "titlebar", "grain"])?;
	root.meta("surface_shell")?;

	let window = root.sub("window")?;
	window.only(&["min_width_px", "min_height_px"])?;

	let titlebar = root.sub("titlebar")?;
	titlebar.only(&[
		"height_px",
		"control_px",
		"control_gap_px",
		"inset_left_px",
		"inset_right_px",
	])?;

	let grain = root.sub("grain")?;
	grain.only(&["tile_px", "opacity"])?;

	Ok(ShellSurfaceTokens {
		window_min_width_px:     window.dimension("min_width_px")?,
		window_min_height_px:    window.dimension("min_height_px")?,
		titlebar_height_px:      titlebar.dimension("height_px")?,
		titlebar_control_px:     titlebar.dimension("control_px")?,
		titlebar_control_gap_px: titlebar.spacing("control_gap_px", scale)?,
		titlebar_inset_left_px:  titlebar.spacing("inset_left_px", scale)?,
		titlebar_inset_right_px: titlebar.spacing("inset_right_px", scale)?,
		grain_tile_px:           grain.dimension("tile_px")?,
		grain_opacity:           grain.ratio("opacity")?,
	})
}
