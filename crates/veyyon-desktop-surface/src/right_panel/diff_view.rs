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
	Styled, Window, div, px,
};

use crate::{
	ShellView,
	intent::Intent,
	right_panel::{
		content::{DiffFile, DiffStatus, DiffWithheld},
		diff_columns::unified_columns,
		diff_rows::{render_notice_row, withheld_notices},
		diff_split::split_columns,
		pane_scroll::{PaneId, PaneScrolls},
		pane_window::{RowWalk, scrolled},
	},
};

/// Renders the diff tenant for the right panel.
///
/// Every changed file scrolls in one region, so one cursor walks all of them:
/// a file's rows are admitted against the box the region shows, and the
/// chrome between two files is part of the distance the cursor has travelled.
pub fn diff_view(
	files: &[DiffFile],
	diff_status: DiffStatus,
	withheld: DiffWithheld,
	diff_mode: DiffMode,
	panes: &PaneScrolls,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	window: &mut Window,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let effective_mode = diff_mode;

	let rows = panes.handle(PaneId::DiffRows);
	let mut container = div()
		.id("right-panel-diff-view")
		.track_scroll(&rows)
		.flex_1()
		.w_full()
		.flex()
		.flex_col()
		.overflow_y_scroll()
		// As in the file view: a horizontal delta belongs to the pane under the
		// pointer, and without this GPUI maps it onto the axis this region
		// scrolls, so a sideways wheel over a hunk moved the diff's rows.
		.restrict_scroll_to_axis();

	container = container.child(diff_toolbar(diff_mode, geometry, tokens, cx));

	// What the host cut is chrome, not a row: it belongs above the first file
	// rather than at the end of a scroll a reader of a truncated diff never
	// reaches.
	let cut_notices = withheld_notices(withheld);
	for notice in &cut_notices {
		container = container.child(render_notice_row(notice, geometry, tokens));
	}

	if files.is_empty() {
		// A host that cut the diff to nothing still cut it, and the rows above
		// already say so: a second copy centred here would state one cut twice,
		// and reporting a clean working tree would deny it.
		if !cut_notices.is_empty() {
			return container;
		}
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
	let mut walk = RowWalk::of(&scrolled(&rows, window));
	walk.advance(geometry.chrome_row_height_px);
	// One row each, counted rather than multiplied: a usize scaled into the
	// row height is a float conversion of a count for no gain.
	for _ in &cut_notices {
		walk.advance(geometry.diff_row_height_px);
	}
	let hairline_px = f32::from(tokens.stroke(StrokeStep::Hairline));
	for (file_idx, file) in files.iter().enumerate() {
		// A hairline closes each file above the next one's header, so the last
		// row of one file is not read as the first of the next.
		if file_idx > 0 {
			container = container.child(Divider::horizontal());
			walk.advance(hairline_px);
		}
		container = container.child(file_header(file, effective_mode, geometry, tokens, cx));
		walk.advance(geometry.chrome_row_height_px);
		container = container.child(file_body(
			file_idx,
			file,
			effective_mode,
			panes,
			&mut walk,
			geometry,
			tokens,
			window,
			cx,
		));
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

/// Draws one file's rows: one pane in unified mode, two in split mode, each
/// pinning its gutter while its code scrolls sideways (§5.11).
fn file_body(
	file_idx: usize,
	file: &DiffFile,
	diff_mode: DiffMode,
	panes: &PaneScrolls,
	walk: &mut RowWalk,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	window: &mut Window,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	match diff_mode {
		DiffMode::Unified => {
			let columns = unified_columns(file_idx, file, walk, geometry, tokens, cx);
			let scroll = panes.handle(PaneId::DiffUnified(file_idx));
			div().w_full().flex().flex_col().child(
				columns
					.into_pane(
						format!("diff-unified-{file_idx}"),
						&scroll,
						walk.take_padding(),
						window,
						geometry,
						tokens,
					)
					.w_full()
					.flex_shrink_0(),
			)
		},
		DiffMode::Split => {
			let (old, new) = split_columns(file_idx, file, walk, geometry, tokens, cx);
			// Both sides drew the same rows, so both take the same padding.
			let padding = walk.take_padding();
			let old_scroll = panes.handle(PaneId::DiffOld(file_idx));
			let new_scroll = panes.handle(PaneId::DiffNew(file_idx));
			div()
				.w_full()
				.flex()
				.flex_row()
				.items_start()
				.child(
					old.into_pane(
						format!("diff-split-old-{file_idx}"),
						&old_scroll,
						padding,
						window,
						geometry,
						tokens,
					)
					.flex_1()
					.min_w_0(),
				)
				.child(
					new.into_pane(
						format!("diff-split-new-{file_idx}"),
						&new_scroll,
						padding,
						window,
						geometry,
						tokens,
					)
					.flex_1()
					.min_w_0()
					.border_l(px(geometry.chrome_resize_handle_line_px))
					.border_color(tokens.color(ColorRole::Hairline)),
				)
		},
	}
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
