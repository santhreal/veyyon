//! A session's entry tree, as the window receives it for the tree sheet.
//!
//! The host flattens the tree the way the terminal's `/tree` selector does:
//! rows in pre-order, the branch holding the current leaf first, indented by
//! the terminal's rule rather than by raw depth. Which filter mode shows a
//! row is the host's answer too, so the window draws the terminal's filters
//! without restating their rules.

use serde::{Deserialize, Serialize};

use crate::connection::EntryId;

/// Which entries a tree sheet shows, in the order the terminal cycles them.
#[derive(
	Debug,
	Clone,
	Copy,
	PartialEq,
	Eq,
	Hash,
	Default,
	Serialize,
	Deserialize,
	ts_rs::TS,
	strum::EnumIter,
)]
#[serde(rename_all = "kebab-case")]
pub enum SessionTreeFilter {
	/// Every entry except settings bookkeeping: labels, custom entries and
	/// model and thinking changes.
	#[default]
	Default,
	/// The default view without tool results.
	NoTools,
	/// Operator messages only.
	UserOnly,
	/// Entries that hold a label.
	LabeledOnly,
	/// Every entry.
	All,
}

/// What a tree entry records, which is what its row is toned by.
#[derive(
	Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ts_rs::TS, strum::EnumIter,
)]
#[serde(rename_all = "snake_case")]
pub enum SessionTreeEntryKind {
	/// A message the operator sent.
	User,
	/// A developer instruction message.
	Developer,
	/// A reply from the model.
	Assistant,
	/// The result a tool returned.
	ToolResult,
	/// A shell command the operator ran.
	Bash,
	/// A message an extension injected.
	CustomMessage,
	/// A compaction of the entries before it.
	Compaction,
	/// The summary of a branch that was left.
	BranchSummary,
	/// A change of model.
	ModelChange,
	/// A change of thinking level.
	ThinkingChange,
	/// A label set on or cleared from an entry.
	Label,
	/// Data an extension recorded.
	Custom,
	/// Any other message role or entry type.
	Other,
}

/// One row of the tree sheet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct SessionTreeNode {
	/// The entry the row stands for; `NavigateTree` names it.
	pub id:       EntryId,
	/// The entry this one follows, or `None` for a root.
	pub parent:   Option<EntryId>,
	/// The row's indent in levels: a single-child chain stays flat and a
	/// branch point indents its children, as the terminal draws it.
	pub depth:    usize,
	/// What the entry records.
	pub kind:     SessionTreeEntryKind,
	/// The role marker drawn in the kind's tone (`user: `, `[branch
	/// summary]: `), or empty when the whole row is one tone.
	pub prefix:   String,
	/// The rest of the row on one line: `[bash]: ls`, `[read: src/a.ts]`.
	pub text:     String,
	/// The label set on the entry, if any.
	pub label:    Option<String>,
	/// The entry lies on the path from the root to the current leaf.
	pub on_path:  bool,
	/// The filter modes that show the row. An assistant turn holding only tool
	/// calls lists none unless it is the current leaf.
	pub shown_in: Vec<SessionTreeFilter>,
}

/// A session's entry tree as the host answered `LoadSessionTree`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct SessionTreeView {
	/// The entry the session continues from, or `None` before any entry.
	pub leaf:            Option<EntryId>,
	/// Every entry, in the order the sheet draws them.
	pub nodes:           Vec<SessionTreeNode>,
	/// Navigating away from a branch offers to summarize it.
	pub summary_offered: bool,
	/// The filter mode the sheet opens in.
	pub filter:          SessionTreeFilter,
}
