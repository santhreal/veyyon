use serde::{Deserialize, Serialize};

/// Scope of uncommitted git working tree modifications.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChangeScope {
	/// Modified and untracked files in the working tree.
	WorkingTree,
	/// Staged changes in the git index.
	Staged,
}

/// Status classification for a modified path within a git repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChangeStatus {
	/// Newly added file.
	Added,
	/// Modified existing file.
	Modified,
	/// Deleted file.
	Deleted,
	/// Renamed or moved file path.
	Renamed,
	/// Untracked file not yet in index or git history.
	Untracked,
	/// Unresolved merge conflict file.
	Conflicted,
}

/// Detailed file modification metadata within a git changes snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangedFile {
	/// Workspace-relative path to the file.
	pub path:          String,
	/// Previous workspace-relative path if renamed.
	pub previous_path: Option<String>,
	/// Git modification status.
	pub status:        ChangeStatus,
	/// Number of added lines.
	pub additions:     u64,
	/// Number of deleted lines.
	pub deletions:     u64,
}

/// View of uncommitted repository changes and unified diff text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangesView {
	/// Revision counter tracking change snapshot order.
	pub revision:   u64,
	/// Root path of the owning git repository.
	pub repository: Option<String>,
	/// Scope filter applied to this changes snapshot.
	pub scope:      ChangeScope,
	/// Individual changed files in this snapshot.
	pub files:      Vec<ChangedFile>,
	/// Unified diff string spanning all changed files for this scope.
	pub diff:       String,
}
