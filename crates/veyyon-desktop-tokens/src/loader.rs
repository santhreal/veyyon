use std::{fs, path::Path};

use toml::Value;

use crate::{
	Tokens, error::TokenError, loader_ceilings::load_ceilings, loader_elevation::load_elevation,
	loader_motion::load_motion, loader_scale::load_scale, loader_surface::load_surfaces,
};

/// Helper to compute 1-based line and column from byte index or substring.
pub fn find_line_col(text: &str, target: &str) -> (usize, usize) {
	if let Some(pos) = text.find(target) {
		let prefix = &text[..pos];
		let line = prefix.matches('\n').count() + 1;
		let col = prefix.rfind('\n').map_or(pos + 1, |p| pos - p);
		(line, col)
	} else {
		(1, 1)
	}
}

/// Helper to compute 1-based line and column for a key inside a section.
pub fn find_key_line_col(text: &str, section: &str, key: &str) -> (usize, usize) {
	let section_header = format!("[{section}]");
	let start_pos = text.find(&section_header).unwrap_or(0);
	let sub = &text[start_pos..];
	if let Some(rel_pos) = sub.find(key) {
		let abs_pos = start_pos + rel_pos;
		let prefix = &text[..abs_pos];
		let line = prefix.matches('\n').count() + 1;
		let col = prefix.rfind('\n').map_or(abs_pos + 1, |p| abs_pos - p);
		(line, col)
	} else {
		find_line_col(text, key)
	}
}

/// Validates that a table has only expected keys.
pub fn validate_table_keys(
	path: &Path,
	text: &str,
	section: &str,
	table: &toml::map::Map<String, Value>,
	expected: &[&'static str],
) -> Result<(), TokenError> {
	for key in table.keys() {
		if !expected.contains(&key.as_str()) {
			let (line, column) = find_key_line_col(text, section, key);
			return Err(TokenError::UnknownKey {
				path: path.to_path_buf(),
				line,
				column,
				section: section.to_string(),
				key: key.clone(),
				expected: expected.to_vec(),
			});
		}
	}
	Ok(())
}

pub(crate) fn read_file(path: &Path) -> Result<String, TokenError> {
	fs::read_to_string(path).map_err(|e| TokenError::Io { path: path.to_path_buf(), source: e })
}

pub(crate) fn parse_toml(path: &Path, content: &str) -> Result<Value, TokenError> {
	toml::from_str::<Value>(content).map_err(|e| {
		let (line, column) = e.span().map_or((1, 1), |span| {
			let prefix = &content[..span.start.min(content.len())];
			let line = prefix.matches('\n').count() + 1;
			let col = prefix
				.rfind('\n')
				.map_or(prefix.len() + 1, |p| prefix.len() - p);
			(line, col)
		});
		TokenError::TomlParse {
			path: path.to_path_buf(),
			line,
			column,
			message: e.message().to_string(),
		}
	})
}

/// Loads and validates all 12 token files from the given root directory.
pub fn load_from_dir(dir: &Path) -> Result<Tokens, TokenError> {
	let scale_path = dir.join("scale.toml");
	let elevation_path = dir.join("elevation.toml");
	let ceilings_path = dir.join("ceilings.toml");
	let motion_path = dir.join("motion.toml");

	let scale = load_scale(&scale_path)?;
	let elevation = load_elevation(&elevation_path)?;
	let ceilings = load_ceilings(&ceilings_path)?;
	let motion = load_motion(&motion_path)?;

	let surface = load_surfaces(dir, &scale)?;

	Ok(Tokens { scale, elevation, ceilings, motion, surface })
}
