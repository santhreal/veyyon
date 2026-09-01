use std::path::Path;

use toml::Value;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file, validate_table_keys},
	loader_surface::{resolve_radius_opt, resolve_spacing_opt, resolve_type_size_opt},
	schema::{RadiusStep, ScaleTokens, SpacingStep, TypeSizeStep},
	surface::TranscriptSurfaceTokens,
};

/// Loads transcript surface tokens from `surface/transcript.toml`.
pub fn load_transcript(
	path: &Path,
	scale: &ScaleTokens,
) -> Result<TranscriptSurfaceTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = val.as_table().ok_or_else(|| TokenError::MissingKey {
		path:    path.to_path_buf(),
		section: "root".to_string(),
		key:     "layout".to_string(),
	})?;
	validate_table_keys(path, &text, "root", root, &[
		"meta",
		"layout",
		"rhythm",
		"user_turn",
		"assistant_turn",
		"chrome",
	])?;

	let layout = root
		.get("layout")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "layout".to_string(),
		})?;
	let column_width_px = layout
		.get("column_width_px")
		.and_then(Value::as_integer)
		.unwrap_or(768) as f32;
	let user_turn_width_ratio = layout
		.get("user_turn_width_ratio")
		.and_then(Value::as_float)
		.unwrap_or(0.80) as f32;

	let rhythm = root
		.get("rhythm")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "rhythm".to_string(),
		})?;
	let adjacent_same_kind_gap = resolve_spacing_opt(
		path,
		&text,
		"rhythm",
		"adjacent_same_kind_gap",
		rhythm.get("adjacent_same_kind_gap"),
		SpacingStep::S0,
		scale,
	)?;
	let group_blocks_gap = resolve_spacing_opt(
		path,
		&text,
		"rhythm",
		"group_blocks_gap",
		rhythm.get("group_blocks_gap"),
		SpacingStep::S2,
		scale,
	)?;
	let turn_groups_gap = resolve_spacing_opt(
		path,
		&text,
		"rhythm",
		"turn_groups_gap",
		rhythm.get("turn_groups_gap"),
		SpacingStep::S4,
		scale,
	)?;
	let turns_gap = resolve_spacing_opt(
		path,
		&text,
		"rhythm",
		"turns_gap",
		rhythm.get("turns_gap"),
		SpacingStep::S8,
		scale,
	)?;

	let user_turn = root
		.get("user_turn")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "user_turn".to_string(),
		})?;
	let user_turn_ground = user_turn
		.get("ground")
		.and_then(Value::as_str)
		.unwrap_or("inset")
		.to_string();
	let user_turn_padding = resolve_spacing_opt(
		path,
		&text,
		"user_turn",
		"padding",
		user_turn.get("padding"),
		SpacingStep::S6,
		scale,
	)?;
	let user_turn_radius_outer = resolve_radius_opt(
		path,
		&text,
		"user_turn",
		"radius_outer",
		user_turn.get("radius_outer"),
		RadiusStep::Xl,
		scale,
	)?;
	let user_turn_radius_trailing = resolve_radius_opt(
		path,
		&text,
		"user_turn",
		"radius_trailing",
		user_turn.get("radius_trailing"),
		RadiusStep::Xs,
		scale,
	)?;
	let user_turn_type_size = resolve_type_size_opt(
		path,
		&text,
		"user_turn",
		"type_size",
		user_turn.get("type_size"),
		TypeSizeStep::Read,
		scale,
	)?;

	let assistant_turn = root
		.get("assistant_turn")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "assistant_turn".to_string(),
		})?;
	let assistant_turn_type_size = resolve_type_size_opt(
		path,
		&text,
		"assistant_turn",
		"type_size",
		assistant_turn.get("type_size"),
		TypeSizeStep::Read,
		scale,
	)?;

	let chrome = root
		.get("chrome")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "chrome".to_string(),
		})?;
	let collapsed = chrome
		.get("collapsed")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "chrome".to_string(),
			key:     "collapsed".to_string(),
		})?;
	let chrome_collapsed_height_px = collapsed
		.get("height_px")
		.and_then(Value::as_integer)
		.unwrap_or(24) as f32;
	let chrome_event_line_height_px = collapsed
		.get("event_line_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(12) as f32;

	let caps = chrome
		.get("caps")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "chrome".to_string(),
			key:     "caps".to_string(),
		})?;
	let chrome_invoke_mono_pane_max_height_px = caps
		.get("invoke_mono_pane_max_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(240) as f32;
	let chrome_code_fence_max_height_px = caps
		.get("code_fence_max_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(320) as f32;
	let chrome_image_max_height_px = caps
		.get("image_max_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(400) as f32;
	let chrome_plan_body_max_height_px = caps
		.get("plan_body_max_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(400) as f32;
	let chrome_plan_fade_height_px = caps
		.get("plan_fade_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(64) as f32;
	let chrome_table_row_height_px = caps
		.get("table_row_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(18) as f32;

	Ok(TranscriptSurfaceTokens {
		column_width_px,
		user_turn_width_ratio,
		adjacent_same_kind_gap,
		group_blocks_gap,
		turn_groups_gap,
		turns_gap,
		user_turn_ground,
		user_turn_padding,
		user_turn_radius_outer,
		user_turn_radius_trailing,
		user_turn_type_size,
		assistant_turn_type_size,
		chrome_collapsed_height_px,
		chrome_event_line_height_px,
		chrome_invoke_mono_pane_max_height_px,
		chrome_code_fence_max_height_px,
		chrome_image_max_height_px,
		chrome_plan_body_max_height_px,
		chrome_plan_fade_height_px,
		chrome_table_row_height_px,
	})
}
