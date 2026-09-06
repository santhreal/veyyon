use serde::{Deserialize, Serialize};

/// Filesystem node kind within a workspace directory tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FileKind {
	/// Regular file.
	File,
	/// Directory container.
	Directory,
	/// Symbolic link.
	Symlink,
}

/// Individual node within a directory listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileNode {
	/// Workspace-relative path separated with forward slashes.
	pub path:  String,
	/// Node base name without parent path components.
	pub name:  String,
	/// Filesystem node classification.
	pub kind:  FileKind,
	/// Nesting depth from the tree root.
	pub depth: u32,
}

/// Workspace filesystem directory hierarchy view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileTreeView {
	/// Root directory path.
	pub root:      String,
	/// Flattened list of file and directory nodes.
	pub entries:   Vec<FileNode>,
	/// Flag indicating whether the listing was truncated due to size limits.
	pub truncated: bool,
}

/// File content snapshot payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileContentView {
	/// Workspace-relative path of the requested file.
	pub path:       String,
	/// Text content of the file.
	pub content:    String,
	/// Size of the file in bytes.
	pub size_bytes: u64,
	/// Flag indicating whether content was truncated due to buffer limits.
	pub truncated:  bool,
	/// Flag indicating whether the file contains binary data.
	pub binary:     bool,
}

/// Text search match results across workspace files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchResultsView {
	/// Query text or pattern matched.
	pub query:     String,
	/// Workspace-relative matching file paths.
	pub paths:     Vec<String>,
	/// Flag indicating whether results were truncated due to match limits.
	pub truncated: bool,
}
