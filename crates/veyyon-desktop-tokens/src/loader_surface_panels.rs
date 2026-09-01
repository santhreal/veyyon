use std::path::Path;

use toml::Value;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file, validate_table_keys},
	loader_surface::resolve_type_size_opt,
	schema::{ScaleTokens, TypeSizeStep},
	surface::PanelsSurfaceTokens,
};

/// Loads right panel and terminal drawer tokens from `surface/panels.toml`.
pub fn load_panels(path: &Path, scale: &ScaleTokens) -> Result<PanelsSurfaceTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = val.as_table().ok_or_else(|| TokenError::MissingKey {
		path:    path.to_path_buf(),
		section: "root".to_string(),
		key:     "right_panel".to_string(),
	})?;
	validate_table_keys(path, &text, "root", root, &[
		"meta",
		"right_panel",
		"terminal_drawer",
		"tabs",
		"chrome",
		"tree",
		"diff",
	])?;

	let rp = root
		.get("right_panel")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "right_panel".to_string(),
		})?;
	let right_panel_min_width_px = rp
		.get("min_width_px")
		.and_then(Value::as_integer)
		.unwrap_or(360) as f32;
	let right_panel_default_width_px = rp
		.get("default_width_px")
		.and_then(Value::as_integer)
		.unwrap_or(540) as f32;
	let right_panel_max_viewport_ratio = rp
		.get("max_viewport_ratio")
		.and_then(Value::as_float)
		.unwrap_or(0.70) as f32;
	let right_panel_container_margin_px = rp
		.get("container_margin_px")
		.and_then(Value::as_integer)
		.unwrap_or(360) as f32;
	let right_panel_overlay_breakpoint_px = rp
		.get("overlay_breakpoint_px")
		.and_then(Value::as_integer)
		.unwrap_or(980) as f32;
	let right_panel_overlay_scrim_blur_px = rp
		.get("overlay_scrim_blur_px")
		.and_then(Value::as_integer)
		.unwrap_or(4) as f32;

	let td = root
		.get("terminal_drawer")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "terminal_drawer".to_string(),
		})?;
	let terminal_drawer_min_height_px = td
		.get("min_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(180) as f32;
	let terminal_drawer_default_height_px = td
		.get("default_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(280) as f32;
	let terminal_drawer_max_viewport_ratio = td
		.get("max_viewport_ratio")
		.and_then(Value::as_float)
		.unwrap_or(0.75) as f32;

	let tabs = root
		.get("tabs")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "tabs".to_string(),
		})?;
	let tabs_height_px = tabs
		.get("height_px")
		.and_then(Value::as_integer)
		.unwrap_or(24) as f32;
	let tabs_gap_px = tabs.get("gap_px").and_then(Value::as_integer).unwrap_or(2) as f32;
	let tabs_max_width_px = tabs
		.get("max_width_px")
		.and_then(Value::as_integer)
		.unwrap_or(160) as f32;
	let tabs_close_hit_px = tabs
		.get("close_hit_px")
		.and_then(Value::as_integer)
		.unwrap_or(16) as f32;
	let tabs_pending_dot_px = tabs
		.get("pending_dot_px")
		.and_then(Value::as_integer)
		.unwrap_or(6) as f32;

	let chrome = root
		.get("chrome")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "chrome".to_string(),
		})?;
	let chrome_row_height_px = chrome
		.get("row_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(28) as f32;
	let chrome_resize_handle_hit_px = chrome
		.get("resize_handle_hit_px")
		.and_then(Value::as_integer)
		.unwrap_or(8) as f32;
	let chrome_resize_handle_line_px = chrome
		.get("resize_handle_line_px")
		.and_then(Value::as_integer)
		.unwrap_or(1) as f32;

	let tree = root
		.get("tree")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "tree".to_string(),
		})?;
	let tree_indent_base_px = tree
		.get("indent_base_px")
		.and_then(Value::as_integer)
		.unwrap_or(8) as f32;
	let tree_indent_step_px = tree
		.get("indent_step_px")
		.and_then(Value::as_integer)
		.unwrap_or(14) as f32;
	let tree_row_height_px = tree
		.get("row_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(24) as f32;
	let tree_font_size = resolve_type_size_opt(
		path,
		&text,
		"tree",
		"font_size",
		tree.get("font_size"),
		TypeSizeStep::Micro,
		scale,
	)?;

	let diff = root
		.get("diff")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "diff".to_string(),
		})?;
	let diff_row_height_px = diff
		.get("row_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(18) as f32;
	let diff_font_size = resolve_type_size_opt(
		path,
		&text,
		"diff",
		"font_size",
		diff.get("font_size"),
		TypeSizeStep::Body,
		scale,
	)?;
	let diff_gutter_width_px = diff
		.get("gutter_width_px")
		.and_then(Value::as_integer)
		.unwrap_or(44) as f32;

	Ok(PanelsSurfaceTokens {
		right_panel_min_width_px,
		right_panel_default_width_px,
		right_panel_max_viewport_ratio,
		right_panel_container_margin_px,
		right_panel_overlay_breakpoint_px,
		right_panel_overlay_scrim_blur_px,
		terminal_drawer_min_height_px,
		terminal_drawer_default_height_px,
		terminal_drawer_max_viewport_ratio,
		tabs_height_px,
		tabs_gap_px,
		tabs_max_width_px,
		tabs_close_hit_px,
		tabs_pending_dot_px,
		chrome_row_height_px,
		chrome_resize_handle_hit_px,
		chrome_resize_handle_line_px,
		tree_indent_base_px,
		tree_indent_step_px,
		tree_row_height_px,
		tree_font_size,
		diff_row_height_px,
		diff_font_size,
		diff_gutter_width_px,
	})
}
