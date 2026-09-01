use std::path::Path;

use crate::{Tokens, dumper::write_file, error::TokenError};

/// Writes surface/queue.toml.
pub fn dump_queue(_tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let out = r#"[meta]
version = 1
name = "surface_queue"

[geometry.width]
default_px = 256
min_px = 208
max_viewport_delta_px = 640
floor_max_px = 208
collapsed_px = 0
outer_edge_stroke = "hairline"

[geometry.insets]
content_inset = "s4"
row_inset = "s5"

[geometry.row_heights]
card_px = 78
line_px = 36
section_header_px = 20

[geometry.card_layout]
padding_top = "s4"
padding_bottom = "s4"
padding_horizontal = "s5"
header_gap = "s1"
body_gap = "s2"
badge_height = 20
title_height = 20
subtitle_height = 16

[geometry.limits]
max_hover_actions = 2
parked_initial_page_size = 25
"#;
	write_file(path, out)
}

/// Writes surface/transcript.toml.
pub fn dump_transcript(_tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let out = r#"[meta]
version = 1
name = "surface_transcript"

[layout]
column_width_px = 768
user_turn_width_ratio = 0.80

[rhythm]
adjacent_same_kind_gap = "s0"
group_blocks_gap       = "s2"
turn_groups_gap        = "s4"
turns_gap              = "s8"

[user_turn]
ground = "inset"
padding = "s6"
radius_outer = "xl"
radius_trailing = "xs"
type_size = "read"

[assistant_turn]
type_size = "read"

[chrome.collapsed]
height_px = 24
event_line_height_px = 12

[chrome.caps]
invoke_mono_pane_max_height_px = 240
code_fence_max_height_px = 320
image_max_height_px = 400
plan_body_max_height_px = 400
plan_fade_height_px = 64
table_row_height_px = 18
"#;
	write_file(path, out)
}

/// Writes surface/composer.toml.
pub fn dump_composer(_tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let out = r#"[meta]
version = 1
name = "surface_composer"

[geometry]
max_width_px = 768
rest_height_px = 70
growth_cap_px = 200
radius_outer = "xxl"
radius_inner = "xl"
padding_top = "s7"
padding_bottom = "s6"
padding_horizontal = "s8"
hairline_stroke = "hairline"

[material]
blur_px = 16
saturation = 1.08
ground_opacity = 0.80
shadow_x = 0
shadow_y = -8
shadow_blur = 24
shadow_spread = -18
shadow_opacity = 0.45

[footer]
max_controls = 5
compact_threshold_px = 600
hysteresis_px = 16

[run_bar]
height_px = 28
max_controls = 4
compact_threshold_px = 560
label_size = "small"

[opening_line]
max_width_px = 768
type_size = "lead"
weight = "regular"
"#;
	write_file(path, out)
}

/// Writes surface/attached-cards.toml.
pub fn dump_attached_cards(_tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let out = r#"[meta]
version = 1
name = "surface_attached_cards"

[stack]
max_visible = 2
overflow_collapsed_height_px = 24

[approval]
padding = "s6"
tool_name_size = "body"
tool_name_weight = "medium"
detail_mono_pane_cap_px = 120

[question]
padding = "s6"
question_size = "read"
option_row_height_px = 28

[plan]
padding = "s8"
max_markdown_height_px = 400
fade_height_px = 64
"#;
	write_file(path, out)
}

/// Writes surface/panels.toml.
pub fn dump_panels(_tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let out = r#"[meta]
version = 1
name = "surface_panels"

[right_panel]
min_width_px = 360
default_width_px = 540
max_viewport_ratio = 0.70
container_margin_px = 360
overlay_breakpoint_px = 980
overlay_scrim_blur_px = 4

[terminal_drawer]
min_height_px = 180
default_height_px = 280
max_viewport_ratio = 0.75

[tabs]
height_px = 24
gap_px = 2
max_width_px = 160
close_hit_px = 16
pending_dot_px = 6

[chrome]
row_height_px = 28
resize_handle_hit_px = 8
resize_handle_line_px = 1

[tree]
indent_base_px = 8
indent_step_px = 14
row_height_px = 24
font_size = "micro"

[diff]
row_height_px = 18
font_size = "body"
gutter_width_px = 44
"#;
	write_file(path, out)
}

/// Writes surface/palette.toml.
pub fn dump_palette(_tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let out = r#"[meta]
version = 1
name = "surface_palette"

[geometry]
width_px = 576
max_height_px = 420
radius = "xxl"
elevation_level = 4

[input]
row_height_px = 40
inset = "s8"
search_icon_px = 16

[results]
row_height_px = 32
group_header_height_px = 20
footer_height_px = 32
key_hint_size = "micro"
"#;
	write_file(path, out)
}

/// Writes surface/settings.toml.
pub fn dump_settings(_tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let out = r#"[meta]
version = 1
name = "surface_settings"

[layout]
row_height_px = 44
row_gap = "s4"
group_gap = "s10"
control_column_width_px = 240

[typography]
label_size = "read"
description_size = "small"
"#;
	write_file(path, out)
}

/// Writes surface/breakpoints.toml.
pub fn dump_breakpoints(_tokens: &Tokens, path: &Path) -> Result<(), TokenError> {
	let out = r#"[meta]
version = 1
name = "surface_breakpoints"

[breakpoint.wide]
min_width_px = 1440
queue_width_px = 256
right_panel_mode = "inline_540"
terminal_drawer_height_px = 280
composer_footer_labels = true
run_bar_labels = true

[breakpoint.standard]
min_width_px = 1180
queue_width_px = 256
right_panel_mode = "inline_360"
terminal_drawer_height_px = 280
composer_footer_labels = true
run_bar_labels = true

[breakpoint.compact]
min_width_px = 980
queue_width_px = 208
right_panel_mode = "overlay"
terminal_drawer_height_px = 180
composer_footer_labels = false
run_bar_labels = false

[breakpoint.collapsed]
min_width_px = 800
queue_width_px = 0
right_panel_mode = "overlay"
terminal_drawer_height_px = 180
composer_footer_labels = false
run_bar_labels = false
"#;
	write_file(path, out)
}
