use std::path::Path;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file},
	schema::ScaleTokens,
	section::Section,
	surface::PanelsSurfaceTokens,
};

/// Loads right panel and terminal drawer tokens from `surface/panels.toml`.
pub fn load_panels(path: &Path, scale: &ScaleTokens) -> Result<PanelsSurfaceTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = Section::root(path, &text, &val)?;
	root.only(&["meta", "right_panel", "terminal_drawer", "tabs", "chrome", "tree", "diff"])?;
	root.meta("surface_panels")?;

	let rp = root.sub("right_panel")?;
	rp.only(&[
		"min_width_px",
		"default_width_px",
		"max_viewport_ratio",
		"container_margin_px",
		"overlay_breakpoint_px",
		"overlay_scrim_blur_px",
	])?;

	let td = root.sub("terminal_drawer")?;
	td.only(&[
		"min_height_px",
		"max_viewport_ratio",
		"cell_width_px",
		"cell_height_px",
		"min_columns",
		"min_rows",
		"process_row_height_px",
		"process_dot_px",
	])?;

	let tabs = root.sub("tabs")?;
	tabs.only(&["height_px", "gap_px", "max_width_px", "close_hit_px", "pending_dot_px"])?;

	let chrome = root.sub("chrome")?;
	chrome.only(&["row_height_px", "resize_handle_hit_px", "resize_handle_line_px"])?;

	let tree = root.sub("tree")?;
	tree.only(&["indent_base_px", "indent_step_px", "row_height_px", "font_size"])?;

	let diff = root.sub("diff")?;
	diff.only(&[
		"row_height_px",
		"font_size",
		"gutter_width_px",
		"sign_width_px",
		"hunk_header_height_px",
		"added_removed_alpha",
		"intraline_alpha",
	])?;

	Ok(PanelsSurfaceTokens {
		right_panel_min_width_px: rp.number("min_width_px")?,
		right_panel_default_width_px: rp.number("default_width_px")?,
		right_panel_max_viewport_ratio: rp.ratio("max_viewport_ratio")?,
		right_panel_container_margin_px: rp.number("container_margin_px")?,
		right_panel_overlay_breakpoint_px: rp.number("overlay_breakpoint_px")?,
		right_panel_overlay_scrim_blur_px: rp.number("overlay_scrim_blur_px")?,
		terminal_drawer_min_height_px: td.number("min_height_px")?,
		terminal_drawer_max_viewport_ratio: td.ratio("max_viewport_ratio")?,
		terminal_cell_width_px: td.number("cell_width_px")?,
		terminal_cell_height_px: td.number("cell_height_px")?,
		terminal_min_columns: td.count("min_columns")?,
		terminal_min_rows: td.count("min_rows")?,
		process_row_height_px: td.number("process_row_height_px")?,
		process_dot_px: td.number("process_dot_px")?,
		tabs_height_px: tabs.number("height_px")?,
		tabs_gap_px: tabs.number("gap_px")?,
		tabs_max_width_px: tabs.number("max_width_px")?,
		tabs_close_hit_px: tabs.number("close_hit_px")?,
		tabs_pending_dot_px: tabs.number("pending_dot_px")?,
		chrome_row_height_px: chrome.number("row_height_px")?,
		chrome_resize_handle_hit_px: chrome.number("resize_handle_hit_px")?,
		chrome_resize_handle_line_px: chrome.number("resize_handle_line_px")?,
		tree_indent_base_px: tree.number("indent_base_px")?,
		tree_indent_step_px: tree.number("indent_step_px")?,
		tree_row_height_px: tree.number("row_height_px")?,
		tree_font_size: tree.type_size("font_size", scale)?,
		diff_row_height_px: diff.number("row_height_px")?,
		diff_font_size: diff.type_size("font_size", scale)?,
		diff_gutter_width_px: diff.number("gutter_width_px")?,
		diff_sign_width_px: diff.number("sign_width_px")?,
		diff_hunk_header_height_px: diff.number("hunk_header_height_px")?,
		diff_added_removed_alpha: diff.ratio("added_removed_alpha")?,
		diff_intraline_alpha: diff.ratio("intraline_alpha")?,
	})
}
