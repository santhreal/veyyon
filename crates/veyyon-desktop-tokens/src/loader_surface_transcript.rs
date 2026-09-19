use std::path::Path;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file},
	schema::ScaleTokens,
	section::Section,
	surface::TranscriptSurfaceTokens,
};

/// Loads transcript surface tokens from `surface/transcript.toml`.
pub fn load_transcript(
	path: &Path,
	scale: &ScaleTokens,
) -> Result<TranscriptSurfaceTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = Section::root(path, &text, &val)?;
	root.only(&[
		"meta",
		"layout",
		"rhythm",
		"user_turn",
		"assistant_turn",
		"chrome",
		"tool_view",
	])?;
	root.meta("surface_transcript")?;

	let layout = root.sub("layout")?;
	layout.only(&["column_width_px", "user_turn_width_ratio"])?;

	let rhythm = root.sub("rhythm")?;
	rhythm.only(&["adjacent_same_kind_gap", "group_blocks_gap", "turn_groups_gap", "turns_gap"])?;

	let user_turn = root.sub("user_turn")?;
	user_turn.only(&["ground", "padding", "radius_outer", "radius_trailing", "type_size"])?;

	let assistant_turn = root.sub("assistant_turn")?;
	assistant_turn.only(&["type_size"])?;

	let chrome = root.sub("chrome")?;
	chrome.only(&["collapsed", "caps"])?;
	let collapsed = chrome.sub("collapsed")?;
	collapsed.only(&["height_px", "event_line_height_px"])?;
	let caps = chrome.sub("caps")?;
	caps.only(&[
		"invoke_mono_pane_max_height_px",
		"code_fence_max_height_px",
		"image_max_height_px",
		"plan_body_max_height_px",
		"plan_fade_height_px",
		"table_row_height_px",
	])?;
	let tool_view = root.sub("tool_view")?;
	tool_view.only(&[
		"row_pad_y_px",
		"line_number_gutter_px",
		"notice_body_indent_px",
		"result_summary_max_width_px",
	])?;

	Ok(TranscriptSurfaceTokens {
		column_width_px: layout.number("column_width_px")?,
		user_turn_width_ratio: layout.ratio("user_turn_width_ratio")?,
		adjacent_same_kind_gap: rhythm.spacing("adjacent_same_kind_gap", scale)?,
		group_blocks_gap: rhythm.spacing("group_blocks_gap", scale)?,
		turn_groups_gap: rhythm.spacing("turn_groups_gap", scale)?,
		turns_gap: rhythm.spacing("turns_gap", scale)?,
		user_turn_ground: user_turn.string("ground")?.to_string(),
		user_turn_padding: user_turn.spacing("padding", scale)?,
		user_turn_radius_outer: user_turn.radius("radius_outer", scale)?,
		user_turn_radius_trailing: user_turn.radius("radius_trailing", scale)?,
		user_turn_type_size: user_turn.type_size("type_size", scale)?,
		assistant_turn_type_size: assistant_turn.type_size("type_size", scale)?,
		chrome_collapsed_height_px: collapsed.spacing("height_px", scale)?,
		chrome_event_line_height_px: collapsed.spacing("event_line_height_px", scale)?,
		chrome_invoke_mono_pane_max_height_px: caps.number("invoke_mono_pane_max_height_px")?,
		chrome_code_fence_max_height_px: caps.number("code_fence_max_height_px")?,
		chrome_image_max_height_px: caps.number("image_max_height_px")?,
		chrome_plan_body_max_height_px: caps.number("plan_body_max_height_px")?,
		chrome_plan_fade_height_px: caps.spacing("plan_fade_height_px", scale)?,
		chrome_table_row_height_px: caps.number("table_row_height_px")?,
		tool_view_row_pad_y_px: tool_view.number("row_pad_y_px")?,
		tool_view_line_number_gutter_px: tool_view.number("line_number_gutter_px")?,
		tool_view_notice_body_indent_px: tool_view.number("notice_body_indent_px")?,
		tool_view_result_summary_max_width_px: tool_view.number("result_summary_max_width_px")?,
	})
}
