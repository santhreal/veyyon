use std::path::Path;

use toml::Value;

use crate::{
	error::TokenError,
	loader::find_key_line_col,
	loader_surface_primary::{load_attached_cards, load_composer, load_queue, load_transcript},
	loader_surface_secondary::{load_breakpoints, load_palette, load_panels, load_settings},
	loader_surface_shell::load_shell,
	schema::{RadiusStep, ScaleTokens, SpacingStep, StrokeStep, TypeSize, TypeSizeStep},
	surface::SurfaceTokens,
};

/// Resolves a spacing token reference (e.g. "s4" -> 8.0).
pub fn resolve_spacing(
	path: &Path,
	text: &str,
	section: &str,
	key: &str,
	val: &Value,
	scale: &ScaleTokens,
) -> Result<f32, TokenError> {
	match val {
		Value::Integer(i) => {
			let (line, column) = find_key_line_col(text, section, key);
			Err(TokenError::NumericLiteralDisallowed {
				path: path.to_path_buf(),
				line,
				column,
				key: key.to_string(),
				literal: i.to_string(),
				example: "s7".to_string(),
			})
		},
		Value::Float(f) => {
			let (line, column) = find_key_line_col(text, section, key);
			Err(TokenError::NumericLiteralDisallowed {
				path: path.to_path_buf(),
				line,
				column,
				key: key.to_string(),
				literal: f.to_string(),
				example: "s7".to_string(),
			})
		},
		Value::String(s) => {
			if let Some(step) = SpacingStep::from_token(s) {
				Ok(scale.spacing(step))
			} else if s.starts_with('s') && s[1..].chars().all(|c| c.is_ascii_digit()) {
				let (line, column) = find_key_line_col(text, section, key);
				Err(TokenError::OffScale {
					path: path.to_path_buf(),
					line,
					column,
					value: s.clone(),
					scale_name: "spacing".to_string(),
					allowed: "s0..s13".to_string(),
				})
			} else {
				let (line, column) = find_key_line_col(text, section, key);
				Err(TokenError::UnresolvedReference {
					path: path.to_path_buf(),
					line,
					column,
					key: key.to_string(),
					reference: s.clone(),
					source_file: "scale.toml",
				})
			}
		},
		_ => {
			let (line, column) = find_key_line_col(text, section, key);
			Err(TokenError::UnresolvedReference {
				path: path.to_path_buf(),
				line,
				column,
				key: key.to_string(),
				reference: format!("{val:?}"),
				source_file: "scale.toml",
			})
		},
	}
}

/// Resolves a corner radius token reference (e.g. "xl" -> 14.0).
pub fn resolve_radius(
	path: &Path,
	text: &str,
	section: &str,
	key: &str,
	val: &Value,
	scale: &ScaleTokens,
) -> Result<f32, TokenError> {
	match val {
		Value::String(s) => {
			if let Some(step) = RadiusStep::from_token(s) {
				Ok(scale.radius(step))
			} else {
				let (line, column) = find_key_line_col(text, section, key);
				Err(TokenError::UnresolvedReference {
					path: path.to_path_buf(),
					line,
					column,
					key: key.to_string(),
					reference: s.clone(),
					source_file: "scale.toml",
				})
			}
		},
		Value::Integer(i) => {
			let (line, column) = find_key_line_col(text, section, key);
			Err(TokenError::NumericLiteralDisallowed {
				path: path.to_path_buf(),
				line,
				column,
				key: key.to_string(),
				literal: i.to_string(),
				example: "xl".to_string(),
			})
		},
		_ => {
			let (line, column) = find_key_line_col(text, section, key);
			Err(TokenError::UnresolvedReference {
				path: path.to_path_buf(),
				line,
				column,
				key: key.to_string(),
				reference: format!("{val:?}"),
				source_file: "scale.toml",
			})
		},
	}
}

