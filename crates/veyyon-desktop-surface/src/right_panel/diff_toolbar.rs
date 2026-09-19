//! The row above the diff: which change scope is read, how the pair is laid
//! out, and what the host refused (§4.3).
//!
//! Gated controls:
//! - `diff-scope-working-tree` and `diff-scope-staged`: gated by
//!   `Capability::Changes`.
//! - `diff-pending-edits`: displays the host's verbatim reason when
//!   `Capability::PendingEdits` is `Unavailable`, in muted ink with no retry
//!   (§1.2 item 1, §4.3). At rest (`Available` and `UnknownUntilAttached`),
//!   activation attaches then acts; no affordance appears and nothing dims.

use veyyon_desktop_kit::{ColorRole, RadiusStep, SpacingStep, StrokeStep, TextRamp, TokenSet};
use veyyon_desktop_model::{ChangeScope, DiffMode};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	Context, Hsla, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
	Styled, div, px,
};

use crate::{ShellView, intent::Intent};

/// Scope and layout controls for the diff view.
pub fn diff_toolbar(
	diff_mode: DiffMode,
	pending_edits_unavailable: Option<&str>,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let (next_mode, mode_label) = match diff_mode {
		DiffMode::Unified => (DiffMode::Split, "Unified"),
		DiffMode::Split => (DiffMode::Unified, "Split"),
	};
	let pending_edits_indicator = pending_edits_unavailable.map(|reason| {
		div()
			.id("diff-pending-edits")
			.flex_shrink_0()
			.px(tokens.spacing(SpacingStep::S2))
			.py(tokens.spacing(SpacingStep::S1))
			.rounded(tokens.radius(RadiusStep::Sm))
			.text_size(tokens.font_size(TextRamp::Micro))
			.text_color(tokens.color(ColorRole::Muted))
			.child(reason.to_string())
	});

	div()
		.h(px(geometry.chrome_row_height_px))
		.w_full()
		.flex_shrink_0()
		.flex()
		.flex_row()
		.items_center()
		.justify_between()
		// A control on each side, so the row sheds the padding they carry.
		.px(tokens.spacing(SpacingStep::S2))
		.bg(tokens.color(ColorRole::Inset))
		.border_b(px(geometry.chrome_resize_handle_line_px))
		.border_color(tokens.color(ColorRole::Hairline))
		.child(
			div()
				.flex()
				.flex_row()
				.items_center()
				.gap(tokens.spacing(SpacingStep::S2))
				.child(scope_button(
					"diff-scope-working-tree",
					"Working tree",
					ChangeScope::WorkingTree,
					ColorRole::Foreground,
					tokens,
					cx,
				))
				.child(scope_button(
					"diff-scope-staged",
					"Staged",
					ChangeScope::Staged,
					ColorRole::Secondary,
					tokens,
					cx,
				))
				.children(pending_edits_indicator),
		)
		.child(
			div()
				.flex()
				.flex_row()
				.items_center()
				.gap(tokens.spacing(SpacingStep::S2))
				.child(
					div()
						.id("diff-toolbar-toggle-mode")
						.on_click(cx.listener(move |view, _event, _window, cx| {
							view.dispatch(Intent::SetDiffMode(next_mode), cx);
						}))
						.px(tokens.spacing(SpacingStep::S2))
						.py(tokens.spacing(SpacingStep::S1))
						.rounded(tokens.radius(RadiusStep::Sm))
						.border(tokens.stroke(StrokeStep::Hairline))
						.border_color(tokens.color(ColorRole::Hairline))
						.hover(|s| s.bg(tokens.row_hover()))
						.text_size(tokens.font_size(TextRamp::Micro))
						.text_color(tokens.color(ColorRole::Secondary))
						.child(mode_label),
				),
		)
}

fn scope_button(
	id: &'static str,
	label: &'static str,
	scope: ChangeScope,
	color: ColorRole,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	div()
		.id(id)
		.on_click(cx.listener(move |view, _event, _window, cx| {
			view.dispatch(Intent::SelectChangeScope(scope), cx);
		}))
		.px(tokens.spacing(SpacingStep::S2))
		.py(tokens.spacing(SpacingStep::S1))
		.rounded(tokens.radius(RadiusStep::Sm))
		.hover(|s| s.bg(tokens.row_hover()))
		.text_size(tokens.font_size(TextRamp::Micro))
		.text_color(tokens.color(color))
		.child(label)
}

/// One number of a file's `+`/`−` pair, in the ink that states which it is.
pub fn stat_badge(label: String, color: Hsla, tokens: &TokenSet) -> impl IntoElement {
	div()
		.flex_shrink_0()
		.text_size(tokens.font_size(TextRamp::Micro))
		.text_color(color)
		.child(label)
}
