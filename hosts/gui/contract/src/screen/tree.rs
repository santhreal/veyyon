//! Indented rows that open and close.
//!
//! The file tree, the session tree and a plan's table of contents are this
//! shape.
//!
//! Flat, with a depth on each node, rather than nested children. The surface
//! that produces it has already decided what is open, so a nested model would
//! be flattened by every renderer and by every test; and a flat list is what
//! both scrolling and keyboard movement need.

use crate::view::Badge;

/// A titled tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tree {
	pub title:    String,
	pub query:    Option<String>,
	/// Visible nodes in reading order. A closed node's children are absent, not
	/// hidden: what is not here is not on screen.
	pub nodes:    Vec<TreeNode>,
	pub selected: usize,
	pub empty:    String,
	pub footer:   Option<String>,
}

impl Tree {
	pub fn new(title: impl Into<String>, nodes: Vec<TreeNode>) -> Tree {
		Tree {
			title: title.into(),
			query: None,
			nodes,
			selected: 0,
			empty: "Nothing here".to_owned(),
			footer: None,
		}
	}

	/// Which row the highlight is on.
	pub fn highlight(mut self, selected: usize) -> Tree {
		self.selected = selected;
		self
	}

	pub fn highlighted(&self) -> Option<&TreeNode> {
		self.nodes.get(self.selected)
	}

	/// The deepest indent any visible node sits at, which is what the renderer
	/// sizes its gutter by.
	pub fn max_depth(&self) -> usize {
		self.nodes.iter().map(|node| node.depth).max().unwrap_or(0)
	}
}

/// One row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeNode {
	/// Indent level. Zero is the root row.
	pub depth:      usize,
	pub label:      String,
	pub detail:     Option<String>,
	pub state:      NodeState,
	pub badges:     Vec<Badge>,
	/// True when this is the last child of its parent, which is what draws the
	/// corner of the gutter rather than a tee.
	pub last_child: bool,
}

impl TreeNode {
	pub fn new(depth: usize, label: impl Into<String>, state: NodeState) -> TreeNode {
		TreeNode {
			depth,
			label: label.into(),
			detail: None,
			state,
			badges: Vec::new(),
			last_child: false,
		}
	}

	pub fn detail(mut self, detail: impl Into<String>) -> TreeNode {
		self.detail = Some(detail.into());
		self
	}

	pub fn last(mut self) -> TreeNode {
		self.last_child = true;
		self
	}
}

/// Whether a node has children, and whether they are on screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeState {
	/// No children.
	Leaf,
	/// Has children, and they follow this row.
	Open,
	/// Has children, and they are not on screen.
	Closed,
	/// Has children that are being read. A tree over a transport opens a branch
	/// before its contents arrive, and a row that showed `Closed` meanwhile
	/// would read as a directory the operator failed to open.
	Loading,
}

impl NodeState {
	/// Every state, in the order they are declared.
	pub const ALL: [NodeState; 4] =
		[NodeState::Leaf, NodeState::Open, NodeState::Closed, NodeState::Loading];
}
