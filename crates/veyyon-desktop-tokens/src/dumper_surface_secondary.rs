use std::{fmt::Write as _, path::Path};

use crate::{
	Tokens,
	dumper::write_file,
	dumper_surface_helpers::{step_radius, step_spacing, step_type_size},
	error::TokenError,
	surface::BreakpointConfig,
};

/// Writes surface/panels.toml.
pub fn dump_panels(tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let p = &tokens.surface.panels;
	let s = &tokens.scale;
	let out = format!(
		r#"[meta]
version = 1
name = "surface_panels"

[right_panel]
min_width_px = {}
default_width_px = {}
max_viewport_ratio = {:.2}
container_margin_px = {}
overlay_breakpoint_px = {}
overlay_scrim_blur_px = {}

[terminal_drawer]
min_height_px = {}
default_height_px = {}
max_viewport_ratio = {:.2}

[tabs]
height_px = {}
gap_px = {}
max_width_px = {}
close_hit_px = {}
pending_dot_px = {}

[chrome]
row_height_px = {}
resize_handle_hit_px = {}
resize_handle_line_px = {}

[tree]
indent_base_px = {}
indent_step_px = {}
row_height_px = {}
font_size = "{}"

[diff]
row_height_px = {}
font_size = "{}"
gutter_width_px = {}
"#,
		p.right_panel_min_width_px as i64,
		p.right_panel_default_width_px as i64,
		p.right_panel_max_viewport_ratio,
		p.right_panel_container_margin_px as i64,
		p.right_panel_overlay_breakpoint_px as i64,
		p.right_panel_overlay_scrim_blur_px as i64,
		p.terminal_drawer_min_height_px as i64,
		p.terminal_drawer_default_height_px as i64,
		p.terminal_drawer_max_viewport_ratio,
		p.tabs_height_px as i64,
		p.tabs_gap_px as i64,
		p.tabs_max_width_px as i64,
		p.tabs_close_hit_px as i64,
		p.tabs_pending_dot_px as i64,
		p.chrome_row_height_px as i64,
		p.chrome_resize_handle_hit_px as i64,
		p.chrome_resize_handle_line_px as i64,
		p.tree_indent_base_px as i64,
		p.tree_indent_step_px as i64,
		p.tree_row_height_px as i64,
		step_type_size(s, &p.tree_font_size),
		p.diff_row_height_px as i64,
		step_type_size(s, &p.diff_font_size),
		p.diff_gutter_width_px as i64
	);
	write_file(path, &out)
}

/// Writes surface/palette.toml.
pub fn dump_palette(tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let p = &tokens.surface.palette;
	let s = &tokens.scale;
	let out = format!(
		r#"[meta]
version = 1
name = "surface_palette"

[geometry]
width_px = {}
max_height_px = {}
radius = "{}"
elevation_level = {}

[input]
row_height_px = {}
inset = "{}"
search_icon_px = {}

[results]
row_height_px = {}
group_header_height_px = {}
footer_height_px = {}
key_hint_size = "{}"
"#,
		p.width_px as i64,
		p.max_height_px as i64,
		step_radius(s, p.radius),
		p.elevation_level,
		p.input_row_height_px as i64,
		step_spacing(s, p.input_inset),
		p.input_search_icon_px as i64,
		p.results_row_height_px as i64,
		p.results_group_header_height_px as i64,
		p.results_footer_height_px as i64,
		step_type_size(s, &p.results_key_hint_size)
	);
	write_file(path, &out)
}

/// Writes surface/settings.toml.
pub fn dump_settings(tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let set = &tokens.surface.settings;
	let s = &tokens.scale;
	let out = format!(
		r#"[meta]
version = 1
name = "surface_settings"

[layout]
row_height_px = {}
row_gap = "{}"
group_gap = "{}"
control_column_width_px = {}

[typography]
label_size = "{}"
description_size = "{}"
"#,
		set.row_height_px as i64,
		step_spacing(s, set.row_gap),
		step_spacing(s, set.group_gap),
		set.control_column_width_px as i64,
		step_type_size(s, &set.label_size),
		step_type_size(s, &set.description_size)
	);
	write_file(path, &out)
}

fn format_bp(out: &mut String, name: &str, c: &BreakpointConfig) {
	let _ = write!(
		out,
		"[breakpoint.{name}]\nmin_width_px = {}\nqueue_width_px = {}\nright_panel_mode = \"{}\"\nterminal_drawer_height_px = {}\ncomposer_footer_labels = {}\nrun_bar_labels = {}\n\n",
		c.min_width_px as i64,
		c.queue_width_px as i64,
		c.right_panel_mode,
		c.terminal_drawer_height_px as i64,
		c.composer_footer_labels,
		c.run_bar_labels
	);
}

/// Writes surface/breakpoints.toml.
pub fn dump_breakpoints(tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let bp = &tokens.surface.breakpoints;
	let mut out = String::from("[meta]\nversion = 1\nname = \"surface_breakpoints\"\n\n");
	format_bp(&mut out, "wide", &bp.wide);
	format_bp(&mut out, "standard", &bp.standard);
	format_bp(&mut out, "compact", &bp.compact);
	format_bp(&mut out, "collapsed", &bp.collapsed);
	write_file(path, &out)
}

/// Writes surface/shell.toml.
pub fn dump_shell(tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let sh = &tokens.surface.shell;
	let s = &tokens.scale;
	let out = format!(
		r#"[meta]
version = 1
name = "surface_shell"

[window]
min_width_px = {}
min_height_px = {}

[titlebar]
height_px = {}
control_px = {}
control_gap_px = "{}"
inset_left_px = "{}"
inset_right_px = "{}"

[grain]
tile_px = {}
opacity = {}
"#,
		sh.window_min_width_px as i64,
		sh.window_min_height_px as i64,
		sh.titlebar_height_px as i64,
		sh.titlebar_control_px as i64,
		step_spacing(s, sh.titlebar_control_gap_px),
		step_spacing(s, sh.titlebar_inset_left_px),
		step_spacing(s, sh.titlebar_inset_right_px),
		sh.grain_tile_px as i64,
		sh.grain_opacity
	);
	write_file(path, &out)
}
