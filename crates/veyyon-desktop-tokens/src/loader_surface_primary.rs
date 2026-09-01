use std::path::Path;

use toml::Value;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file, validate_table_keys},
	loader_surface::{
		resolve_radius_opt, resolve_spacing_opt, resolve_stroke_opt, resolve_type_size_opt,
	},
	schema::{RadiusStep, ScaleTokens, SpacingStep, StrokeStep, TypeSizeStep},
	surface::{
		AttachedCardsSurfaceTokens, ComposerSurfaceTokens, QueueSurfaceTokens,
		TranscriptSurfaceTokens,
	},
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
