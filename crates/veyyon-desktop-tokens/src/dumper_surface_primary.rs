use std::path::Path;

use crate::{
	Tokens,
	dumper::write_file,
	dumper_surface_helpers::{step_radius, step_spacing, step_stroke, step_type_size, weight_str},
	error::TokenError,
};

/// Writes surface/queue.toml.
pub fn dump_queue(tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let q = &tokens.surface.queue;
	let s = &tokens.scale;
	let out = format!(
		r#"[meta]
version = 1
name = "surface_queue"

[geometry.width]
default_px = {}
min_px = {}
max_viewport_delta_px = {}
floor_max_px = {}
collapsed_px = {}
outer_edge_stroke = "{}"

[geometry.insets]
content_inset = "{}"
row_inset = "{}"

[geometry.row_heights]
card_px = {}
line_px = {}
section_header_px = {}

[geometry.card_layout]
padding_top = "{}"
padding_bottom = "{}"
padding_horizontal = "{}"
header_gap = "{}"
body_gap = "{}"
badge_height_px = {}
title_height_px = {}
subtitle_height_px = {}

[geometry.section_layout]
gap_above = "{}"
gap_below = "{}"

[geometry.footer]
height_px = {}
inset = "{}"
gear_size_px = {}

[geometry.limits]
max_hover_actions = {}
parked_initial_page_size = {}
"#,
		q.width_default_px as i64,
		q.width_min_px as i64,
		q.width_max_viewport_delta_px as i64,
		q.width_floor_max_px as i64,
		q.width_collapsed_px as i64,
		step_stroke(s, q.outer_edge_stroke),
		step_spacing(s, q.content_inset),
		step_spacing(s, q.row_inset),
		q.card_px as i64,
		q.line_px as i64,
		q.section_header_px as i64,
		step_spacing(s, q.card_padding_top),
		step_spacing(s, q.card_padding_bottom),
		step_spacing(s, q.card_padding_horizontal),
		step_spacing(s, q.card_header_gap),
		step_spacing(s, q.card_body_gap),
		q.card_badge_height as i64,
		q.card_title_height as i64,
		q.card_subtitle_height as i64,
		step_spacing(s, q.section_gap_above),
		step_spacing(s, q.section_gap_below),
		q.footer_height_px as i64,
		step_spacing(s, q.footer_inset),
		q.gear_size_px as i64,
		q.max_hover_actions,
		q.parked_initial_page_size
	);
	write_file(path, &out)
}

/// Writes surface/transcript.toml.
pub fn dump_transcript(tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let t = &tokens.surface.transcript;
	let s = &tokens.scale;
	let out = format!(
		r#"[meta]
version = 1
name = "surface_transcript"

[layout]
column_width_px = {}
user_turn_width_ratio = {:.2}

[rhythm]
adjacent_same_kind_gap = "{}"
group_blocks_gap       = "{}"
turn_groups_gap        = "{}"
turns_gap              = "{}"

[user_turn]
ground = "{}"
padding = "{}"
radius_outer = "{}"
radius_trailing = "{}"
type_size = "{}"

[assistant_turn]
type_size = "{}"

[chrome.collapsed]
height_px = {}
event_line_height_px = {}

[chrome.caps]
invoke_mono_pane_max_height_px = {}
code_fence_max_height_px = {}
image_max_height_px = {}
plan_body_max_height_px = {}
plan_fade_height_px = {}
table_row_height_px = {}
"#,
		t.column_width_px as i64,
		t.user_turn_width_ratio,
		step_spacing(s, t.adjacent_same_kind_gap),
		step_spacing(s, t.group_blocks_gap),
		step_spacing(s, t.turn_groups_gap),
		step_spacing(s, t.turns_gap),
		t.user_turn_ground,
		step_spacing(s, t.user_turn_padding),
		step_radius(s, t.user_turn_radius_outer),
		step_radius(s, t.user_turn_radius_trailing),
		step_type_size(s, &t.user_turn_type_size),
		step_type_size(s, &t.assistant_turn_type_size),
		t.chrome_collapsed_height_px as i64,
		t.chrome_event_line_height_px as i64,
		t.chrome_invoke_mono_pane_max_height_px as i64,
		t.chrome_code_fence_max_height_px as i64,
		t.chrome_image_max_height_px as i64,
		t.chrome_plan_body_max_height_px as i64,
		t.chrome_plan_fade_height_px as i64,
		t.chrome_table_row_height_px as i64
	);
	write_file(path, &out)
}