/// Resolves a typographic size token reference.
pub fn resolve_type_size(
	path: &Path,
	text: &str,
	section: &str,
	key: &str,
	val: &Value,
	scale: &ScaleTokens,
) -> Result<TypeSize, TokenError> {
	let s = val.as_str().ok_or_else(|| {
		let (line, column) = find_key_line_col(text, section, key);
		TokenError::UnresolvedReference {
			path: path.to_path_buf(),
			line,
			column,
			key: key.to_string(),
			reference: format!("{val:?}"),
			source_file: "scale.toml",
		}
	})?;
	if let Some(step) = TypeSizeStep::from_token(s) {
		Ok(*scale.type_size(step))
	} else {
		let (line, column) = find_key_line_col(text, section, key);
		Err(TokenError::UnresolvedReference {
			path: path.to_path_buf(),
			line,
			column,
			key: key.to_string(),
			reference: s.to_string(),
			source_file: "scale.toml",
		})
	}
}

/// Resolves a stroke width reference.
pub fn resolve_stroke(
	path: &Path,
	text: &str,
	section: &str,
	key: &str,
	val: &Value,
	scale: &ScaleTokens,
) -> Result<f32, TokenError> {
	let s = val.as_str().ok_or_else(|| {
		let (line, column) = find_key_line_col(text, section, key);
		TokenError::UnresolvedReference {
			path: path.to_path_buf(),
			line,
			column,
			key: key.to_string(),
			reference: format!("{val:?}"),
			source_file: "scale.toml",
		}
	})?;
	if let Some(step) = StrokeStep::from_token(s) {
		Ok(scale.stroke(step))
	} else {
		let (line, column) = find_key_line_col(text, section, key);
		Err(TokenError::UnresolvedReference {
			path: path.to_path_buf(),
			line,
			column,
			key: key.to_string(),
			reference: s.to_string(),
			source_file: "scale.toml",
		})
	}
}

pub fn resolve_spacing_opt(
	path: &Path,
	text: &str,
	section: &str,
	key: &str,
	val: Option<&Value>,
	default_step: SpacingStep,
	scale: &ScaleTokens,
) -> Result<f32, TokenError> {
	match val {
		Some(v) => resolve_spacing(path, text, section, key, v, scale),
		None => Ok(scale.spacing(default_step)),
	}
}

pub fn resolve_radius_opt(
	path: &Path,
	text: &str,
	section: &str,
	key: &str,
	val: Option<&Value>,
	default_step: RadiusStep,
	scale: &ScaleTokens,
) -> Result<f32, TokenError> {
	match val {
		Some(v) => resolve_radius(path, text, section, key, v, scale),
		None => Ok(scale.radius(default_step)),
	}
}

pub fn resolve_stroke_opt(
	path: &Path,
	text: &str,
	section: &str,
	key: &str,
	val: Option<&Value>,
	default_step: StrokeStep,
	scale: &ScaleTokens,
) -> Result<f32, TokenError> {
	match val {
		Some(v) => resolve_stroke(path, text, section, key, v, scale),
		None => Ok(scale.stroke(default_step)),
	}
}

pub fn resolve_type_size_opt(
	path: &Path,
	text: &str,
	section: &str,
	key: &str,
	val: Option<&Value>,
	default_step: TypeSizeStep,
	scale: &ScaleTokens,
) -> Result<TypeSize, TokenError> {
	match val {
		Some(v) => resolve_type_size(path, text, section, key, v, scale),
		None => Ok(*scale.type_size(default_step)),
	}
}

/// Loads all 9 surface files from `dir/surface/*.toml`.
pub fn load_surfaces(dir: &Path, scale: &ScaleTokens) -> Result<SurfaceTokens, TokenError> {
	let surface_dir = dir.join("surface");
	Ok(SurfaceTokens {
		queue:          load_queue(&surface_dir.join("queue.toml"), scale)?,
		transcript:     load_transcript(&surface_dir.join("transcript.toml"), scale)?,
		composer:       load_composer(&surface_dir.join("composer.toml"), scale)?,
		attached_cards: load_attached_cards(&surface_dir.join("attached-cards.toml"), scale)?,
		panels:         load_panels(&surface_dir.join("panels.toml"), scale)?,
		palette:        load_palette(&surface_dir.join("palette.toml"), scale)?,
		settings:       load_settings(&surface_dir.join("settings.toml"), scale)?,
		breakpoints:    load_breakpoints(&surface_dir.join("breakpoints.toml"))?,
		shell:          load_shell(&surface_dir.join("shell.toml"), scale)?,
	})
}
