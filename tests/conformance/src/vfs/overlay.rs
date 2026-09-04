//! Copy-on-write overlay filesystem providing shard and case isolation.

use std::{
	collections::{BTreeMap, BTreeSet},
	sync::Arc,
};

use super::{
	error::{VfsError, VfsResult},
	memory::MemoryFs,
	path::VfsPath,
	traits::{FileSystem, VfsDirEntry, VfsMetadata},
};

/// A copy-on-write virtual filesystem overlay.
///
/// An `Overlay` wraps a shared, immutable base [`MemoryFs`] (or another layer)
/// via an [`Arc`], ensuring multiple overlays can share large fixture trees
/// without allocating copies of file payloads.
///
/// All mutations (file writes, directory creations, removals, renames) are
/// captured in the local `upper` layer or recorded as `whiteouts`. The `base`
/// is never mutated, and mutations are strictly invisible to sibling overlays.
#[derive(Debug, Clone)]
pub struct Overlay {
	base:     Arc<MemoryFs>,
	upper:    MemoryFs,
	whiteout: BTreeSet<VfsPath>,
}

impl Overlay {
	/// Creates a new copy-on-write overlay over a shared `base` tree.
	#[must_use]
	pub const fn new(base: Arc<MemoryFs>) -> Self {
		Self { base, upper: MemoryFs::new(), whiteout: BTreeSet::new() }
	}

	/// Returns a reference to the shared base tree.
	#[must_use]
	pub const fn base(&self) -> &Arc<MemoryFs> {
		&self.base
	}

	/// Returns the raw pointer of the base [`MemoryFs`], enabling tests to
	/// verify reference identity and guarantee zero-copy sharing.
	#[must_use]
	pub fn base_ptr(&self) -> *const MemoryFs {
		Arc::as_ptr(&self.base)
	}

	/// Helper to check if a path or any of its ancestors is shadowed by a
	/// whiteout.
	fn is_whiteout(&self, path: &VfsPath) -> bool {
		if self.whiteout.contains(path) {
			return true;
		}
		let mut current = path.parent();
		while let Some(parent) = current {
			if self.whiteout.contains(&parent) {
				return true;
			}
			current = parent.parent();
		}
		false
	}

	/// Clears whiteouts for `path` and any of its ancestor directories so new
	/// writes can succeed.
	fn clear_whiteouts_for_path(&mut self, path: &VfsPath) {
		self.whiteout.remove(path);
		let mut current = path.parent();
		while let Some(parent) = current {
			self.whiteout.remove(&parent);
			current = parent.parent();
		}
	}
}

impl FileSystem for Overlay {
	fn read(&self, path: &VfsPath) -> VfsResult<Vec<u8>> {
		if self.is_whiteout(path) {
			return Err(VfsError::NotFound { path: path.as_str().to_owned() });
		}
		if self.upper.exists(path) {
			return self.upper.read(path);
		}
		self.base.read(path)
	}

	fn write(&mut self, path: &VfsPath, data: &[u8]) -> VfsResult<usize> {
		self.clear_whiteouts_for_path(path);
		// Ensure parent directory exists in upper layer if it exists in base
		if let Some(parent) = path.parent()
			&& !parent.is_root()
			&& !self.upper.exists(&parent)
			&& self.base.exists(&parent)
			&& !self.is_whiteout(&parent)
		{
			self.upper.create_dir_all(&parent)?;
		}
		self.upper.write(path, data)
	}

	fn append(&mut self, path: &VfsPath, data: &[u8]) -> VfsResult<usize> {
		if self.is_whiteout(path) {
			self.clear_whiteouts_for_path(path);
			return self.write(path, data);
		}
		if self.upper.exists(path) {
			return self.upper.append(path, data);
		}
		if self.base.exists(path) {
			// Copy-on-write: load from base, append, and persist into upper
			let mut existing = self.base.read(path)?;
			existing.extend_from_slice(data);
			self.write(path, &existing)?;
			return Ok(data.len());
		}
		self.write(path, data)
	}

