use std::path::Path;

use toml::Value;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file, validate_table_keys},
	loader_surface::{
		resolve_radius_opt, resolve_spacing_opt, resolve_stroke_opt, resolve_type_size_opt,
	},
	schema::{RadiusStep, ScaleTokens, SpacingStep, StrokeStep, TypeSizeStep},
	surface::ComposerSurfaceTokens,
};

/// Loads composer surface tokens from `surface/composer.toml`.
pub fn load_composer(
	path: &Path,
	scale: &ScaleTokens,
) -> Result<ComposerSurfaceTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = val.as_table().ok_or_else(|| TokenError::MissingKey {
		path:    path.to_path_buf(),
		section: "root".to_string(),
		key:     "geometry".to_string(),
	})?;
	validate_table_keys(path, &text, "root", root, &[
		"meta",
		"geometry",
		"material",
		"footer",
		"run_bar",
		"opening_line",
	])?;

	let geom = root
		.get("geometry")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "geometry".to_string(),
		})?;
	let max_width_px = geom
		.get("max_width_px")
		.and_then(Value::as_integer)
		.unwrap_or(768) as f32;
	let rest_height_px = geom
		.get("rest_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(70) as f32;
	let growth_cap_px = geom
		.get("growth_cap_px")
		.and_then(Value::as_integer)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "geometry".to_string(),
			key:     "growth_cap_px".to_string(),
		})? as f32;
	let radius_outer = resolve_radius_opt(
		path,
		&text,
		"geometry",
		"radius_outer",
		geom.get("radius_outer"),
		RadiusStep::Xxl,
		scale,
	)?;
	let radius_inner = resolve_radius_opt(
		path,
		&text,
		"geometry",
		"radius_inner",
		geom.get("radius_inner"),
		RadiusStep::Xl,
		scale,
	)?;
	let padding_top = resolve_spacing_opt(
		path,
		&text,
		"geometry",
		"padding_top",
		geom.get("padding_top"),
		SpacingStep::S7,
		scale,
	)?;
	let padding_bottom = resolve_spacing_opt(
		path,
		&text,
		"geometry",
		"padding_bottom",
		geom.get("padding_bottom"),
		SpacingStep::S6,
		scale,
	)?;
	let padding_horizontal = resolve_spacing_opt(
		path,
		&text,
		"geometry",
		"padding_horizontal",
		geom.get("padding_horizontal"),
		SpacingStep::S8,
		scale,
	)?;
	let hairline_stroke = resolve_stroke_opt(
		path,
		&text,
		"geometry",
		"hairline_stroke",
		geom.get("hairline_stroke"),
		StrokeStep::Hairline,
		scale,
	)?;

	let mat = root
		.get("material")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "material".to_string(),
		})?;
	let blur_px = mat.get("blur_px").and_then(Value::as_integer).unwrap_or(16) as f32;
	let saturation = mat
		.get("saturation")
		.and_then(Value::as_float)
		.unwrap_or(1.08) as f32;
	let ground_opacity = mat
		.get("ground_opacity")
		.and_then(Value::as_float)
		.unwrap_or(0.80) as f32;
	let shadow_x = mat.get("shadow_x").and_then(Value::as_integer).unwrap_or(0) as f32;
	let shadow_y = mat
		.get("shadow_y")
		.and_then(Value::as_integer)
		.unwrap_or(-8) as f32;
	let shadow_blur = mat
		.get("shadow_blur")
		.and_then(Value::as_integer)
		.unwrap_or(24) as f32;
	let shadow_spread = mat
		.get("shadow_spread")
		.and_then(Value::as_integer)
		.unwrap_or(-18) as f32;
	let shadow_opacity = mat
		.get("shadow_opacity")
		.and_then(Value::as_float)
		.unwrap_or(0.45) as f32;

	let footer = root
		.get("footer")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "footer".to_string(),
		})?;
	let footer_max_controls = footer
		.get("max_controls")
		.and_then(Value::as_integer)
		.unwrap_or(5) as usize;
	let footer_compact_threshold_px = footer
		.get("compact_threshold_px")
		.and_then(Value::as_integer)
		.unwrap_or(600) as f32;
	let footer_hysteresis_px = footer
		.get("hysteresis_px")
		.and_then(Value::as_integer)
		.unwrap_or(16) as f32;

	let run_bar = root
		.get("run_bar")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "run_bar".to_string(),
		})?;
	let run_bar_height_px = run_bar
		.get("height_px")
		.and_then(Value::as_integer)
		.unwrap_or(28) as f32;
	let run_bar_max_controls = run_bar
		.get("max_controls")
		.and_then(Value::as_integer)
		.unwrap_or(4) as usize;
	let run_bar_compact_threshold_px = run_bar
		.get("compact_threshold_px")
		.and_then(Value::as_integer)
		.unwrap_or(560) as f32;
	let run_bar_label_size = resolve_type_size_opt(
		path,
		&text,
		"run_bar",
		"label_size",
		run_bar.get("label_size"),
		TypeSizeStep::Small,
		scale,
	)?;

	let opening = root
		.get("opening_line")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "opening_line".to_string(),
		})?;
	let opening_line_max_width_px = opening
		.get("max_width_px")
		.and_then(Value::as_integer)
		.unwrap_or(768) as f32;
	let opening_line_type_size = resolve_type_size_opt(
		path,
		&text,
		"opening_line",
		"type_size",
		opening.get("type_size"),
		TypeSizeStep::Lead,
		scale,
	)?;
	let opening_line_weight = match opening
		.get("weight")
		.and_then(Value::as_str)
		.unwrap_or("regular")
	{
		"medium" => 500,
		"semibold" => 600,
		_ => 400,
	};

	Ok(ComposerSurfaceTokens {
		max_width_px,
		rest_height_px,
		growth_cap_px,
		radius_outer,
		radius_inner,
		padding_top,
		padding_bottom,
		padding_horizontal,
		hairline_stroke,
		blur_px,
		saturation,
		ground_opacity,
		shadow_x,
		shadow_y,
		shadow_blur,
		shadow_spread,
		shadow_opacity,
		footer_max_controls,
		footer_compact_threshold_px,
		footer_hysteresis_px,
		run_bar_height_px,
		run_bar_max_controls,
		run_bar_compact_threshold_px,
		run_bar_label_size,
		opening_line_max_width_px,
		opening_line_type_size,
		opening_line_weight,
	})
}
