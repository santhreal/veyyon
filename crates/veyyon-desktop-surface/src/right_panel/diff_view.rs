//! Diff surface view (§5.11).
//!
//! Renders multi-file diffs in unified or side-by-side split modes with
//! pinned gutters, intraline highlights, and mode switching.

use veyyon_desktop_kit::{
	ColorRole, Divider, RadiusStep, SpacingStep, StrokeStep, TextRamp, TextWeight, TintRole,
	TokenSet,
};
use veyyon_desktop_model::{ChangeStatus, DiffMode};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	Context, Hsla, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
	Styled, Window, div, px,
};

use crate::{
	ShellView,
	empty::{EmptySurface, empty_surface},
	right_panel::{
		content::{DiffFile, DiffStatus, DiffWithheld},
		diff_columns::unified_columns,
		diff_rows::{render_notice_row, withheld_notices},
		diff_split::split_columns,
		diff_toolbar::{diff_toolbar, stat_badge},
		pane_scroll::{PaneId, PaneScrolls},
		pane_window::{RowWalk, scrolled},
		review_controls::{ReviewCounts, review_bar, review_button},
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
	pending_edits_unavailable: Option<&str>,
	reviews: &ReviewCounts,
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

	container =
		container.child(diff_toolbar(diff_mode, pending_edits_unavailable, geometry, tokens, cx));
	if reviews.enabled {
		container = container.child(review_bar(reviews, geometry, tokens, cx));
	}

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
		let surface = match diff_status {
			DiffStatus::Unloaded => EmptySurface::DiffUnloaded,
			DiffStatus::Loading => EmptySurface::DiffLoading,
			DiffStatus::Loaded => EmptySurface::DiffClean,
			DiffStatus::Failed => EmptySurface::DiffFailed,
		};
		return container.child(empty_surface(surface, tokens));
	}
	let mut walk = RowWalk::of(&scrolled(&rows, window));
	walk.advance(geometry.chrome_row_height_px);
	if reviews.enabled {
		walk.advance(geometry.chrome_row_height_px);
	}
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
		container = container.child(file_header(file, reviews, geometry, tokens, cx));
		walk.advance(geometry.chrome_row_height_px);
		container = container.child(file_body(
			file_idx,
			file,
			effective_mode,
			reviews.enabled,
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

/// The badge a changed file's status draws beside its path, and the colour it
/// draws in (§5.11).
///
/// An ordinary modification draws none: the added and deleted counts on the
/// same row already state what happened to it, so a badge reading `modified`
/// would repeat them. Every other status is a thing the counts cannot state.
#[must_use]
pub fn status_badge(status: ChangeStatus, tokens: &TokenSet) -> Option<(&'static str, Hsla)> {
	match status {
		ChangeStatus::Added => Some(("new", tokens.tint(TintRole::Done).ink)),
		ChangeStatus::Deleted => Some(("deleted", tokens.tint(TintRole::Error).ink)),
		ChangeStatus::Renamed => Some(("renamed", tokens.color(ColorRole::Secondary))),
		ChangeStatus::Conflicted => Some(("conflict", tokens.tint(TintRole::Error).ink)),
		ChangeStatus::Untracked => Some(("untracked", tokens.color(ColorRole::Muted))),
		ChangeStatus::Modified => None,
	}
}

fn file_header(
	file: &DiffFile,
	reviews: &ReviewCounts,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let review = reviews.enabled.then(|| {
		let fc = reviews.files.get(&file.path).copied().unwrap_or_default();
		review_button(Some(file.path.clone()), fc.unresolved, fc.resolved, tokens, cx)
	});
	let display_path = file
		.old_path
		.as_deref()
		.map_or_else(|| file.path.clone(), |old| format!("{old} → {}", file.path));
	let status_el = status_badge(file.status, tokens).map(|(label, color)| {
		div()
			.flex_shrink_0()
			.px(tokens.spacing(SpacingStep::S1))
			.rounded(tokens.radius(RadiusStep::Xs))
			.bg(tokens.color(ColorRole::Rail))
			.text_size(tokens.font_size(TextRamp::Micro))
			.text_color(color)
			.child(label)
	});
	div()
		.h(px(geometry.chrome_row_height_px))
		.w_full()
		.flex_shrink_0()
		.flex()
		.flex_row()
		.items_center()
		.justify_between()
		.gap(tokens.spacing(SpacingStep::S2))
		// The path is text and the review count is a control, so only the
		// trailing side sheds.
		.pl(tokens.spacing(SpacingStep::S4))
		.pr(tokens.spacing(SpacingStep::S2))
		.bg(tokens.color(ColorRole::Inset))
		.border_b(px(geometry.chrome_resize_handle_line_px))
		.border_color(tokens.color(ColorRole::Hairline))
		.child(
			div()
				.flex_1()
				.flex()
				.flex_row()
				.items_center()
				.gap(tokens.spacing(SpacingStep::S2))
				.min_w_0()
				.overflow_hidden()
				.child(
					div()
						.flex_1()
						.min_w_0()
						.text_size(tokens.font_size(TextRamp::Micro))
						.font_weight(tokens.font_weight(TextWeight::Medium))
						.text_color(tokens.color(ColorRole::Foreground))
						.truncate()
						.child(display_path),
				)
				.children(status_el)
				.child(stat_badge(
					format!("+{}", file.additions),
					tokens.tint(TintRole::Done).ink,
					tokens,
				))
				.child(stat_badge(
					format!("-{}", file.deletions),
					tokens.tint(TintRole::Error).ink,
					tokens,
				)),
		)
		.children(review)
}

/// Draws one file's rows: one pane in unified mode, two in split mode, each
/// pinning its gutter while its code scrolls sideways (§5.11).
fn file_body(
	file_idx: usize,
	file: &DiffFile,
	diff_mode: DiffMode,
	review_enabled: bool,
	panes: &PaneScrolls,
	walk: &mut RowWalk,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	window: &mut Window,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	match diff_mode {
		DiffMode::Unified => {
			let columns = unified_columns(file_idx, file, review_enabled, walk, geometry, tokens, cx);
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
			let (old, new) = split_columns(file_idx, file, review_enabled, walk, geometry, tokens, cx);
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
