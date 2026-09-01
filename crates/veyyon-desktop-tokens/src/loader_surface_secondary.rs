use std::path::Path;

use toml::Value;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file, validate_table_keys},
	loader_surface::{resolve_radius_opt, resolve_spacing_opt, resolve_type_size_opt},
	schema::{RadiusStep, ScaleTokens, SpacingStep, TypeSizeStep},
	surface::{
		BreakpointConfig, BreakpointsSurfaceTokens, PaletteSurfaceTokens, PanelsSurfaceTokens,
		SettingsSurfaceTokens,
	},
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

/// Loads command palette tokens from `surface/palette.toml`.
pub fn load_palette(path: &Path, scale: &ScaleTokens) -> Result<PaletteSurfaceTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = val.as_table().ok_or_else(|| TokenError::MissingKey {
		path:    path.to_path_buf(),
		section: "root".to_string(),
		key:     "geometry".to_string(),
	})?;
	validate_table_keys(path, &text, "root", root, &["meta", "geometry", "input", "results"])?;

	let geom = root
		.get("geometry")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "geometry".to_string(),
		})?;
	validate_table_keys(path, &text, "geometry", geom, &[
		"width_px",
		"max_height_px",
		"radius",
		"elevation_level",
	])?;
	let width_px = geom
		.get("width_px")
		.and_then(Value::as_integer)
		.unwrap_or(576) as f32;
	let max_height_px = geom
		.get("max_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(420) as f32;
	let radius = resolve_radius_opt(
		path,
		&text,
		"geometry",
		"radius",
		geom.get("radius"),
		RadiusStep::Xxl,
		scale,
	)?;
	let elevation_level = geom
		.get("elevation_level")
		.and_then(Value::as_integer)
		.unwrap_or(4) as u8;

	let input =
		root
			.get("input")
			.and_then(Value::as_table)
			.ok_or_else(|| TokenError::MissingKey {
				path:    path.to_path_buf(),
				section: "root".to_string(),
				key:     "input".to_string(),
			})?;
	let input_row_height_px = input
		.get("row_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(40) as f32;
	let input_inset = resolve_spacing_opt(
		path,
		&text,
		"input",
		"inset",
		input.get("inset"),
		SpacingStep::S8,
		scale,
	)?;
	let input_search_icon_px = input
		.get("search_icon_px")
		.and_then(Value::as_integer)
		.unwrap_or(16) as f32;

	let results = root
		.get("results")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "results".to_string(),
		})?;
	let results_row_height_px = results
		.get("row_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(32) as f32;
	let results_group_header_height_px = results
		.get("group_header_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(20) as f32;
	let results_footer_height_px = results
		.get("footer_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(32) as f32;
	let results_key_hint_size = resolve_type_size_opt(
		path,
		&text,
		"results",
		"key_hint_size",
		results.get("key_hint_size"),
		TypeSizeStep::Micro,
		scale,
	)?;

	Ok(PaletteSurfaceTokens {
		width_px,
		max_height_px,
		radius,
		elevation_level,
		input_row_height_px,
		input_inset,
		input_search_icon_px,
		results_row_height_px,
		results_group_header_height_px,
		results_footer_height_px,
		results_key_hint_size,
	})
}

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

/// Loads breakpoints surface configuration from `surface/breakpoints.toml`.
pub fn load_breakpoints(path: &Path) -> Result<BreakpointsSurfaceTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = val.as_table().ok_or_else(|| TokenError::MissingKey {
		path:    path.to_path_buf(),
		section: "root".to_string(),
		key:     "breakpoint".to_string(),
	})?;
	validate_table_keys(path, &text, "root", root, &["meta", "breakpoint"])?;

	let bp = root
		.get("breakpoint")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "breakpoint".to_string(),
		})?;

	fn parse_bp(bp_tbl: &toml::map::Map<String, Value>, name: &str) -> BreakpointConfig {
		let t = bp_tbl.get(name).and_then(Value::as_table);
		let min_width_px = t
			.and_then(|t| t.get("min_width_px"))
			.and_then(Value::as_integer)
			.unwrap_or(0) as f32;
		let queue_width_px = t
			.and_then(|t| t.get("queue_width_px"))
			.and_then(Value::as_integer)
			.unwrap_or(0) as f32;
		let right_panel_mode = t
			.and_then(|t| t.get("right_panel_mode"))
			.and_then(Value::as_str)
			.unwrap_or("overlay")
			.to_string();
		let terminal_drawer_height_px = t
			.and_then(|t| t.get("terminal_drawer_height_px"))
			.and_then(Value::as_integer)
			.unwrap_or(180) as f32;
		let composer_footer_labels = t
			.and_then(|t| t.get("composer_footer_labels"))
			.and_then(Value::as_bool)
			.unwrap_or(false);
		let run_bar_labels = t
			.and_then(|t| t.get("run_bar_labels"))
			.and_then(Value::as_bool)
			.unwrap_or(false);

		BreakpointConfig {
			min_width_px,
			queue_width_px,
			right_panel_mode,
			terminal_drawer_height_px,
			composer_footer_labels,
			run_bar_labels,
		}
	}

	Ok(BreakpointsSurfaceTokens {
		wide:      parse_bp(bp, "wide"),
		standard:  parse_bp(bp, "standard"),
		compact:   parse_bp(bp, "compact"),
		collapsed: parse_bp(bp, "collapsed"),
	})
}
