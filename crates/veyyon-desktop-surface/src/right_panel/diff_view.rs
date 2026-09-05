//! Diff surface view (§5.11).
//!
//! Renders multi-file diffs in unified or side-by-side split modes with
//! pinned gutters, intraline highlights, and mode switching.

use veyyon_desktop_kit::{
	ColorRole, Divider, RadiusStep, SpacingStep, StrokeStep, TextRamp, TextWeight, TintRole,
	TokenSet,
};
use veyyon_desktop_model::DiffMode;
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	Context, Div, ElementId, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div, px,
};

use crate::{
	ShellView,
	intent::Intent,
	right_panel::{
		content::{DiffFile, DiffRow},
		diff_rows::{gutter_cell, render_hunk_header, render_unified_row, sign_cell},
	},
};

/// Renders the diff tenant for the right panel.
pub fn diff_view(
	files: &[DiffFile],
	diff_mode: DiffMode,
	panel_width: f32,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	if files.is_empty() {
		return div()
			.id("right-panel-diff-empty")
			.flex_1()
			.w_full()
			.flex()
			.items_center()
			.justify_center()
			.text_size(tokens.font_size(TextRamp::Small))
			.text_color(tokens.color(ColorRole::Muted))
			.child("No uncommitted changes");
	}

	// Split mode above 900px by default unless explicitly chosen
	let effective_mode = if panel_width >= 900.0 && diff_mode == DiffMode::Unified {
		DiffMode::Split
	} else {
		diff_mode
	};

	let mut container = div()
		.id("right-panel-diff-view")
		.flex_1()
		.w_full()
		.flex()
		.flex_col()
		.overflow_y_scroll();
	for (file_idx, file) in files.iter().enumerate() {
		// A hairline closes each file above the next one's header, so the last
		// row of one file is not read as the first of the next.
		if file_idx > 0 {
			container = container.child(Divider::horizontal());
		}
		container = container.child(file_header(file, effective_mode, geometry, tokens, cx));
		container = container.child(file_body(file_idx, file, effective_mode, geometry, tokens, cx));
	}

	container
}

fn file_header(
	file: &DiffFile,
	diff_mode: DiffMode,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let next_mode = match diff_mode {
		DiffMode::Unified => DiffMode::Split,
		DiffMode::Split => DiffMode::Unified,
	};
	let mode_label = match diff_mode {
		DiffMode::Unified => "Unified",
		DiffMode::Split => "Split",
	};

	div()
		.h(px(geometry.chrome_row_height_px))
		.w_full()
		.flex_shrink_0()
		.flex()
		.flex_row()
		.items_center()
		.justify_between()
		.px(tokens.spacing(SpacingStep::S3))
		.bg(tokens.color(ColorRole::Inset))
		.border_b(px(geometry.chrome_resize_handle_line_px))
		.border_color(tokens.color(ColorRole::Hairline))
		.child(
			div()
				.flex()
				.flex_row()
				.items_center()
				.gap(tokens.spacing(SpacingStep::S2))
				.min_w_0()
				.overflow_hidden()
				.child(
					div()
						.text_size(tokens.font_size(TextRamp::Micro))
						.font_weight(tokens.font_weight(TextWeight::Medium))
						.text_color(tokens.color(ColorRole::Foreground))
						.truncate()
						.child(file.path.clone()),
				)
				.child(
					div()
						.flex_shrink_0()
						.text_size(tokens.font_size(TextRamp::Micro))
						.text_color(tokens.tint(TintRole::Done).fill)
						.child(format!("+{}", file.additions)),
				)
				.child(
					div()
						.flex_shrink_0()
						.text_size(tokens.font_size(TextRamp::Micro))
						.text_color(tokens.tint(TintRole::Error).fill)
						.child(format!("-{}", file.deletions)),
				),
		)
		.child(
			div()
				.id(ElementId::Name(format!("toggle-diff-mode-{}", file.path).into()))
				.on_click(cx.listener(move |view, _event, _window, cx| {
					view.dispatch(Intent::SetDiffMode(next_mode), cx);
				}))
				.px(tokens.spacing(SpacingStep::S2))
				.py(px(2.0))
				.rounded(tokens.radius(RadiusStep::Sm))
				.border(tokens.stroke(StrokeStep::Hairline))
				.border_color(tokens.color(ColorRole::Hairline))
				.hover(|s| s.bg(tokens.row_hover()))
				.text_size(tokens.font_size(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Secondary))
				.child(mode_label),
		)
}

fn file_body(
	file_idx: usize,
	file: &DiffFile,
	diff_mode: DiffMode,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let mut body = div().w_full().flex().flex_col();

	match diff_mode {
		DiffMode::Unified => {
			for (row_idx, row) in file.rows.iter().enumerate() {
				body = body.child(render_unified_row(file_idx, row_idx, row, geometry, tokens, cx));
			}
		},
		DiffMode::Split => {
			body = body.child(render_split_rows(file_idx, file, geometry, tokens, cx));
		},
	}

	body
}

