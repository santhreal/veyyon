//! N-API filesystem DTOs and conversion helpers.
//!
//! `veyyon-walker` owns traversal and cache policy. This module keeps only the
//! JavaScript-facing shapes plus conversions between walker entries and N-API
//! payloads.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::napi_error::{to_napi, to_napi_with};

/// Resolved filesystem entry kind for glob filters and match metadata.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi]
pub enum FileType {
	/// Regular file.
	File    = 1,
	/// Directory.
	Dir     = 2,
	/// Symbolic link.
	Symlink = 3,
}

/// A single filesystem entry from a directory scan.
#[derive(Clone)]
#[napi(object)]
pub struct GlobMatch {
	/// Relative path from the search root, using forward slashes.
	pub path:      String,
	/// Resolved filesystem type for the match.
	pub file_type: FileType,
	/// Modification time in milliseconds since Unix epoch.
	pub mtime:     Option<f64>,
	/// File size in bytes for regular files.
	pub size:      Option<f64>,
}

/// Converts a native walker error into an N-API error.
///
/// The walker's two failure kinds get different treatment on purpose. An
/// interruption carries the caller's own error and nothing this crate can add,
/// while invalid data is about a specific path, so the path becomes the context
/// and the walker's message stays the reason.
pub(crate) fn map_walker_error<E: std::fmt::Display>(err: veyyon_walker::WalkError<E>) -> Error {
	match err {
		veyyon_walker::WalkError::Interrupted(err) => to_napi(err),
		veyyon_walker::WalkError::InvalidData { path, message } => {
			to_napi_with(format!("Native directory scan failed for {}", path.display()), message)
		},
	}
}

pub(crate) const fn from_walker_file_type(file_type: veyyon_walker::FileType) -> FileType {
	match file_type {
		veyyon_walker::FileType::File => FileType::File,
		veyyon_walker::FileType::Dir => FileType::Dir,
		veyyon_walker::FileType::Symlink => FileType::Symlink,
	}
}

impl From<veyyon_walker::CollectedEntry> for GlobMatch {
	fn from(entry: veyyon_walker::CollectedEntry) -> Self {
		Self {
			path:      entry.path,
			file_type: from_walker_file_type(entry.file_type),
			mtime:     entry.mtime,
			size:      entry.size,
		}
	}
}

/// Invalidate the walker scan cache.
///
/// When called with a path, removes entries for roots containing that path.
/// When called without a path, clears the entire cache.
///
/// Intended to be called after agent file mutations: write, edit, rename, or
/// delete.
#[napi]
pub fn invalidate_fs_scan_cache(path: Option<String>) {
	match path {
		Some(path) => veyyon_walker::invalidate_path_string(&path),
		None => veyyon_walker::invalidate_all(),
	}
}
