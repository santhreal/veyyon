use std::path::Path;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file},
	schema::ScaleTokens,
	section::Section,
	surface::AttachedCardsSurfaceTokens,
};

/// Loads attached cards tokens from `surface/attached-cards.toml`.
pub fn load_attached_cards(
	path: &Path,
	scale: &ScaleTokens,
) -> Result<AttachedCardsSurfaceTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = Section::root(path, &text, &val)?;
	root.only(&["meta", "stack", "approval", "question", "plan"])?;
	root.meta("surface_attached_cards")?;

	let stack = root.sub("stack")?;
	stack.only(&["max_visible", "overflow_collapsed_height_px"])?;

	let approval = root.sub("approval")?;
	approval.only(&["padding", "tool_name_size", "tool_name_weight", "detail_mono_pane_cap_px"])?;

	let question = root.sub("question")?;
	question.only(&["padding", "question_size", "option_row_height_px"])?;

	let plan = root.sub("plan")?;
	plan.only(&["padding", "max_markdown_height_px", "fade_height_px"])?;

	Ok(AttachedCardsSurfaceTokens {
		stack_max_visible: stack.count("max_visible")?,
		stack_overflow_collapsed_height_px: stack.number("overflow_collapsed_height_px")?,
		approval_padding: approval.spacing("padding", scale)?,
		approval_tool_name_size: approval.type_size("tool_name_size", scale)?,
		approval_tool_name_weight: approval.weight("tool_name_weight", scale)?,
		approval_detail_mono_pane_cap_px: approval.number("detail_mono_pane_cap_px")?,
		question_padding: question.spacing("padding", scale)?,
		question_size: question.type_size("question_size", scale)?,
		question_option_row_height_px: question.number("option_row_height_px")?,
		plan_padding: plan.spacing("padding", scale)?,
		plan_max_markdown_height_px: plan.number("max_markdown_height_px")?,
		plan_fade_height_px: plan.number("fade_height_px")?,
	})
}
