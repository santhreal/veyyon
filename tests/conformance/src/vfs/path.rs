//! Normalized virtual filesystem paths with root-escape refusal.

use std::{
	borrow::Borrow,
	fmt,
	ops::Deref,
	path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::error::{VfsError, VfsResult};

/// An absolute, normalized virtual filesystem path.
///
/// Every `VfsPath` is guaranteed to start with `/` and be strictly confined
/// within the virtual filesystem root. Any path traversal attempting to
/// navigate above `/` (via `..` or relative parent navigation) is refused with
/// [`VfsError::PathEscapesRoot`].
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct VfsPath(String);

impl VfsPath {
	/// Creates a new `VfsPath` from a string or path slice, normalizing all
	/// components (`.`, `..`, duplicate and trailing separators).
	///
	/// # Errors
	/// Returns [`VfsError::PathEscapesRoot`] if any component escapes above the
	/// root `/`.
	pub fn new(raw: &str) -> VfsResult<Self> {
		let normalized = normalize_virtual_path(raw)?;
		Ok(Self(normalized))
	}

	/// The root virtual path (`/`).
	#[must_use]
	pub const fn root() -> Self {
		Self(String::new()) // represented internally as empty components or "/"
	}

	/// Returns the normalized path as a string slice (guaranteed to begin with
	/// `/`).
	#[must_use]
	pub fn as_str(&self) -> &str {
		if self.0.is_empty() { "/" } else { &self.0 }
	}

	/// Whether this path represents the virtual root (`/`).
	#[must_use]
	pub fn is_root(&self) -> bool {
		self.0.is_empty() || self.0 == "/"
	}

	/// Returns the parent path, or `None` if this path is the root.
	#[must_use]
	pub fn parent(&self) -> Option<Self> {
		if self.is_root() {
			return None;
		}
		let s = self.as_str();
		match s.rfind('/') {
			Some(0) => Some(Self::root()),
			Some(idx) => Some(Self(s[..idx].to_owned())),
			None => None,
		}
	}

	/// Returns the final component (file or directory name), or `None` if root.
	#[must_use]
	pub fn file_name(&self) -> Option<&str> {
		if self.is_root() {
			return None;
		}
		let s = self.as_str();
		s.rsplit('/').next().filter(|comp| !comp.is_empty())
	}

	/// Joins a child path to this path, normalizing the resulting path.
	///
	/// # Errors
	/// Returns [`VfsError::PathEscapesRoot`] if the joined components escape
	/// above the root.
	pub fn join(&self, child: &str) -> VfsResult<Self> {
		let base = self.as_str();
		let joined = if child.starts_with('/') || child.starts_with('\\') {
			child.to_owned()
		} else if base == "/" {
			format!("/{child}")
		} else {
			format!("{base}/{child}")
		};
		Self::new(&joined)
	}

	/// Returns an iterator over the non-empty path components (excluding the
	/// leading `/`).
	pub fn components(&self) -> impl Iterator<Item = &str> {
		let s = self.as_str();
		s.split('/').filter(|comp| !comp.is_empty())
	}
}

/// Normalizes a path string, converting backslashes to slashes, resolving `.`
/// and `..`, and checking for sandbox escapes.
fn normalize_virtual_path(raw: &str) -> VfsResult<String> {
	let mut stack: Vec<&str> = Vec::new();

	for part in raw.split(['/', '\\']) {
		match part {
			"" | "." => {
				// Ignore empty parts and current-directory references.
			},
			".." => {
				if stack.pop().is_none() {
					return Err(VfsError::PathEscapesRoot { path: raw.to_owned() });
				}
			},
			component => {
				stack.push(component);
			},
		}
	}

	if stack.is_empty() {
		Ok("/".to_owned())
	} else {
		let mut result = String::with_capacity(stack.iter().map(|s| s.len() + 1).sum::<usize>());
		for comp in stack {
			result.push('/');
			result.push_str(comp);
		}
		Ok(result)
	}
}

impl fmt::Debug for VfsPath {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "VfsPath(\"{}\")", self.as_str())
	}
}

impl fmt::Display for VfsPath {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(self.as_str())
	}
}

impl Deref for VfsPath {
	type Target = str;

	fn deref(&self) -> &Self::Target {
		self.as_str()
	}
}

impl AsRef<str> for VfsPath {
	fn as_ref(&self) -> &str {
		self.as_str()
	}
}

impl AsRef<Path> for VfsPath {
	fn as_ref(&self) -> &Path {
		Path::new(self.as_str())
	}
}

impl Borrow<str> for VfsPath {
	fn borrow(&self) -> &str {
		self.as_str()
	}
}

impl From<VfsPath> for PathBuf {
	fn from(p: VfsPath) -> Self {
		Self::from(p.as_str())
	}
}

impl TryFrom<&str> for VfsPath {
	type Error = VfsError;

	fn try_from(value: &str) -> Result<Self, Self::Error> {
		Self::new(value)
	}
}

impl TryFrom<String> for VfsPath {
	type Error = VfsError;

	fn try_from(value: String) -> Result<Self, Self::Error> {
		Self::new(&value)
	}
}
