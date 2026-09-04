//! Typed error definitions for virtual filesystem operations.

use std::{fmt, io};

use serde::{Deserialize, Serialize};

/// Result alias for virtual filesystem operations.
pub type VfsResult<T> = Result<T, VfsError>;

/// Concrete error conditions produced by virtual filesystem implementations and
/// fault injectors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum VfsError {
	/// A requested file or directory path was not found.
	NotFound { path: String },
	/// An entity already exists at the target path.
	AlreadyExists { path: String },
	/// The path is not a directory where a directory was required.
	NotADirectory { path: String },
	/// The path is a directory where a file was required.
	IsADirectory { path: String },
	/// The directory is not empty and cannot be removed without recursion.
	DirectoryNotEmpty { path: String },
	/// Path traversal attempted to navigate above the root (`/`), escaping
	/// the virtual filesystem sandbox.
	PathEscapesRoot { path: String },
	/// Generic input/output fault (`EIO`).
	IoFault { path: String, message: String },
	/// Virtual disk space exhausted (`ENOSPC`).
	NoSpace { path: String },
	/// Access denied by injected permission fault (`EACCES`).
	AccessDenied { path: String },
	/// Partial write failure where only a prefix was persisted.
	PartialWrite { path: String, bytes_written: usize, bytes_requested: usize },
	/// Torn write failure where data was written with corruption or
	/// half-applied.
	TornWrite { path: String, bytes_written: usize, detail: String },
	/// Content-addressed fixture verification failed due to digest mismatch.
	FixtureDigestMismatch { expected: String, actual: String },
	/// Fixture payload serialization or structure error.
	InvalidFixturePayload { detail: String },
}

impl fmt::Display for VfsError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::NotFound { path } => write!(f, "entity not found at path: `{path}`"),
			Self::AlreadyExists { path } => write!(f, "entity already exists at path: `{path}`"),
			Self::NotADirectory { path } => write!(f, "not a directory: `{path}`"),
			Self::IsADirectory { path } => write!(f, "is a directory: `{path}`"),
			Self::DirectoryNotEmpty { path } => write!(f, "directory is not empty: `{path}`"),
			Self::PathEscapesRoot { path } => {
				write!(f, "path traversal escapes virtual root: `{path}`")
			},
			Self::IoFault { path, message } => {
				write!(f, "simulated I/O fault at `{path}`: {message}")
			},
			Self::NoSpace { path } => {
				write!(f, "virtual storage space exhausted (ENOSPC) at `{path}`")
			},
			Self::AccessDenied { path } => {
				write!(f, "access denied by fault injector (EACCES) at `{path}`")
			},
			Self::PartialWrite { path, bytes_written, bytes_requested } => {
				write!(f, "partial write at `{path}`: wrote {bytes_written} of {bytes_requested} bytes")
			},
			Self::TornWrite { path, bytes_written, detail } => {
				write!(f, "torn write at `{path}` ({bytes_written} bytes): {detail}")
			},
			Self::FixtureDigestMismatch { expected, actual } => {
				write!(f, "fixture digest mismatch: expected `{expected}`, actual `{actual}`")
			},
			Self::InvalidFixturePayload { detail } => {
				write!(f, "invalid fixture payload: {detail}")
			},
		}
	}
}

impl std::error::Error for VfsError {}

impl From<VfsError> for io::Error {
	fn from(err: VfsError) -> Self {
		match err {
			VfsError::NotFound { ref path } => Self::new(io::ErrorKind::NotFound, path.clone()),
			VfsError::AlreadyExists { ref path } => {
				Self::new(io::ErrorKind::AlreadyExists, path.clone())
			},
			VfsError::NotADirectory { ref path } => {
				Self::new(io::ErrorKind::InvalidInput, format!("not a directory: {path}"))
			},
			VfsError::IsADirectory { ref path } => {
				Self::new(io::ErrorKind::InvalidInput, format!("is a directory: {path}"))
			},
			VfsError::DirectoryNotEmpty { ref path } => {
				Self::other(format!("directory not empty: {path}"))
			},
			VfsError::PathEscapesRoot { ref path } => {
				Self::new(io::ErrorKind::PermissionDenied, format!("path escapes root: {path}"))
			},
			VfsError::IoFault { ref message, .. } => Self::other(message.clone()),
			VfsError::NoSpace { ref path } => {
				Self::new(io::ErrorKind::StorageFull, format!("storage full: {path}"))
			},
			VfsError::AccessDenied { ref path } => {
				Self::new(io::ErrorKind::PermissionDenied, format!("permission denied: {path}"))
			},
			VfsError::PartialWrite { ref path, bytes_written, bytes_requested } => Self::new(
				io::ErrorKind::WriteZero,
				format!("partial write at {path}: {bytes_written}/{bytes_requested}"),
			),
			VfsError::TornWrite { ref path, ref detail, .. } => {
				Self::other(format!("torn write at {path}: {detail}"))
			},
			VfsError::FixtureDigestMismatch { ref expected, ref actual } => Self::new(
				io::ErrorKind::InvalidData,
				format!("digest mismatch: expected {expected}, got {actual}"),
			),
			VfsError::InvalidFixturePayload { ref detail } => {
				Self::new(io::ErrorKind::InvalidData, detail.clone())
			},
		}
	}
}