/// Writes surface/composer.toml.
pub fn dump_composer(tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let c = &tokens.surface.composer;
	let s = &tokens.scale;
	let out = format!(
		r#"[meta]
version = 1
name = "surface_composer"

[geometry]
max_width_px = {}
rest_height_px = {}
growth_cap_px = {}
radius_outer = "{}"
radius_inner = "{}"
padding_top = "{}"
padding_bottom = "{}"
padding_horizontal = "{}"
hairline_stroke = "{}"

[material]
blur_px = {}
saturation = {:.2}
ground_opacity = {:.2}
shadow_x = {}
shadow_y = {}
shadow_blur = {}
shadow_spread = {}
shadow_opacity = {:.2}

[footer]
max_controls = {}
compact_threshold_px = {}
hysteresis_px = {}

[run_bar]
height_px = {}
max_controls = {}
compact_threshold_px = {}
label_size = "{}"

[opening_line]
max_width_px = {}
type_size = "{}"
weight = "{}"

[attachments]
card_height_px = {}
card_max_width_px = {}
card_radius = "{}"
"#,
		c.max_width_px as i64,
		c.rest_height_px as i64,
		c.growth_cap_px as i64,
		step_radius(s, c.radius_outer),
		step_radius(s, c.radius_inner),
		step_spacing(s, c.padding_top),
		step_spacing(s, c.padding_bottom),
		step_spacing(s, c.padding_horizontal),
		step_stroke(s, c.hairline_stroke),
		c.blur_px as i64,
		c.saturation,
		c.ground_opacity,
		c.shadow_x as i64,
		c.shadow_y as i64,
		c.shadow_blur as i64,
		c.shadow_spread as i64,
		c.shadow_opacity,
		c.footer_max_controls,
		c.footer_compact_threshold_px as i64,
		c.footer_hysteresis_px as i64,
		c.run_bar_height_px as i64,
		c.run_bar_max_controls,
		c.run_bar_compact_threshold_px as i64,
		step_type_size(s, &c.run_bar_label_size),
		c.opening_line_max_width_px as i64,
		step_type_size(s, &c.opening_line_type_size),
		weight_str(c.opening_line_weight),
		c.attachment_card_height_px as i64,
		c.attachment_card_max_width_px as i64,
		step_radius(s, c.attachment_card_radius)
	);
	write_file(path, &out)
}

/// Writes surface/attached-cards.toml.
pub fn dump_attached_cards(tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let a = &tokens.surface.attached_cards;
	let s = &tokens.scale;
	let out = format!(
		r#"[meta]
version = 1
name = "surface_attached_cards"

[stack]
max_visible = {}
overflow_collapsed_height_px = {}

[approval]
padding = "{}"
tool_name_size = "{}"
tool_name_weight = "{}"
detail_mono_pane_cap_px = {}

[question]
padding = "{}"
question_size = "{}"
option_row_height_px = {}

[plan]
padding = "{}"
max_markdown_height_px = {}
fade_height_px = {}
"#,
		a.stack_max_visible,
		a.stack_overflow_collapsed_height_px as i64,
		step_spacing(s, a.approval_padding),
		step_type_size(s, &a.approval_tool_name_size),
		weight_str(a.approval_tool_name_weight),
		a.approval_detail_mono_pane_cap_px as i64,
		step_spacing(s, a.question_padding),
		step_type_size(s, &a.question_size),
		a.question_option_row_height_px as i64,
		step_spacing(s, a.plan_padding),
		a.plan_max_markdown_height_px as i64,
		a.plan_fade_height_px as i64
	);
	write_file(path, &out)
}
