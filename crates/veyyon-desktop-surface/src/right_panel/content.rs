//! Content types for the right panel: tabs, diffs, file views, and directory
//! trees.

use std::{collections::BTreeSet, ops::Range};

use serde::{Deserialize, Serialize};
use veyyon_desktop_kit::ColorRole;
use veyyon_desktop_model::{ChangeStatus, DiffMode, UsageTotals};

/// The active tenant in the right panel (§5.6, §5.11).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum PanelTab {
	/// Unified or split diff of uncommitted changes.
	#[default]
	Diff,
	/// Syntax-highlighted file contents.
	File,
	/// Hierarchical filesystem directory tree.
	Tree,
	/// The session's token and cost accounting, on one line (§5.3).
	Usage,
}

impl PanelTab {
	/// Display label for the tab strip.
	#[must_use]
	pub const fn label(&self) -> &'static str {
		match self {
			Self::Diff => "Changes",
			Self::File => "File",
			Self::Tree => "Tree",
			Self::Usage => "Usage",
		}
	}

	/// Every tab, so a tab added to the panel is remembered without an edit
	/// to the reader below.
	#[must_use]
	pub const fn all() -> [Self; 4] {
		[Self::Diff, Self::File, Self::Tree, Self::Usage]
	}

	/// The name the tab is written under in what the window remembers (§8.10).
	#[must_use]
	pub const fn slug(&self) -> &'static str {
		match self {
			Self::Diff => "diff",
			Self::File => "file",
			Self::Tree => "tree",
			Self::Usage => "usage",
		}
	}

	/// The tab a remembered name stands for, or `None` for a name this binary
	/// draws no tab for.
	#[must_use]
	pub fn from_slug(slug: &str) -> Option<Self> {
		Self::all().into_iter().find(|tab| tab.slug() == slug)
	}
}

/// Status of the diff snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffStatus {
	/// Diff has not been fetched yet (initial unrequested state).
	#[default]
	Unloaded,
	/// Diff request is in flight.
	Loading,
	/// Diff snapshot has been loaded from the host.
	Loaded,
	/// Diff request failed or is unavailable.
	Failed,
}

/// The answers the panel's expensive content was derived from: how many times
/// the host had stated the working tree, the open file and the export when the
/// rows and the highlighted document were built.
///
/// The window re-projects on every host event batch, so a streamed turn asks
/// the panel for its content dozens of times a second. Parsing a repository's
/// unified diff and highlighting a file are the two derivations that cost more
/// than a frame, and neither can change without an answer from the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DerivedFrom {
	/// Answers to the working tree when the diff rows were parsed.
	pub changes:      u64,
	/// Answers to the open file when the document was highlighted.
	pub file_content: u64,
	/// Answers to the export when the document was highlighted.
	pub export:       u64,
}

/// What the host held back from the changes snapshot the rows were parsed
/// from.
///
/// A working tree has no size limit and a frame does, so the host cuts the
/// diff at a byte budget and the file list at a count. The pane states both,
/// because a diff that stops early otherwise reads as a diff that ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DiffWithheld {
	/// Whether the diff text is a prefix of the scope's diff.
	pub diff_truncated: bool,
	/// Changed files the snapshot did not list.
	pub files_withheld: u64,
	/// Bytes of diff text the snapshot did carry.
	pub diff_bytes:     usize,
}

/// All state rendered by the right panel (§5.6).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PanelContent {
	/// Available tabs in the panel strip.
	pub tabs:               Vec<PanelTab>,
	/// Currently selected active tab.
	pub active_tab:         PanelTab,
	/// Parsed diff files and hunks for the Changes tab.
	pub diff:               Vec<DiffFile>,
	/// Loading status of the diff.
	pub diff_status:        DiffStatus,
	/// Active file snapshot for the File tab.
	pub file:               Option<FileView>,
	/// Filesystem directory tree for the Tree tab.
	pub tree:               TreeContent,
	/// Layout mode for diff rendering (unified vs split).
	pub diff_mode:          DiffMode,
	/// The session's accounting totals for the Usage tab.
	pub usage:              Option<UsageTotals>,
	/// Reason if the panel is unavailable.
	pub unavailable_reason: Option<String>,
	/// The answers `diff` and `file` were derived from.
	pub derived_from:       DerivedFrom,
	/// What the host cut from the snapshot `diff` was parsed from.
	pub withheld:           DiffWithheld,
}

impl PanelContent {
	/// Whether the right panel has any content to display.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.tabs.is_empty()
			&& self.diff.is_empty()
			&& self.file.is_none()
			&& self.tree.rows.is_empty()
			&& self.usage.is_none()
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

/// Status of the workspace directory tree snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TreeStatus {
	/// Tree has not been fetched yet (initial unrequested state).
	#[default]
	Unloaded,
	/// Tree request is in flight.
	Loading,
	/// Tree snapshot has been loaded from the host.
	Loaded,
	/// Tree request failed or is unavailable.
	Failed,
}

/// The directory hierarchy for the Tree tab.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TreeContent {
	pub rows:           Vec<TreeRowItem>,
	pub selected_path:  Option<String>,
	pub expanded_paths: BTreeSet<String>,
	pub status:         TreeStatus,
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
