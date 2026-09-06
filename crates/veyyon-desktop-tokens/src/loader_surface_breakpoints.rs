use std::path::Path;

use crate::{
	error::TokenError,
	loader::{find_key_line_col, parse_toml, read_file},
	section::Section,
	surface::{BreakpointConfig, BreakpointsSurfaceTokens, DrawerPlacement, RightPanelMode},
};

fn off_scale(row: &Section<'_>, key: &str, value: &str, allowed: &str) -> TokenError {
	let (line, column) = find_key_line_col(row.text(), row.name(), key);
	TokenError::OffScale {
		path: row.path().to_path_buf(),
		line,
		column,
		value: value.to_string(),
		scale_name: format!("{}.{key}", row.name()),
		allowed: allowed.to_string(),
	}
}

fn parse_bp(bp_tbl: &Section<'_>, name: &str) -> Result<BreakpointConfig, TokenError> {
	// A row is key-validated, and every value in it is required, before
	// anything is read out of it. A misspelled `queue_width_px` used to resolve
	// to 0 and collapse the queue rail at every width, silently.
	let row = bp_tbl.sub(name)?;
	row.only(&[
		"min_width_px",
		"queue_width_px",
		"right_panel_mode",
		"terminal_drawer_placement",
		"terminal_drawer_height_px",
		"composer_footer_labels",
		"run_bar_labels",
	])?;
	let raw_mode = row.string("right_panel_mode")?;
	let inline_px = raw_mode
		.strip_prefix("inline_")
		.and_then(|rest| rest.parse::<f32>().ok())
		.filter(|n| n.is_finite() && *n > 0.0);
	let right_panel_mode = if raw_mode == "overlay" {
		RightPanelMode::Overlay
	} else if let Some(width_px) = inline_px {
		RightPanelMode::Inline { width_px }
	} else {
		return Err(off_scale(&row, "right_panel_mode", raw_mode, "\"overlay\" or \"inline_<px>\""));
	};
	let raw_placement = row.string("terminal_drawer_placement")?;
	let terminal_drawer_placement = match raw_placement {
		"row" => DrawerPlacement::Row,
		"overlay" => DrawerPlacement::Overlay,
		_ => {
			return Err(off_scale(
				&row,
				"terminal_drawer_placement",
				raw_placement,
				"\"row\" or \"overlay\"",
			));
		},
	};

	Ok(BreakpointConfig {
		min_width_px: row.pixels("min_width_px")?,
		queue_width_px: row.pixels("queue_width_px")?,
		right_panel_mode,
		terminal_drawer_placement,
		terminal_drawer_height_px: row.pixels("terminal_drawer_height_px")?,
		composer_footer_labels: row.boolean("composer_footer_labels")?,
		run_bar_labels: row.boolean("run_bar_labels")?,
	})
}

/// Loads breakpoints surface configuration from `surface/breakpoints.toml`.
pub fn load_breakpoints(path: &Path) -> Result<BreakpointsSurfaceTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = Section::root(path, &text, &val)?;
	root.only(&["meta", "breakpoint"])?;
	root.meta("surface_breakpoints")?;

	let bp = root.sub("breakpoint")?;
	// A row name nobody reads is a row nobody applied: `[breakpoint.compakt]`
	// would leave `compact` missing while the file looks complete.
	bp.only(&["wide", "standard", "compact", "collapsed"])?;

	Ok(BreakpointsSurfaceTokens {
		wide:      parse_bp(&bp, "wide")?,
		standard:  parse_bp(&bp, "standard")?,
		compact:   parse_bp(&bp, "compact")?,
		collapsed: parse_bp(&bp, "collapsed")?,
	})
}