	fn metadata(&self, path: &VfsPath) -> VfsResult<VfsMetadata> {
		if self.is_whiteout(path) {
			return Err(VfsError::NotFound { path: path.as_str().to_owned() });
		}
		if self.upper.exists(path) {
			return self.upper.metadata(path);
		}
		self.base.metadata(path)
	}

	fn create_dir_all(&mut self, path: &VfsPath) -> VfsResult<()> {
		self.clear_whiteouts_for_path(path);
		self.upper.create_dir_all(path)
	}

	fn read_dir(&self, path: &VfsPath) -> VfsResult<Vec<VfsDirEntry>> {
		if self.is_whiteout(path) {
			return Err(VfsError::NotFound { path: path.as_str().to_owned() });
		}

		let upper_exists = self.upper.exists(path);
		let base_exists = self.base.exists(path);

		if !upper_exists && !base_exists {
			return Err(VfsError::NotFound { path: path.as_str().to_owned() });
		}

		let mut merged: BTreeMap<String, VfsDirEntry> = BTreeMap::new();

		// Read base entries first if present
		if base_exists
			&& self.base.metadata(path)?.is_dir()
			&& let Ok(base_entries) = self.base.read_dir(path)
		{
			for entry in base_entries {
				if !self.is_whiteout(&entry.path) {
					merged.insert(entry.name.clone(), entry);
				}
			}
		}

		// Overlay upper entries
		if upper_exists && self.upper.metadata(path)?.is_dir() {
			let upper_entries = self.upper.read_dir(path)?;
			for entry in upper_entries {
				merged.insert(entry.name.clone(), entry);
			}
		}

		Ok(merged.into_values().collect())
	}

	fn remove_file(&mut self, path: &VfsPath) -> VfsResult<()> {
		if self.is_whiteout(path) {
			return Err(VfsError::NotFound { path: path.as_str().to_owned() });
		}
		let upper_exists = self.upper.exists(path);
		let base_exists = self.base.exists(path);

		if !upper_exists && !base_exists {
			return Err(VfsError::NotFound { path: path.as_str().to_owned() });
		}

		let is_dir = if upper_exists {
			self.upper.metadata(path)?.is_dir()
		} else {
			self.base.metadata(path)?.is_dir()
		};

		if is_dir {
			return Err(VfsError::IsADirectory { path: path.as_str().to_owned() });
		}

		if upper_exists {
			self.upper.remove_file(path)?;
		}
		if base_exists {
			self.whiteout.insert(path.clone());
		}
		Ok(())
	}

	fn remove_dir_all(&mut self, path: &VfsPath) -> VfsResult<()> {
		if self.is_whiteout(path) {
			return Err(VfsError::NotFound { path: path.as_str().to_owned() });
		}
		let upper_exists = self.upper.exists(path);
		let base_exists = self.base.exists(path);

		if !upper_exists && !base_exists {
			return Err(VfsError::NotFound { path: path.as_str().to_owned() });
		}

		if upper_exists {
			self.upper.remove_dir_all(path)?;
		}
		if base_exists {
			self.whiteout.insert(path.clone());
		}
		Ok(())
	}

	fn rename(&mut self, from: &VfsPath, to: &VfsPath) -> VfsResult<()> {
		if self.is_whiteout(from) {
			return Err(VfsError::NotFound { path: from.as_str().to_owned() });
		}
		let meta = self.metadata(from)?;
		if meta.is_file() {
			let data = self.read(from)?;
			self.write(to, &data)?;
			self.remove_file(from)?;
		} else {
			// For directory rename, recursively copy and remove
			self.create_dir_all(to)?;
			let entries = self.read_dir(from)?;
			for entry in entries {
				let child_to = to.join(&entry.name)?;
				self.rename(&entry.path, &child_to)?;
			}
			self.remove_dir_all(from)?;
		}
		Ok(())
	}
}
