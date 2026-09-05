//! Hierarchical directory tree view (§5.6).
//!
//! Displays workspace files with inline indentation, directory expansion,
//! git modification badges, and file opening intents. Every row is a kit
//! `TreeRow` whose geometry comes from the panel tokens, inside a kit `Tree`
//! that scrolls.

use veyyon_desktop_kit::{
	ColorRole, IconName, SpacingStep, TintRole, TokenSet, Tree, TreeNodeMetrics, TreeRow,
};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	AnyElement, Context, InteractiveElement, IntoElement, ParentElement, Styled, div, px,
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
) -> AnyElement {
	if tree.rows.is_empty() {
		return div()
			.id("right-panel-tree-empty")
			.w_full()
			.flex()
			.items_center()
			.justify_center()
			.text_size(px(geometry.tree_font_size.size))
			.text_color(tokens.color(ColorRole::Muted))
			.child("No files in workspace")
			.into_any_element();
	}

	// The builder is called once per row while the tree renders, on the same
	// frame, so the rows are built here and handed over in order.
	let rows: Vec<Option<AnyElement>> = tree
		.rows
		.iter()
		.enumerate()
		.map(|(index, row)| {
			Some(render_tree_row(index, row, tree.selected_path.as_deref(), geometry, tokens, cx))
		})
		.collect();
	let rows = std::cell::RefCell::new(rows);
	Tree::new(tree.rows.len(), move |index, _window, _cx| {
		rows
			.borrow_mut()
			.get_mut(index)
			.and_then(Option::take)
			.unwrap_or_else(|| div().into_any_element())
	})
	.id("right-panel-tree")
	.into_any_element()
}

fn render_tree_row(
	index: usize,
	row: &TreeRowItem,
	selected_path: Option<&str>,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	let is_selected = selected_path == Some(&row.path);
	let row_path = row.path.clone();
	let is_dir = row.is_dir;
	let entity = cx.entity();

	let mut node = TreeRow::new(row.name.clone(), row.depth)
		.id(("tree-row", index))
		.branch(row.is_dir)
		.expanded(row.is_expanded)
		.selected(is_selected)
		.metrics(TreeNodeMetrics {
			row_height:  Some(px(geometry.tree_row_height_px)),
			indent_base: Some(px(geometry.tree_indent_base_px)),
			indent_step: Some(px(geometry.tree_indent_step_px)),
			font:        Some((
				px(geometry.tree_font_size.size),
				px(geometry.tree_font_size.line_height),
			)),
		})
		.on_click(move |_event, _window, app| {
			let () = entity.update(app, |view, cx| {
				if is_dir {
					view.dispatch(Intent::ToggleTreeNode(row_path.clone()));
				} else {
					view.dispatch(Intent::OpenFile(row_path.clone()));
				}
				cx.notify();
			});
		});
	if !row.is_dir {
		node = node.icon(IconName::File);
	}

	if let Some((added, removed)) = row.changed {
		node = node.trailing(
			div()
				.flex()
				.flex_row()
				.items_center()
				.gap(tokens.spacing(SpacingStep::S2))
				.pr(tokens.spacing(SpacingStep::S2))
				.text_size(px(geometry.diff_font_size.size))
				.line_height(px(geometry.diff_font_size.line_height))
				.child(
					div()
						.text_color(tokens.tint(TintRole::Done).fill)
						.child(format!("+{added}")),
				)
				.child(
					div()
						.text_color(tokens.tint(TintRole::Error).fill)
						.child(format!("-{removed}")),
				),
		);
	}

	node.into_any_element()
}
