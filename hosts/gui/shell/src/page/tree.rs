//! Nested rows that open and close.

use gpui::{App, Div, ParentElement, Pixels, Styled, px};
use veyyon_gui_contract::screen::{NodeState, Tree, TreeNode};
use veyyon_gui_kit::{
	chrome::{chip, column, row, well},
	text::{caption, mono, text_in},
	theme::ActiveTheme,
	tokens::{radius, space, text},
};
use veyyon_gui_theme::Role;
use veyyon_gui_views::tone;

/// How far one level of depth indents.
const INDENT: f32 = 14.0;

pub fn tree(value: &Tree, cx: &App) -> Div {
	let mut stack = column(space::HAIR);
	if let Some(query) = &value.query {
		stack = stack.child(well(query.clone(), Role::TextPrimary, cx));
	}
	if value.nodes.is_empty() {
		return stack.child(caption(value.empty.clone(), cx));
	}

	let gutter = gutter_width(value);
	stack = stack.children(
		value
			.nodes
			.iter()
			.enumerate()
			.map(|(index, node)| self::node(node, index == value.selected, gutter, cx)),
	);
	match &value.footer {
		None => stack,
		Some(footer) => stack.child(caption(footer.clone(), cx)),
	}
}

/// The width the indent gutter reserves for the whole tree.
///
/// Sized from the deepest node rather than per row, so the labels of a branch
/// do not shift left when its deepest child scrolls out of view.
pub fn gutter_width(value: &Tree) -> Pixels {
	px(indent_of(value.max_depth()))
}

/// How far a node at `depth` is indented.
///
/// Linear in the depth, which is what makes a child visibly inside its parent.
/// A renderer that indented by a constant would draw a flat list with markers.
pub fn indent_of(depth: usize) -> f32 {
	INDENT * depth as f32
}

/// The marker that precedes a node.
///
/// Every state is distinct, including [`NodeState::Loading`]: a branch whose
/// children are still arriving that drew as closed would read as a directory
/// the operator failed to open.
pub fn state_marker(state: NodeState) -> &'static str {
	match state {
		NodeState::Leaf => " ",
		NodeState::Open => "▾",
		NodeState::Closed => "▸",
		NodeState::Loading => "◌",
	}
}

/// The role a node's label reads in.
pub fn state_role(state: NodeState) -> Role {
	match state {
		NodeState::Leaf => Role::TextPrimary,
		NodeState::Open | NodeState::Closed => Role::TextAccent,
		NodeState::Loading => Role::TextMuted,
	}
}

fn node(value: &TreeNode, highlighted: bool, gutter: Pixels, cx: &App) -> Div {
	let role = state_role(value.state);
	let mut line = row(space::SNUG)
		.w_full()
		.items_baseline()
		.p(space::HAIR)
		.rounded(radius::SMALL)
		.child(gpui::div().w(gutter).flex().justify_end().child(text_in(
			state_marker(value.state),
			role,
			text::SMALL,
			cx,
		)))
		.child(gpui::div().w(px(indent_of(value.depth))))
		.child(mono(value.label.clone(), role, cx));
	if let Some(detail) = &value.detail {
		line = line.child(caption(detail.clone(), cx));
	}
	line = line.children(
		value
			.badges
			.iter()
			.map(|badge| chip(badge.text.clone(), tone::role(badge.tone), cx)),
	);
	if highlighted {
		line = line.bg(cx.color(Role::InteractionSelected));
	}
	line
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! The contract carries a flat node list with a depth on each row, so the
	//! nesting exists only in what this file draws. An indent that is constant
	//! draws a flat list with markers on it, which reads as a directory with no
	//! structure. A gutter sized per row rather than per tree shifts the labels
	//! of a branch when its deepest child scrolls away.
	//!
	//! The markers are the third: `Loading` drawn as `Closed` reads as a
	//! directory the operator failed to open, and they retry instead of waiting.
	//!
	//! WHAT IT DOES NOT CATCH. The guide lines a `last_child` node closes, which
	//! are not drawn yet, and scrolling.

	use veyyon_gui_contract::fixtures;

	use super::*;

	#[test]
	fn a_child_indents_further_than_its_parent_in_proportion_to_the_depth() {
		assert_eq!(indent_of(0), 0.0);
		assert_eq!(indent_of(2), indent_of(1) * 2.0);
		assert!(indent_of(3) > indent_of(2));
	}

	#[test]
	fn the_gutter_is_sized_from_the_deepest_node_in_the_tree() {
		let tree = fixtures::routes::file_tree();
		assert_eq!(tree.max_depth(), 2);
		assert_eq!(gutter_width(&tree), px(indent_of(2)));
	}

	#[test]
	fn a_flat_tree_reserves_no_gutter() {
		let flat = Tree::new("root", vec![TreeNode::new(0, "one", NodeState::Leaf)]);
		assert_eq!(gutter_width(&flat), px(0.0));
	}

	#[test]
	fn every_node_state_draws_differently() {
		let all = [NodeState::Leaf, NodeState::Open, NodeState::Closed, NodeState::Loading];

		let mut markers: Vec<&str> = all.iter().copied().map(state_marker).collect();
		let count = markers.len();
		markers.sort_unstable();
		markers.dedup();
		assert_eq!(markers.len(), count, "two node states share a marker");

		assert_eq!(state_marker(NodeState::Loading), "◌");
		assert_ne!(state_marker(NodeState::Loading), state_marker(NodeState::Closed));
		assert_ne!(state_role(NodeState::Loading), state_role(NodeState::Closed));
	}

	#[test]
	fn the_fixture_tree_carries_a_loading_branch_to_draw() {
		let tree = fixtures::routes::file_tree();
		assert!(
			tree
				.nodes
				.iter()
				.any(|node| node.state == NodeState::Loading),
			"nothing exercises the loading marker"
		);
		assert!(tree.highlighted().is_some(), "the highlight is past the last node");
	}
}
