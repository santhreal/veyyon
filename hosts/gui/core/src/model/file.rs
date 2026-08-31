//! File workspace and change replicas. Parsed diffs are stored once per
//! revision.

use super::{FileId, RemoteData, Versioned, WorkspaceId};
use crate::text::diff::FileDiff;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum FileKind {
	Directory,
	Text,
	Image,
	Binary,
	Symlink,
	Other,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct FileNode {
	pub id:             FileId,
	pub workspace:      WorkspaceId,
	pub parent:         Option<FileId>,
	pub name:           String,
	pub path:           String,
	pub kind:           FileKind,
	pub size_bytes:     Option<u64>,
	pub ignored:        bool,
	pub symlink_target: Option<String>,
	pub modified_at_ms: Option<u64>,
	pub children:       RemoteData<Versioned<Vec<FileId>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LineRange {
	pub start: u32,
	pub end:   u32,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum FileBody {
	Text { text: String, language: Option<String> },
	Markdown { source: String },
	Image { media_type: String, bytes: Vec<u8> },
	Binary { size_bytes: Option<u64> },
	TooLarge { size_bytes: Option<u64>, limit_bytes: Option<u64> },
	Unavailable { reason: String },
}
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct OutlineItem {
	pub label:    String,
	pub kind:     String,
	pub range:    LineRange,
	pub children: Vec<OutlineItem>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct FileReadView {
	pub id:      FileId,
	pub path:    String,
	pub range:   Option<LineRange>,
	pub body:    FileBody,
	pub outline: Vec<OutlineItem>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum FileReadErrorKind {
	NotFound,
	PermissionDenied,
	Binary,
	TooLarge,
	Transport,
	Other,
}

impl FileReadErrorKind {
	pub fn as_str(&self) -> &'static str {
		match self {
			Self::NotFound => "not_found",
			Self::PermissionDenied => "permission_denied",
			Self::Binary => "binary",
			Self::TooLarge => "too_large",
			Self::Transport => "transport",
			Self::Other => "other",
		}
	}

	pub fn from_code(code: &str) -> Self {
		match code {
			"not_found" | "NotFound" => Self::NotFound,
			"permission_denied" | "PermissionDenied" => Self::PermissionDenied,
			"binary" | "Binary" => Self::Binary,
			"too_large" | "TooLarge" => Self::TooLarge,
			"transport" | "Transport" => Self::Transport,
			_ => Self::Other,
		}
	}
}

impl std::fmt::Display for FileReadErrorKind {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::NotFound => write!(f, "File not found"),
			Self::PermissionDenied => write!(f, "Permission denied"),
			Self::Binary => write!(f, "Binary file"),
			Self::TooLarge => write!(f, "File too large"),
			Self::Transport => write!(f, "Transport error"),
			Self::Other => write!(f, "Error reading file"),
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FileReadError {
	pub path:      String,
	pub kind:      FileReadErrorKind,
	pub message:   String,
	pub retryable: bool,
}

impl FileReadError {
	pub fn new(
		path: impl Into<String>,
		kind: FileReadErrorKind,
		message: impl Into<String>,
		retryable: bool,
	) -> Self {
		Self { path: path.into(), kind, message: message.into(), retryable }
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub enum FileSearchMode {
	#[default]
	Name,
	Content,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FileSearchResult {
	pub file:    FileId,
	pub path:    String,
	pub line:    Option<u32>,
	pub excerpt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct FileWorkspaceState {
	pub roots:         Vec<WorkspaceId>,
	pub nodes:         Vec<FileNode>,
	pub selected_read: RemoteData<Versioned<FileReadView>>,
	pub read_error:    Option<FileReadError>,
	pub search:        RemoteData<Versioned<Vec<FileSearchResult>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ChangeScope {
	WorkingTree,
	Session,
	Entry(super::EntryId),
	Custom(String),
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum FileChangeStatus {
	Added,
	Modified,
	Deleted,
	Renamed,
	Copied,
	Untracked,
	Conflicted,
	Unknown(String),
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ChangedFileView {
	pub id:        FileId,
	pub path:      String,
	pub old_path:  Option<String>,
	pub kind:      FileKind,
	pub status:    FileChangeStatus,
	pub additions: u64,
	pub deletions: u64,
	pub binary:    bool,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ChangesSnapshot {
	pub scope:           ChangeScope,
	pub base:            Option<String>,
	pub files:           Vec<ChangedFileView>,
	pub available_bases: Vec<String>,
	#[serde(skip)]
	pub parsed:          Vec<FileDiff>,
	pub raw_diff:        Option<String>,
	pub truncated:       bool,
	pub malformed_hunks: u32,
}
