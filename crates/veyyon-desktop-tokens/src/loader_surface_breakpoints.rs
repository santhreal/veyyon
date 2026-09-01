use std::path::Path;

use toml::Value;

use crate::{
	error::TokenError,
	loader::{find_key_line_col, parse_toml, read_file, validate_table_keys},
	surface::{BreakpointConfig, BreakpointsSurfaceTokens, DrawerPlacement, RightPanelMode},
};

/// Reads a required pixel dimension out of a breakpoint row.
///
/// A row value that is absent, or present with the wrong TOML type, is an
/// error rather than a default: every value here has a plausible-looking
/// default, so a silent one ships a layout the token file never declared.
fn req_px(
	path: &Path,
	text: &str,
	section: &str,
	row: &toml::map::Map<String, Value>,
	key: &str,
) -> Result<f32, TokenError> {
	let Some(value) = row.get(key) else {
		return Err(TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: section.to_string(),
			key:     key.to_string(),
		});
	};
	match value.as_integer() {
		Some(n) if n >= 0 => Ok(n as f32),
		_ => {
			let (line, column) = find_key_line_col(text, section, key);
			Err(TokenError::OffScale {
				path: path.to_path_buf(),
				line,
				column,
				value: value.to_string(),
				scale_name: format!("{section}.{key}"),
				allowed: "a non-negative integer number of pixels".to_string(),
			})
		},
	}
}

/// Reads a required boolean out of a breakpoint row, for the same reason.
fn req_bool(
	path: &Path,
	text: &str,
	section: &str,
	row: &toml::map::Map<String, Value>,
	key: &str,
) -> Result<bool, TokenError> {
	let Some(value) = row.get(key) else {
		return Err(TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: section.to_string(),
			key:     key.to_string(),
		});
	};
	match value.as_bool() {
		Some(b) => Ok(b),
		None => {
			let (line, column) = find_key_line_col(text, section, key);
			Err(TokenError::OffScale {
				path: path.to_path_buf(),
				line,
				column,
				value: value.to_string(),
				scale_name: format!("{section}.{key}"),
				allowed: "true or false".to_string(),
			})
		},
	}
}

/// Reads a required string out of a breakpoint row, for the same reason.
fn req_str(
	path: &Path,
	text: &str,
	section: &str,
	row: &toml::map::Map<String, Value>,
	key: &str,
) -> Result<String, TokenError> {
	let Some(value) = row.get(key) else {
		return Err(TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: section.to_string(),
			key:     key.to_string(),
		});
	};
	match value.as_str() {
		Some(s) => Ok(s.to_string()),
		None => {
			let (line, column) = find_key_line_col(text, section, key);
			Err(TokenError::OffScale {
				path: path.to_path_buf(),
				line,
				column,
				value: value.to_string(),
				scale_name: format!("{section}.{key}"),
				allowed: "a string".to_string(),
			})
		},
	}
}

fn parse_bp(
	path: &Path,
	text: &str,
	bp_tbl: &toml::map::Map<String, Value>,
	name: &str,
) -> Result<BreakpointConfig, TokenError> {
	// A row is key-validated, and every value in it is required, before
	// anything is read out of it. A misspelled `queue_width_px` used to resolve
	// to 0 and collapse the queue rail at every width, silently.
	let row = bp_tbl
		.get(name)
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "breakpoint".to_string(),
			key:     name.to_string(),
		})?;
	let section = format!("breakpoint.{name}");
	validate_table_keys(path, text, &section, row, &[
		"min_width_px",
		"queue_width_px",
		"right_panel_mode",
		"terminal_drawer_placement",
		"terminal_drawer_height_px",
		"composer_footer_labels",
		"run_bar_labels",
	])?;
	let min_width_px = req_px(path, text, &section, row, "min_width_px")?;
	let queue_width_px = req_px(path, text, &section, row, "queue_width_px")?;
	let raw_mode = req_str(path, text, &section, row, "right_panel_mode")?;
	let inline_px = raw_mode
		.strip_prefix("inline_")
		.and_then(|rest| rest.parse::<f32>().ok())
		.filter(|n| n.is_finite() && *n > 0.0);
	let right_panel_mode = if raw_mode == "overlay" {
		RightPanelMode::Overlay
	} else if let Some(width_px) = inline_px {
		RightPanelMode::Inline { width_px }
	} else {
		let (line, column) = find_key_line_col(text, &section, "right_panel_mode");
		return Err(TokenError::OffScale {
			path: path.to_path_buf(),
			line,
			column,
			value: raw_mode,
			scale_name: format!("{section}.right_panel_mode"),
			allowed: "\"overlay\" or \"inline_<px>\"".to_string(),
		});
	};
	let raw_placement = req_str(path, text, &section, row, "terminal_drawer_placement")?;
	let terminal_drawer_placement = match raw_placement.as_str() {
		"row" => DrawerPlacement::Row,
		"overlay" => DrawerPlacement::Overlay,
		_ => {
			let (line, column) = find_key_line_col(text, &section, "terminal_drawer_placement");
			return Err(TokenError::OffScale {
				path: path.to_path_buf(),
				line,
				column,
				value: raw_placement,
				scale_name: format!("{section}.terminal_drawer_placement"),
				allowed: "\"row\" or \"overlay\"".to_string(),
			});
		},
	};
	let terminal_drawer_height_px = req_px(path, text, &section, row, "terminal_drawer_height_px")?;
	let composer_footer_labels = req_bool(path, text, &section, row, "composer_footer_labels")?;
	let run_bar_labels = req_bool(path, text, &section, row, "run_bar_labels")?;

	Ok(BreakpointConfig {
		min_width_px,
		queue_width_px,
		right_panel_mode,
		terminal_drawer_placement,
		terminal_drawer_height_px,
		composer_footer_labels,
		run_bar_labels,
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
	// A row name nobody reads is a row nobody applied: `[breakpoint.compakt]`
	// would leave `compact` missing while the file looks complete.
	validate_table_keys(path, &text, "breakpoint", bp, &[
		"wide",
		"standard",
		"compact",
		"collapsed",
	])?;

	Ok(BreakpointsSurfaceTokens {
		wide:      parse_bp(path, &text, bp, "wide")?,
		standard:  parse_bp(path, &text, bp, "standard")?,
		compact:   parse_bp(path, &text, bp, "compact")?,
		collapsed: parse_bp(path, &text, bp, "collapsed")?,
	})
}
