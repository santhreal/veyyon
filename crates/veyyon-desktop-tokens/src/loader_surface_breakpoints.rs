use std::path::Path;

use toml::Value;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file, validate_table_keys},
	surface::{BreakpointConfig, BreakpointsSurfaceTokens},
};

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
