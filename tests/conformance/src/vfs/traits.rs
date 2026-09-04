//! Narrow filesystem trait and metadata types for virtual execution.

use serde::{Deserialize, Serialize};

use super::{error::VfsResult, path::VfsPath};

/// File type enumeration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum VfsFileType {
	/// Regular file holding byte content.
	File,
	/// Directory containing child entries.
	Directory,
}

impl VfsFileType {
	/// Whether this is a regular file.
	#[must_use]
	pub const fn is_file(self) -> bool {
		matches!(self, Self::File)
	}

	/// Whether this is a directory.
	#[must_use]
	pub const fn is_dir(self) -> bool {
		matches!(self, Self::Directory)
	}
}

/// Metadata attributes for a virtual filesystem entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VfsMetadata {
	/// Type of the filesystem entity.
	pub file_type: VfsFileType,
	/// Size of the file in bytes (0 for directories).
	pub len:       u64,
	/// Whether the file is read-only.
	pub readonly:  bool,
}

impl VfsMetadata {
	/// Constructs file metadata with specified byte length.
	#[must_use]
	pub const fn file(len: u64) -> Self {
		Self { file_type: VfsFileType::File, len, readonly: false }
	}

	/// Constructs directory metadata.
	#[must_use]
	pub const fn directory() -> Self {
		Self { file_type: VfsFileType::Directory, len: 0, readonly: false }
	}

	/// Whether the entry is a regular file.
	#[must_use]
	pub const fn is_file(&self) -> bool {
		self.file_type.is_file()
	}

	/// Whether the entry is a directory.
	#[must_use]
	pub const fn is_dir(&self) -> bool {
		self.file_type.is_dir()
	}

	/// Returns file size in bytes.
	#[must_use]
	pub const fn len(&self) -> u64 {
		self.len
	}

	/// Whether the file has zero length.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.len == 0
	}
}

/// A directory entry returned by [`FileSystem::read_dir`].
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct VfsDirEntry {
	/// Full virtual path to the entry.
	pub path:      VfsPath,
	/// Entry name within parent directory.
	pub name:      String,
	/// File type of the entry.
	pub file_type: VfsFileType,
}

/// The narrow virtual filesystem interface required by conformance test cases.
///
/// Every method in this trait is justified by the needs of conformance
/// execution and migrated production components:
/// - `read`: Inspects fixture inputs, configurations, persisted states, and
///   reports.
/// - `write`: Creates or truncates files for tool outputs, test state setup,
///   and reports.
/// - `append`: Streams incremental log outputs and tool results to transcript
///   files.
/// - `metadata`: Queries file attributes (size and type) for traversal guards
///   and quota checks.
/// - `create_dir_all`: Ensures required directory hierarchies exist prior to
///   writing nested paths.
/// - `read_dir`: Discovers directory contents for glob matching, scanning, and
///   assertions.
/// - `remove_file`: Removes obsolete files and prepares atomic replacement
///   targets.
/// - `remove_dir_all`: Cleans up temporary subtrees and workspace directories.
/// - `rename`: Moves files/directories atomically, simulating safe file
///   replacements.
/// - `exists`: Fast check for entity existence without allocating metadata or
///   error paths.
pub trait FileSystem: Send + Sync {
	/// Reads the entire contents of a file at `path`.
	///
	/// # Errors
	/// - Returns [`VfsError::NotFound`] if the file does not exist.
	/// - Returns [`VfsError::IsADirectory`] if `path` names a directory.
	/// - Returns [`VfsError::PathEscapesRoot`] if path traversal escapes root.
	fn read(&self, path: &VfsPath) -> VfsResult<Vec<u8>>;

	/// Writes `data` to `path`, creating the file if missing or truncating it if
	/// present.
	///
	/// Returns the number of bytes successfully persisted. Under standard
	/// execution this equals `data.len()`; under fault injection (e.g. partial
	/// write) fewer bytes may be returned.
	///
	/// # Errors
	/// - Returns [`VfsError::NotFound`] if parent directory does not exist.
	/// - Returns [`VfsError::IsADirectory`] if `path` is an existing directory.
	/// - Returns [`VfsError::NoSpace`] if virtual storage space is exhausted.
	/// - Returns [`VfsError::AccessDenied`] if write access is denied.
	fn write(&mut self, path: &VfsPath, data: &[u8]) -> VfsResult<usize>;

	/// Appends `data` to the file at `path`, creating it if it does not exist.
	///
	/// Returns the number of bytes appended.
	///
	/// # Errors
	/// - Returns [`VfsError::NotFound`] if parent directory does not exist.
	/// - Returns [`VfsError::IsADirectory`] if `path` is an existing directory.
	/// - Returns [`VfsError::NoSpace`] if virtual storage space is exhausted.
	/// - Returns [`VfsError::AccessDenied`] if write access is denied.
	fn append(&mut self, path: &VfsPath, data: &[u8]) -> VfsResult<usize>;

	/// Retrieves metadata for the entity at `path`.
	///
	/// # Errors
	/// - Returns [`VfsError::NotFound`] if entity does not exist.
	fn metadata(&self, path: &VfsPath) -> VfsResult<VfsMetadata>;

	/// Recursively creates a directory and all missing parent directories.
	///
	/// # Errors
	/// - Returns [`VfsError::AlreadyExists`] or [`VfsError::NotADirectory`] if
	///   an intermediate component is an existing regular file.
	fn create_dir_all(&mut self, path: &VfsPath) -> VfsResult<()>;

	/// Returns a list of all entries contained directly within directory `path`.
	///
	/// # Errors
	/// - Returns [`VfsError::NotFound`] if `path` does not exist.
	/// - Returns [`VfsError::NotADirectory`] if `path` is not a directory.
	fn read_dir(&self, path: &VfsPath) -> VfsResult<Vec<VfsDirEntry>>;

	/// Removes the single file at `path`.
	///
	/// # Errors
	/// - Returns [`VfsError::NotFound`] if `path` does not exist.
	/// - Returns [`VfsError::IsADirectory`] if `path` is a directory.
	fn remove_file(&mut self, path: &VfsPath) -> VfsResult<()>;

	/// Recursively removes directory at `path` and all of its contents.
	///
	/// # Errors
	/// - Returns [`VfsError::NotFound`] if `path` does not exist.
	/// - Returns [`VfsError::NotADirectory`] if `path` is not a directory.
	fn remove_dir_all(&mut self, path: &VfsPath) -> VfsResult<()>;

	/// Renames `from` to `to`, moving files or subtrees.
	///
	/// # Errors
	/// - Returns [`VfsError::NotFound`] if `from` does not exist or parent of
	///   `to` does not exist.
	/// - Returns [`VfsError::IsADirectory`] if `from` is a file but `to` is an
	///   existing directory.
	/// - Returns [`VfsError::NotADirectory`] if `from` is a directory but `to`
	///   is an existing file.
	fn rename(&mut self, from: &VfsPath, to: &VfsPath) -> VfsResult<()>;

	/// Returns `true` if an entity exists at `path`.
	fn exists(&self, path: &VfsPath) -> bool {
		self.metadata(path).is_ok()
	}
}
