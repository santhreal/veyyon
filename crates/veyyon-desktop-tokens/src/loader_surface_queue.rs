use std::path::Path;

use toml::Value;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file, validate_table_keys},
	loader_surface::{resolve_spacing_opt, resolve_stroke_opt},
	schema::{ScaleTokens, SpacingStep, StrokeStep},
	surface::QueueSurfaceTokens,
};

/// Loads queue surface tokens from `surface/queue.toml`.
pub fn load_queue(path: &Path, scale: &ScaleTokens) -> Result<QueueSurfaceTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = val.as_table().ok_or_else(|| TokenError::MissingKey {
		path:    path.to_path_buf(),
		section: "root".to_string(),
		key:     "geometry".to_string(),
	})?;
	validate_table_keys(path, &text, "root", root, &["meta", "geometry"])?;

	let geom = root
		.get("geometry")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "geometry".to_string(),
		})?;

	let width =
		geom
			.get("width")
			.and_then(Value::as_table)
			.ok_or_else(|| TokenError::MissingKey {
				path:    path.to_path_buf(),
				section: "geometry".to_string(),
				key:     "width".to_string(),
			})?;
	let width_default_px = width
		.get("default_px")
		.and_then(Value::as_integer)
		.unwrap_or(256) as f32;
	let width_min_px = width
		.get("min_px")
		.and_then(Value::as_integer)
		.unwrap_or(208) as f32;
	let width_max_viewport_delta_px = width
		.get("max_viewport_delta_px")
		.and_then(Value::as_integer)
		.unwrap_or(640) as f32;
	let width_floor_max_px = width
		.get("floor_max_px")
		.and_then(Value::as_integer)
		.unwrap_or(208) as f32;
	let width_collapsed_px = width
		.get("collapsed_px")
		.and_then(Value::as_integer)
		.unwrap_or(0) as f32;
	let outer_edge_stroke = resolve_stroke_opt(
		path,
		&text,
		"geometry.width",
		"outer_edge_stroke",
		width.get("outer_edge_stroke"),
		StrokeStep::Hairline,
		scale,
	)?;

	let insets = geom
		.get("insets")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "geometry".to_string(),
			key:     "insets".to_string(),
		})?;
	let content_inset = resolve_spacing_opt(
		path,
		&text,
		"geometry.insets",
		"content_inset",
		insets.get("content_inset"),
		SpacingStep::S4,
		scale,
	)?;
	let row_inset = resolve_spacing_opt(
		path,
		&text,
		"geometry.insets",
		"row_inset",
		insets.get("row_inset"),
		SpacingStep::S5,
		scale,
	)?;

	let row_h = geom
		.get("row_heights")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "geometry".to_string(),
			key:     "row_heights".to_string(),
		})?;
	let card_px = row_h
		.get("card_px")
		.and_then(Value::as_integer)
		.unwrap_or(78) as f32;
	let line_px = row_h
		.get("line_px")
		.and_then(Value::as_integer)
		.unwrap_or(36) as f32;
	let section_header_px = row_h
		.get("section_header_px")
		.and_then(Value::as_integer)
		.unwrap_or(20) as f32;

	let card_layout = geom
		.get("card_layout")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "geometry".to_string(),
			key:     "card_layout".to_string(),
		})?;
	let card_padding_top = resolve_spacing_opt(
		path,
		&text,
		"geometry.card_layout",
		"padding_top",
		card_layout.get("padding_top"),
		SpacingStep::S4,
		scale,
	)?;
	let card_padding_bottom = resolve_spacing_opt(
		path,
		&text,
		"geometry.card_layout",
		"padding_bottom",
		card_layout.get("padding_bottom"),
		SpacingStep::S4,
		scale,
	)?;
	let card_padding_horizontal = resolve_spacing_opt(
		path,
		&text,
		"geometry.card_layout",
		"padding_horizontal",
		card_layout.get("padding_horizontal"),
		SpacingStep::S5,
		scale,
	)?;
	let card_header_gap = resolve_spacing_opt(
		path,
		&text,
		"geometry.card_layout",
		"header_gap",
		card_layout.get("header_gap"),
		SpacingStep::S1,
		scale,
	)?;
	let card_body_gap = resolve_spacing_opt(
		path,
		&text,
		"geometry.card_layout",
		"body_gap",
		card_layout.get("body_gap"),
		SpacingStep::S2,
		scale,
	)?;
	let card_badge_height = card_layout
		.get("badge_height")
		.and_then(Value::as_integer)
		.unwrap_or(20) as f32;
	let card_title_height = card_layout
		.get("title_height")
		.and_then(Value::as_integer)
		.unwrap_or(20) as f32;
	let card_subtitle_height = card_layout
		.get("subtitle_height")
		.and_then(Value::as_integer)
		.unwrap_or(16) as f32;

	let limits = geom
		.get("limits")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "geometry".to_string(),
			key:     "limits".to_string(),
		})?;
	let max_hover_actions = limits
		.get("max_hover_actions")
		.and_then(Value::as_integer)
		.unwrap_or(2) as usize;
	let parked_initial_page_size = limits
		.get("parked_initial_page_size")
		.and_then(Value::as_integer)
		.unwrap_or(25) as usize;

	Ok(QueueSurfaceTokens {
		width_default_px,
		width_min_px,
		width_max_viewport_delta_px,
		width_floor_max_px,
		width_collapsed_px,
		outer_edge_stroke,
		content_inset,
		row_inset,
		card_px,
		line_px,
		section_header_px,
		card_padding_top,
		card_padding_bottom,
		card_padding_horizontal,
		card_header_gap,
		card_body_gap,
		card_badge_height,
		card_title_height,
		card_subtitle_height,
		max_hover_actions,
		parked_initial_page_size,
	})
}
