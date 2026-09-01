//! The right panel (§5.4).
//!
//! The panel answers one question: what did the run change. It is a tab strip
//! over a file tree, and it is the surface an operator reads instead of
//! scrolling back through invocations to reconstruct a diff. It is optional by
//! construction — a closed panel gives its width back to the transcript — so
//! nothing it shows may be the only place a fact appears.

use veyyon_desktop_kit::{ColorRole, RadiusStep, SpacingStep, TextRamp, TextWeight, TokenSet};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	Context, Div, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
	Styled, div, px,
};

use crate::{ShellView, intent::Intent, model::TreeRow};

/// Builds the right panel at the width the active breakpoint allots it.
///
/// The width is the caller's and is applied verbatim. A floor enforced here
/// instead would win against the width the breakpoint chose, which is how a
/// narrow window ends up with a full-width panel and no session surface at all.
pub fn right_panel(
	tabs: &[String],
	active: usize,
	rows: &[TreeRow],
	width: f32,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	div()
		.flex()
		.flex_col()
		.h_full()
		.w(px(width))
		.flex_shrink_0()
		.bg(tokens.color(ColorRole::Rail))
		.border_l(px(geometry.chrome_resize_handle_line_px))
		.border_color(tokens.color(ColorRole::Hairline))
		.overflow_hidden()
		.child(tab_strip(tabs, active, geometry, tokens, cx))
		.child(tree(rows, geometry, tokens))
}

/// The panel's tab strip.
fn tab_strip(
	tabs: &[String],
	active: usize,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let mut strip = div()
		.h(px(geometry.tabs_height_px))
		.w_full()
		.flex_shrink_0()
		.flex()
		.flex_row()
		.items_center()
		.gap(px(geometry.tabs_gap_px))
		.px(tokens.spacing(SpacingStep::S2))
		.border_b(px(geometry.chrome_resize_handle_line_px))
		.border_color(tokens.color(ColorRole::Hairline))
		.overflow_hidden();

	for (index, label) in tabs.iter().enumerate() {
		let selected = index == active;
		let ink = if selected {
			ColorRole::Foreground
		} else {
			ColorRole::Muted
		};
		let weight = if selected {
			TextWeight::Medium
		} else {
			TextWeight::Regular
		};

		let hover = tokens.row_hover();
		let ground = if selected {
			tokens.row_selected()
		} else {
			tokens.transparent()
		};

		strip = strip.child(
			div()
				// The tab strip is the panel's whole navigation, so a tab that
				// states which one is active without switching to it leaves the
				// panel showing one thing and offering three.
				.id(("panel-tab", index))
				.on_click(cx.listener(move |view, _event, _window, cx| {
					view.dispatch(Intent::SelectTab(index));
					cx.notify();
				}))
				.hover(move |style| style.bg(hover))
				.max_w(px(geometry.tabs_max_width_px))
				.min_w_0()
				.px(tokens.spacing(SpacingStep::S2))
				.rounded(tokens.radius(RadiusStep::Sm))
				.bg(ground)
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.font_weight(tokens.font_weight(weight))
				.text_color(tokens.color(ink))
				.child(label.clone()),
		);
	}

	strip
}

/// The panel's file tree.
fn tree(rows: &[TreeRow], geometry: &PanelsSurfaceTokens, tokens: &TokenSet) -> Div {
	let mut tree = div().flex().flex_col().w_full().flex_1().overflow_hidden();

	for row in rows {
		// Indentation is the base inset plus one step per level. A depth cast
		// through `f32` rather than multiplied as a `usize` keeps a deep tree
		// from wrapping the arithmetic.
		let depth = u16::try_from(row.depth).unwrap_or(u16::MAX);
		let indent = geometry
			.tree_indent_step_px
			.mul_add(f32::from(depth), geometry.tree_indent_base_px);

		let mut line = div()
			.h(px(geometry.tree_row_height_px))
			.w_full()
			.flex_shrink_0()
			.flex()
			.flex_row()
			.items_center()
			.gap(tokens.spacing(SpacingStep::S2))
			.pl(px(indent))
			.pr(tokens.spacing(SpacingStep::S4))
			.overflow_hidden()
			.child(
				div()
					.flex_1()
					.min_w_0()
					.overflow_hidden()
					.whitespace_nowrap()
					.truncate()
					.text_size(px(geometry.tree_font_size.size))
					.line_height(px(geometry.tree_font_size.line_height))
					.text_color(tokens.color(ColorRole::Secondary))
					.child(row.name.clone()),
			);

		// A directory carries no counts. Only a changed file states a delta,
		// which is what makes the changed files findable in a deep tree.
		if let Some((added, removed)) = row.changed {
			line = line
				.child(
					div()
						.flex_shrink_0()
						.text_size(px(geometry.diff_font_size.size))
						.line_height(px(geometry.diff_font_size.line_height))
						.text_color(tokens.tint(veyyon_desktop_kit::TintRole::Done).fill)
						.child(format!("+{added}")),
				)
				.child(
					div()
						.flex_shrink_0()
						.text_size(px(geometry.diff_font_size.size))
						.line_height(px(geometry.diff_font_size.line_height))
						.text_color(tokens.tint(veyyon_desktop_kit::TintRole::Error).fill)
						.child(format!("-{removed}")),
				);
		}

		tree = tree.child(line);
	}

	tree
}
