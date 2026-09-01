use serde::{Deserialize, Serialize};

use crate::schema::TypeSize;

/// Resolved queue surface geometry tokens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueueSurfaceTokens {
	pub width_default_px:            f32,
	pub width_min_px:                f32,
	pub width_max_viewport_delta_px: f32,
	pub width_floor_max_px:          f32,
	pub width_collapsed_px:          f32,
	pub outer_edge_stroke:           f32,
	pub content_inset:               f32,
	pub row_inset:                   f32,
	pub card_px:                     f32,
	pub line_px:                     f32,
	pub section_header_px:           f32,
	pub card_padding_top:            f32,
	pub card_padding_bottom:         f32,
	pub card_padding_horizontal:     f32,
	pub card_header_gap:             f32,
	pub card_body_gap:               f32,
	pub card_badge_height:           f32,
	pub card_title_height:           f32,
	pub card_subtitle_height:        f32,
	pub max_hover_actions:           usize,
	pub parked_initial_page_size:    usize,
}

/// Resolved transcript surface geometry tokens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranscriptSurfaceTokens {
	pub column_width_px: f32,
	pub user_turn_width_ratio: f32,
	pub adjacent_same_kind_gap: f32,
	pub group_blocks_gap: f32,
	pub turn_groups_gap: f32,
	pub turns_gap: f32,
	pub user_turn_ground: String,
	pub user_turn_padding: f32,
	pub user_turn_radius_outer: f32,
	pub user_turn_radius_trailing: f32,
	pub user_turn_type_size: TypeSize,
	pub assistant_turn_type_size: TypeSize,
	pub chrome_collapsed_height_px: f32,
	pub chrome_event_line_height_px: f32,
	pub chrome_invoke_mono_pane_max_height_px: f32,
	pub chrome_code_fence_max_height_px: f32,
	pub chrome_image_max_height_px: f32,
	pub chrome_plan_body_max_height_px: f32,
	pub chrome_plan_fade_height_px: f32,
	pub chrome_table_row_height_px: f32,
}

/// Resolved composer surface geometry and glass material tokens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComposerSurfaceTokens {
	pub max_width_px: f32,
	pub rest_height_px: f32,
	pub growth_cap_px: f32,
	pub radius_outer: f32,
	pub radius_inner: f32,
	pub padding_top: f32,
	pub padding_bottom: f32,
	pub padding_horizontal: f32,
	pub hairline_stroke: f32,
	pub blur_px: f32,
	pub saturation: f32,
	pub ground_opacity: f32,
	pub shadow_x: f32,
	pub shadow_y: f32,
	pub shadow_blur: f32,
	pub shadow_spread: f32,
	pub shadow_opacity: f32,
	pub footer_max_controls: usize,
	pub footer_compact_threshold_px: f32,
	pub footer_hysteresis_px: f32,
	pub run_bar_height_px: f32,
	pub run_bar_max_controls: usize,
	pub run_bar_compact_threshold_px: f32,
	pub run_bar_label_size: TypeSize,
	pub opening_line_max_width_px: f32,
	pub opening_line_type_size: TypeSize,
	pub opening_line_weight: u16,
}

/// Resolved attached cards (approval, question, plan) geometry tokens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttachedCardsSurfaceTokens {
	pub stack_max_visible: usize,
	pub stack_overflow_collapsed_height_px: f32,
	pub approval_padding: f32,
	pub approval_tool_name_size: TypeSize,
	pub approval_tool_name_weight: u16,
	pub approval_detail_mono_pane_cap_px: f32,
	pub question_padding: f32,
	pub question_size: TypeSize,
	pub question_option_row_height_px: f32,
	pub plan_padding: f32,
	pub plan_max_markdown_height_px: f32,
	pub plan_fade_height_px: f32,
}

/// Resolved right panel and terminal drawer geometry tokens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PanelsSurfaceTokens {
	pub right_panel_min_width_px: f32,
	pub right_panel_default_width_px: f32,
	pub right_panel_max_viewport_ratio: f32,
	pub right_panel_container_margin_px: f32,
	pub right_panel_overlay_breakpoint_px: f32,
	pub right_panel_overlay_scrim_blur_px: f32,
	pub terminal_drawer_min_height_px: f32,
	pub terminal_drawer_default_height_px: f32,
	pub terminal_drawer_max_viewport_ratio: f32,
	pub tabs_height_px: f32,
	pub tabs_gap_px: f32,
	pub tabs_max_width_px: f32,
	pub tabs_close_hit_px: f32,
	pub tabs_pending_dot_px: f32,
	pub chrome_row_height_px: f32,
	pub chrome_resize_handle_hit_px: f32,
	pub chrome_resize_handle_line_px: f32,
	pub tree_indent_base_px: f32,
	pub tree_indent_step_px: f32,
	pub tree_row_height_px: f32,
	pub tree_font_size: TypeSize,
	pub diff_row_height_px: f32,
	pub diff_font_size: TypeSize,
	pub diff_gutter_width_px: f32,
}

/// Resolved command palette surface geometry tokens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PaletteSurfaceTokens {
	pub width_px: f32,
	pub max_height_px: f32,
	pub radius: f32,
	pub elevation_level: u8,
	pub input_row_height_px: f32,
	pub input_inset: f32,
	pub input_search_icon_px: f32,
	pub results_row_height_px: f32,
	pub results_group_header_height_px: f32,
	pub results_footer_height_px: f32,
	pub results_key_hint_size: TypeSize,
}

/// Resolved settings and diagnostics layout tokens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SettingsSurfaceTokens {
	pub row_height_px:           f32,
	pub row_gap:                 f32,
	pub group_gap:               f32,
	pub control_column_width_px: f32,
	pub label_size:              TypeSize,
	pub description_size:        TypeSize,
}

/// Viewport layout state and thresholds for a single breakpoint.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BreakpointConfig {
	pub min_width_px:              f32,
	pub queue_width_px:            f32,
	pub right_panel_mode:          String,
	pub terminal_drawer_height_px: f32,
	pub composer_footer_labels:    bool,
	pub run_bar_labels:            bool,
}

/// Resolved breakpoint responsive configuration set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BreakpointsSurfaceTokens {
	pub wide:      BreakpointConfig,
	pub standard:  BreakpointConfig,
	pub compact:   BreakpointConfig,
	pub collapsed: BreakpointConfig,
}

/// Window and titlebar geometry (§4.1).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ShellSurfaceTokens {
	pub window_min_width_px:     f32,
	pub window_min_height_px:    f32,
	pub titlebar_height_px:      f32,
	pub titlebar_control_px:     f32,
	pub titlebar_control_gap_px: f32,
	pub titlebar_inset_left_px:  f32,
	pub titlebar_inset_right_px: f32,
	pub grain_tile_px:           f32,
	pub grain_opacity:           f32,
}

/// All surface geometry token groups combined.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SurfaceTokens {
	pub queue:          QueueSurfaceTokens,
	pub transcript:     TranscriptSurfaceTokens,
	pub composer:       ComposerSurfaceTokens,
	pub attached_cards: AttachedCardsSurfaceTokens,
	pub panels:         PanelsSurfaceTokens,
	pub palette:        PaletteSurfaceTokens,
	pub settings:       SettingsSurfaceTokens,
	pub breakpoints:    BreakpointsSurfaceTokens,
	pub shell:          ShellSurfaceTokens,
}
