use std::path::Path;

use crate::{
	controls::ControlTokens,
	error::TokenError,
	loader::{parse_toml, read_file},
	section::Section,
};

/// Parses and validates controls.toml.
pub fn load_controls(path: &Path) -> Result<ControlTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = Section::root(path, &text, &val)?;
	root.only(&["meta", "height", "toggle", "scroll", "tooltip", "popover", "editor"])?;
	root.meta("controls")?;

	let height = root.sub("height")?;
	height.only(&["small_px", "medium_px", "large_px"])?;
	let toggle = root.sub("toggle")?;
	toggle.only(&["track_width_px"])?;
	let scroll = root.sub("scroll")?;
	scroll.only(&["fade_px"])?;
	let tooltip = root.sub("tooltip")?;
	tooltip.only(&["estimated_height_px", "estimated_advance_ratio"])?;
	let popover = root.sub("popover")?;
	popover.only(&["estimated_width_px", "estimated_height_px"])?;
	let editor = root.sub("editor")?;
	editor.only(&["caret_width_px", "unmeasured_wrap_width_px"])?;

	Ok(ControlTokens {
		height_small_px:                 height.number("small_px")?,
		height_medium_px:                height.number("medium_px")?,
		height_large_px:                 height.number("large_px")?,
		toggle_track_width_px:           toggle.number("track_width_px")?,
		scroll_fade_px:                  scroll.number("fade_px")?,
		tooltip_estimated_height_px:     tooltip.number("estimated_height_px")?,
		tooltip_estimated_advance_ratio: tooltip.ratio("estimated_advance_ratio")?,
		popover_estimated_width_px:      popover.number("estimated_width_px")?,
		popover_estimated_height_px:     popover.number("estimated_height_px")?,
		editor_caret_width_px:           editor.number("caret_width_px")?,
		editor_unmeasured_wrap_width_px: editor.number("unmeasured_wrap_width_px")?,
	})
}
