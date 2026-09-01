use std::path::Path;

use toml::Value;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file, validate_table_keys},
	loader_surface::{resolve_spacing_opt, resolve_type_size_opt},
	schema::{ScaleTokens, SpacingStep, TypeSizeStep},
	surface::AttachedCardsSurfaceTokens,
};

/// Loads attached cards tokens from `surface/attached-cards.toml`.
pub fn load_attached_cards(
	path: &Path,
	scale: &ScaleTokens,
) -> Result<AttachedCardsSurfaceTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = val.as_table().ok_or_else(|| TokenError::MissingKey {
		path:    path.to_path_buf(),
		section: "root".to_string(),
		key:     "stack".to_string(),
	})?;
	validate_table_keys(path, &text, "root", root, &[
		"meta", "stack", "approval", "question", "plan",
	])?;

	let stack =
		root
			.get("stack")
			.and_then(Value::as_table)
			.ok_or_else(|| TokenError::MissingKey {
				path:    path.to_path_buf(),
				section: "root".to_string(),
				key:     "stack".to_string(),
			})?;
	let stack_max_visible = stack
		.get("max_visible")
		.and_then(Value::as_integer)
		.unwrap_or(2) as usize;
	let stack_overflow_collapsed_height_px = stack
		.get("overflow_collapsed_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(24) as f32;

	let approval = root
		.get("approval")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "approval".to_string(),
		})?;
	let approval_padding = resolve_spacing_opt(
		path,
		&text,
		"approval",
		"padding",
		approval.get("padding"),
		SpacingStep::S6,
		scale,
	)?;
	let approval_tool_name_size = resolve_type_size_opt(
		path,
		&text,
		"approval",
		"tool_name_size",
		approval.get("tool_name_size"),
		TypeSizeStep::Body,
		scale,
	)?;
	let approval_tool_name_weight = match approval
		.get("tool_name_weight")
		.and_then(Value::as_str)
		.unwrap_or("medium")
	{
		"semibold" => 600,
		"regular" => 400,
		_ => 500,
	};
	let approval_detail_mono_pane_cap_px = approval
		.get("detail_mono_pane_cap_px")
		.and_then(Value::as_integer)
		.unwrap_or(120) as f32;

	let question = root
		.get("question")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "question".to_string(),
		})?;
	let question_padding = resolve_spacing_opt(
		path,
		&text,
		"question",
		"padding",
		question.get("padding"),
		SpacingStep::S6,
		scale,
	)?;
	let question_size = resolve_type_size_opt(
		path,
		&text,
		"question",
		"question_size",
		question.get("question_size"),
		TypeSizeStep::Read,
		scale,
	)?;
	let question_option_row_height_px = question
		.get("option_row_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(28) as f32;

	let plan = root
		.get("plan")
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "root".to_string(),
			key:     "plan".to_string(),
		})?;
	let plan_padding = resolve_spacing_opt(
		path,
		&text,
		"plan",
		"padding",
		plan.get("padding"),
		SpacingStep::S8,
		scale,
	)?;
	let plan_max_markdown_height_px = plan
		.get("max_markdown_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(400) as f32;
	let plan_fade_height_px = plan
		.get("fade_height_px")
		.and_then(Value::as_integer)
		.unwrap_or(64) as f32;

	Ok(AttachedCardsSurfaceTokens {
		stack_max_visible,
		stack_overflow_collapsed_height_px,
		approval_padding,
		approval_tool_name_size,
		approval_tool_name_weight,
		approval_detail_mono_pane_cap_px,
		question_padding,
		question_size,
		question_option_row_height_px,
		plan_padding,
		plan_max_markdown_height_px,
		plan_fade_height_px,
	})
}
