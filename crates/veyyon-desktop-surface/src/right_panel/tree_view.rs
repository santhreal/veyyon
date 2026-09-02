//! Hierarchical directory tree view (§5.6).
//!
//! Displays workspace files with inline indentation, directory expansion,
//! git modification badges, and file opening intents.

use veyyon_desktop_kit::{ColorRole, RadiusStep, SpacingStep, TintRole, TokenSet};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	Context, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement, Styled,
	div, px,
};

use crate::{
	ShellView,
	intent::Intent,
	right_panel::content::{TreeContent, TreeRowItem},
};

/// Renders the Tree tenant in the right panel.
pub fn tree_view(
	tree: &TreeContent,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	if tree.rows.is_empty() {
		return div()
			.id("right-panel-tree-empty")
			.w_full()
			.flex()
			.items_center()
			.justify_center()
			.text_size(px(geometry.tree_font_size.size))
			.text_color(tokens.color(ColorRole::Muted))
			.child("No files in workspace");
	}

	let mut container = div()
		.id("right-panel-tree")
		.flex_1()
		.w_full()
		.flex()
		.flex_col()
		.overflow_y_scroll();
	for (index, row) in tree.rows.iter().enumerate() {
		container = container.child(render_tree_row(
			index,
			row,
			tree.selected_path.as_deref(),
			geometry,
			tokens,
			cx,
		));
	}

	container
}

fn render_tree_row(
	index: usize,
	row: &TreeRowItem,
	selected_path: Option<&str>,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let depth = u16::try_from(row.depth).unwrap_or(u16::MAX);
	let indent = geometry
		.tree_indent_step_px
		.mul_add(f32::from(depth), geometry.tree_indent_base_px);

	let is_selected = selected_path == Some(&row.path);
	let ground = if is_selected {
		tokens.row_selected()
	} else {
		tokens.transparent()
	};

	let row_path = row.path.clone();
	let is_dir = row.is_dir;

	let mut line = div()
		.id(("tree-row", index))
		.on_click(cx.listener(move |view, _event, _window, cx| {
			if is_dir {
				view.dispatch(Intent::ToggleTreeNode(row_path.clone()));
			} else {
				view.dispatch(Intent::OpenFile(row_path.clone()));
			}
			cx.notify();
		}))
		.h(px(geometry.tree_row_height_px))
		.w_full()
		.flex_shrink_0()
		.flex()
		.flex_row()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2))
		.pl(px(indent))
		.pr(tokens.spacing(SpacingStep::S4))
		.bg(ground)
		.hover(|s| s.bg(tokens.row_hover()))
		.rounded(tokens.radius(RadiusStep::Sm))
		.overflow_hidden();

	let icon = if row.is_dir {
		if row.is_expanded { "▾ " } else { "▸ " }
	} else {
		"  "
	};

	line = line.child(
		div()
			.text_size(px(geometry.tree_font_size.size))
			.line_height(px(geometry.tree_font_size.line_height))
			.text_color(tokens.color(ColorRole::Muted))
			.child(icon),
	);

	line = line.child(
		div()
			.flex_1()
			.min_w_0()
			.overflow_hidden()
			.whitespace_nowrap()
			.truncate()
			.text_size(px(geometry.tree_font_size.size))
			.line_height(px(geometry.tree_font_size.line_height))
			.text_color(tokens.color(if is_selected {
				ColorRole::Foreground
			} else {
				ColorRole::Secondary
			}))
			.child(row.name.clone()),
	);

	if let Some((added, removed)) = row.changed {
		line = line
			.child(
				div()
					.flex_shrink_0()
					.text_size(px(geometry.diff_font_size.size))
					.line_height(px(geometry.diff_font_size.line_height))
					.text_color(tokens.tint(TintRole::Done).fill)
					.child(format!("+{added}")),
			)
			.child(
				div()
					.flex_shrink_0()
					.text_size(px(geometry.diff_font_size.size))
					.line_height(px(geometry.diff_font_size.line_height))
					.text_color(tokens.tint(TintRole::Error).fill)
					.child(format!("-{removed}")),
			);
	}

	line
}
