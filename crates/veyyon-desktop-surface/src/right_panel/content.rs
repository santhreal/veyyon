//! Content types for the right panel: tabs, diffs, file views, and directory
//! trees.

use std::{collections::BTreeSet, ops::Range};

use serde::{Deserialize, Serialize};
use veyyon_desktop_kit::ColorRole;
use veyyon_desktop_model::{ChangeStatus, DiffMode};

/// The active tenant in the right panel (§5.6, §5.11).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PanelTab {
	/// Unified or split diff of uncommitted changes.
	#[default]
	Diff,
	/// Syntax-highlighted file contents.
	File,
	/// Hierarchical filesystem directory tree.
	Tree,
}

impl PanelTab {
	/// Display label for the tab strip.
	#[must_use]
	pub const fn label(&self) -> &'static str {
		match self {
			Self::Diff => "Changes",
			Self::File => "File",
			Self::Tree => "Tree",
		}
	}
}

/// All state rendered by the right panel (§5.6).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PanelContent {
	/// Available tabs in the panel strip.
	pub tabs:       Vec<PanelTab>,
	/// Currently selected active tab.
	pub active_tab: PanelTab,
	/// Parsed diff files and hunks for the Changes tab.
	pub diff:       Vec<DiffFile>,
	/// Active file snapshot for the File tab.
	pub file:       Option<FileView>,
	/// Filesystem directory tree for the Tree tab.
	pub tree:       TreeContent,
	/// Layout mode for diff rendering (unified vs split).
	pub diff_mode:  DiffMode,
}

impl PanelContent {
	/// Whether the right panel has any content to display.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.diff.is_empty() && self.file.is_none() && self.tree.rows.is_empty()
	}

	/// Total additions across all changed diff files.
	#[must_use]
	pub fn total_additions(&self) -> usize {
		self.diff.iter().map(|f| f.additions).sum()
	}

	/// Total deletions across all changed diff files.
	#[must_use]
	pub fn total_deletions(&self) -> usize {
		self.diff.iter().map(|f| f.deletions).sum()
	}
}

/// A changed file in a git diff snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffFile {
	/// Relative file path in the workspace.
	pub path:      String,
	/// Previous path if the file was renamed or moved.
	pub old_path:  Option<String>,
	/// Git change status (added, modified, deleted, renamed, etc.).
	pub status:    ChangeStatus,
	/// Number of added lines in this file.
	pub additions: usize,
	/// Number of deleted lines in this file.
	pub deletions: usize,
	/// Renderable rows in the file diff.
	pub rows:      Vec<DiffRow>,
}

/// A row rendered in the diff viewer (§5.11).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffRow {
	/// Hunk boundary header with line range and optional symbol.
	HunkHeader {
		old_start: usize,
		old_count: usize,
		new_start: usize,
		new_count: usize,
		symbol:    Option<String>,
	},
	/// Unchanged context line.
	Context { old_line: usize, new_line: usize, text: String },
	/// Added line with intraline highlight spans.
	Added { new_line: usize, text: String, intraline: Vec<Range<usize>> },
	/// Removed line with intraline highlight spans.
	Removed { old_line: usize, text: String, intraline: Vec<Range<usize>> },
	/// Collapsed context region offering expansion.
	Collapsed { hidden: usize, before_line: usize, after_line: usize },
	/// Binary file notice without textual diff.
	Binary { message: String },
	/// Notice when file contents cannot be retrieved.
	Unavailable { reason: String },
	/// Truncation marker when changed rows exceed the 2,000-row cap.
	Truncated { remaining: usize },
}

/// A styled text span within a highlighted line of code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HighlightSpan {
	pub text: String,
	pub role: ColorRole,
}

/// A line in the syntax-highlighted file view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileLine {
	pub line_number: usize,
	pub spans:       Vec<HighlightSpan>,
}

/// The contents and metadata for the File view tab.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileView {
	pub path:      String,
	pub lines:     Vec<FileLine>,
	pub truncated: bool,
	pub binary:    bool,
}

/// The directory hierarchy for the Tree tab.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TreeContent {
	pub rows:           Vec<TreeRowItem>,
	pub selected_path:  Option<String>,
	pub expanded_paths: BTreeSet<String>,
}

/// An individual row item in the file tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeRowItem {
	pub path:        String,
	pub name:        String,
	pub depth:       usize,
	pub is_dir:      bool,
	pub is_expanded: bool,
	pub changed:     Option<(u32, u32)>,
}
