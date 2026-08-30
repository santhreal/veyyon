//! The session tree, as a machine.
//!
//! Forking a session, switching branches, appending a turn and compacting are
//! four operations that commute in most orders and break in a few. The tree
//! invariants below are the ones a persisted session is read back against — a
//! node reaches the root, the active node exists, a compaction leaves something
//! behind — and this machine reaches every order the four operations can be
//! performed in, up to the modelled size.
//!
//! Sizes are deliberately tiny. Four nodes and two turns per node is enough for
//! every shape the invariants talk about: a cycle needs two nodes, a lost
//! compaction needs one, and a switch to a missing node needs two. A larger
//! model would explore more states without reaching a different kind of
//! failure.
//!
//! Nothing here blocks, so a state with nothing left to do is a session at
//! rest rather than a deadlock. Deadlock is [`super::locks`]'s class.

use super::{Invariant, Model};

/// Nodes the modelled tree may grow to.
pub const MAX_NODES: usize = 4;

/// Turns a modelled node may record.
pub const MAX_TURNS: u8 = 2;

/// A tree of nodes, one of which is active.
///
/// `parents[0]` is the root and is its own parent, which is what makes the
/// reachability walk below terminate without a special case for the root.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct TreeState {
	pub parents:   Vec<usize>,
	/// Turns recorded on each node.
	pub turns:     Vec<u8>,
	/// Whether each node has been compacted.
	pub compacted: Vec<bool>,
	pub active:    usize,
}

impl TreeState {
	/// A fresh session: one empty root, active.
	#[must_use]
	pub fn root() -> Self {
		Self { parents: vec![0], turns: vec![0], compacted: vec![false], active: 0 }
	}

	/// How many nodes the tree has.
	#[must_use]
	pub const fn len(&self) -> usize {
		self.parents.len()
	}

	/// Never true: a tree always has its root. Present because `len` without it
	/// is a wart.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.parents.is_empty()
	}
}

/// What was done to the tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum TreeAction {
	/// A turn was recorded on the active node.
	Append,
	/// A child of the active node was created and became active.
	Fork,
	/// Another node became active.
	Switch(usize),
	/// The active node's turns were replaced by a summary.
	Compact,
}

/// The session-tree machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tree {
	pub max_nodes:               usize,
	pub max_turns:               u8,
	/// Whether a fork links the child to the node it was forked from. False
	/// makes the child its own parent, which is the defect
	/// `every-node-reaches-the-root` exists to catch: a persisted tree with a
	/// cycle in it hangs the reader that walks it.
	pub fork_links_to_parent:    bool,
	/// Whether a compaction leaves a summary turn behind. False empties the
	/// node, which is the defect `compaction-leaves-a-turn` exists to catch:
	/// the branch is still selectable and now says nothing.
	pub compaction_keeps_a_turn: bool,
}

impl Tree {
	/// The machine as the product is contracted to behave.
	pub const PRODUCTION: Self = Self {
		max_nodes:               MAX_NODES,
		max_turns:               MAX_TURNS,
		fork_links_to_parent:    true,
		compaction_keeps_a_turn: true,
	};
}

impl Default for Tree {
	fn default() -> Self {
		Self::PRODUCTION
	}
}

/// The tree contracts, named as contracts.
pub static INVARIANTS: [Invariant<TreeState>; 4] = [
	Invariant { name: "the-root-is-its-own-parent", predicate: |tree| tree.parents[0] == 0 },
	Invariant {
		name:      "the-active-node-exists",
		predicate: |tree| tree.active < tree.parents.len(),
	},
	Invariant { name: "every-node-reaches-the-root", predicate: reaches_root },
	Invariant {
		name:      "compaction-leaves-a-turn",
		predicate: |tree| {
			tree
				.compacted
				.iter()
				.enumerate()
				.all(|(node, compacted)| !compacted || tree.turns[node] >= 1)
		},
	},
];

/// Whether every node's parent chain arrives at the root.
///
/// The walk is bounded by the node count, so a cycle is reported rather than
/// followed forever: this predicate is checked against states that are allowed
/// to be broken, and hanging on one would be a hung suite.
fn reaches_root(tree: &TreeState) -> bool {
	(0..tree.parents.len()).all(|start| {
		let mut at = start;
		for _ in 0..tree.parents.len() {
			if at == 0 {
				return true;
			}
			let parent = tree.parents[at];
			if parent == at {
				return false;
			}
			at = parent;
		}
		at == 0
	})
}

impl Model for Tree {
	type Action = TreeAction;
	type State = TreeState;

	fn initial(&self) -> Vec<TreeState> {
		vec![TreeState::root()]
	}

	fn steps(&self, tree: &TreeState) -> Vec<(TreeAction, TreeState)> {
		let mut steps = Vec::new();

		if tree.turns[tree.active] < self.max_turns {
			let mut next = tree.clone();
			next.turns[tree.active] += 1;
			steps.push((TreeAction::Append, next));
		}

		if tree.len() < self.max_nodes {
			let mut next = tree.clone();
			let child = next.parents.len();
			next.parents.push(if self.fork_links_to_parent {
				tree.active
			} else {
				child
			});
			next.turns.push(0);
			next.compacted.push(false);
			next.active = child;
			steps.push((TreeAction::Fork, next));
		}

		for node in 0..tree.len() {
			if node != tree.active {
				let mut next = tree.clone();
				next.active = node;
				steps.push((TreeAction::Switch(node), next));
			}
		}

		if tree.turns[tree.active] >= 1 && !tree.compacted[tree.active] {
			let mut next = tree.clone();
			next.compacted[tree.active] = true;
			next.turns[tree.active] = u8::from(self.compaction_keeps_a_turn);
			steps.push((TreeAction::Compact, next));
		}

		steps
	}

	fn is_terminal(&self, tree: &TreeState) -> bool {
		self.steps(tree).is_empty()
	}
}
