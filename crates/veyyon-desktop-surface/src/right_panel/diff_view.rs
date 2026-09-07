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
	Context, ElementId, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
	Styled, div, px,
};

use crate::{
	ShellView,
	intent::Intent,
	right_panel::{
		content::{DiffFile, DiffStatus},
		diff_rows::render_unified_row,
		diff_split::render_split_rows,
	},
};

/// Renders the diff tenant for the right panel.
pub fn diff_view(
	files: &[DiffFile],
	diff_status: DiffStatus,
	diff_mode: DiffMode,
	_panel_width: f32,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let effective_mode = diff_mode;

	let mut container = div()
		.id("right-panel-diff-view")
		.flex_1()
		.w_full()
		.flex()
		.flex_col()
		.overflow_y_scroll();

	container = container.child(diff_toolbar(diff_mode, geometry, tokens, cx));

	if files.is_empty() {
		let message = match diff_status {
			DiffStatus::Unloaded => "Open changes",
			DiffStatus::Loading => "Loading changes...",
			DiffStatus::Loaded => "No uncommitted changes",
			DiffStatus::Failed => "Failed to load changes",
		};
		return container.child(
			div()
				.id("right-panel-diff-empty")
				.flex_1()
				.w_full()
				.flex()
				.items_center()
				.justify_center()
				.py(tokens.spacing(SpacingStep::S4))
				.text_size(tokens.font_size(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.child(message),
		);
	}
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

fn diff_toolbar(
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
				.child(
					div()
						.id("diff-scope-working-tree")
						.on_click(cx.listener(|view, _event, _window, cx| {
							view.dispatch(
								Intent::SelectChangeScope(veyyon_desktop_model::ChangeScope::WorkingTree),
								cx,
							);
						}))
						.px(tokens.spacing(SpacingStep::S2))
						.py(px(2.0))
						.rounded(tokens.radius(RadiusStep::Sm))
						.hover(|s| s.bg(tokens.row_hover()))
						.text_size(tokens.font_size(TextRamp::Micro))
						.text_color(tokens.color(ColorRole::Foreground))
						.child("Working tree"),
				)
				.child(
					div()
						.id("diff-scope-staged")
						.on_click(cx.listener(|view, _event, _window, cx| {
							view.dispatch(
								Intent::SelectChangeScope(veyyon_desktop_model::ChangeScope::Staged),
								cx,
							);
						}))
						.px(tokens.spacing(SpacingStep::S2))
						.py(px(2.0))
						.rounded(tokens.radius(RadiusStep::Sm))
						.hover(|s| s.bg(tokens.row_hover()))
						.text_size(tokens.font_size(TextRamp::Micro))
						.text_color(tokens.color(ColorRole::Secondary))
						.child("Staged"),
				),
		)
		.child(
			div()
				.id("diff-toolbar-toggle-mode")
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