fn render_split_rows(
	file_idx: usize,
	file: &DiffFile,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let mut container = div().w_full().flex().flex_col();

	let mut row_idx = 0;
	while row_idx < file.rows.len() {
		let row = &file.rows[row_idx];
		match row {
			DiffRow::HunkHeader { old_start, old_count, new_start, new_count, symbol } => {
				container = container.child(render_hunk_header(
					*old_start, *old_count, *new_start, *new_count, symbol, geometry, tokens,
				));
				row_idx += 1;
			},
			DiffRow::Context { old_line, new_line, text } => {
				let old_no = format!("{old_line:>4}");
				let new_no = format!("{new_line:>4}");
				container = container.child(
					div()
						.h(px(geometry.diff_row_height_px))
						.w_full()
						.flex_shrink_0()
						.flex()
						.flex_row()
						.items_center()
						.text_size(tokens.font_size(TextRamp::Micro))
						.line_height(px(geometry.diff_row_height_px))
						.font_family(tokens.mono_family())
						// Left side (Old)
						.child(
							div()
								.flex_1()
								.min_w_0()
								.flex()
								.flex_row()
								.items_center()
								.border_r(px(1.0))
								.border_color(tokens.color(ColorRole::Hairline))
								.child(gutter_cell(&old_no, geometry, tokens))
								.child(sign_cell(" ", geometry, tokens, ColorRole::Secondary))
								.child(
									div()
										.flex_1()
										.min_w_0()
										.truncate()
										.text_color(tokens.color(ColorRole::Foreground))
										.child(text.clone()),
								),
						)
						// Right side (New)
						.child(
							div()
								.flex_1()
								.min_w_0()
								.flex()
								.flex_row()
								.items_center()
								.child(gutter_cell(&new_no, geometry, tokens))
								.child(sign_cell(" ", geometry, tokens, ColorRole::Secondary))
								.child(
									div()
										.flex_1()
										.min_w_0()
										.truncate()
										.text_color(tokens.color(ColorRole::Foreground))
										.child(text.clone()),
								),
						),
				);
				row_idx += 1;
			},
			DiffRow::Removed { old_line, text, intraline: _ } => {
				let old_no = format!("{old_line:>4}");
				let mut row_bg = tokens.tint(TintRole::Error).fill;
				row_bg.a = geometry.diff_added_removed_alpha;

				container = container.child(
					div()
						.h(px(geometry.diff_row_height_px))
						.w_full()
						.flex_shrink_0()
						.flex()
						.flex_row()
						.items_center()
						.text_size(tokens.font_size(TextRamp::Micro))
						.line_height(px(geometry.diff_row_height_px))
						.font_family(tokens.mono_family())
						.child(
							div()
								.flex_1()
								.min_w_0()
								.flex()
								.flex_row()
								.items_center()
								.bg(row_bg)
								.border_r(px(1.0))
								.border_color(tokens.color(ColorRole::Hairline))
								.child(gutter_cell(&old_no, geometry, tokens))
								.child(sign_cell("-", geometry, tokens, ColorRole::Foreground))
								.child(
									div()
										.flex_1()
										.min_w_0()
										.truncate()
										.text_color(tokens.color(ColorRole::Foreground))
										.child(text.clone()),
								),
						)
						.child(
							div()
								.flex_1()
								.min_w_0()
								.flex()
								.flex_row()
								.items_center()
								.child(gutter_cell("    ", geometry, tokens))
								.child(sign_cell(" ", geometry, tokens, ColorRole::Secondary)),
						),
				);
				row_idx += 1;
			},
			DiffRow::Added { new_line, text, intraline: _ } => {
				let new_no = format!("{new_line:>4}");
				let mut row_bg = tokens.tint(TintRole::Done).fill;
				row_bg.a = geometry.diff_added_removed_alpha;

				container = container.child(
					div()
						.h(px(geometry.diff_row_height_px))
						.w_full()
						.flex_shrink_0()
						.flex()
						.flex_row()
						.items_center()
						.text_size(tokens.font_size(TextRamp::Micro))
						.line_height(px(geometry.diff_row_height_px))
						.font_family(tokens.mono_family())
						.child(
							div()
								.flex_1()
								.min_w_0()
								.flex()
								.flex_row()
								.items_center()
								.border_r(px(1.0))
								.border_color(tokens.color(ColorRole::Hairline))
								.child(gutter_cell("    ", geometry, tokens))
								.child(sign_cell(" ", geometry, tokens, ColorRole::Secondary)),
						)
						.child(
							div()
								.flex_1()
								.min_w_0()
								.flex()
								.flex_row()
								.items_center()
								.bg(row_bg)
								.child(gutter_cell(&new_no, geometry, tokens))
								.child(sign_cell("+", geometry, tokens, ColorRole::Foreground))
								.child(
									div()
										.flex_1()
										.min_w_0()
										.truncate()
										.text_color(tokens.color(ColorRole::Foreground))
										.child(text.clone()),
								),
						),
				);
				row_idx += 1;
			},
			_ => {
				container =
					container.child(render_unified_row(file_idx, row_idx, row, geometry, tokens, cx));
				row_idx += 1;
			},
		}
	}

	container
}
