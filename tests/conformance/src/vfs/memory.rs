//! In-memory virtual filesystem tree implementation.

use std::collections::BTreeMap;

use super::{
	error::{VfsError, VfsResult},
	path::VfsPath,
	traits::{FileSystem, VfsDirEntry, VfsFileType, VfsMetadata},
};

/// An in-memory node representing either a file or a directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MemoryNode {
	File { data: Vec<u8> },
	Directory { children: BTreeMap<String, Self> },
}
impl MemoryNode {
	#[must_use]
	pub(crate) const fn new_directory() -> Self {
		Self::Directory { children: BTreeMap::new() }
	}

	#[must_use]
	pub(crate) const fn new_file(data: Vec<u8>) -> Self {
		Self::File { data }
	}

	#[must_use]
	pub(crate) const fn is_file(&self) -> bool {
		matches!(self, Self::File { .. })
	}

	#[must_use]
	pub(crate) const fn is_dir(&self) -> bool {
		matches!(self, Self::Directory { .. })
	}
}

/// A purely in-memory, thread-safe virtual filesystem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryFs {
	root: MemoryNode,
}

impl Default for MemoryFs {
	fn default() -> Self {
		Self::new()
	}
}

impl MemoryFs {
	/// Creates an empty in-memory filesystem with a root directory.
	#[must_use]
	pub const fn new() -> Self {
		Self { root: MemoryNode::new_directory() }
	}

	/// Helper to find a reference to a node at `path`.
	pub(crate) fn find_node(&self, path: &VfsPath) -> Option<&MemoryNode> {
		if path.is_root() {
			return Some(&self.root);
		}
		let mut current = &self.root;
		for comp in path.components() {
			match current {
				MemoryNode::Directory { children } => {
					current = children.get(comp)?;
				},
				MemoryNode::File { .. } => return None,
			}
		}
		Some(current)
	}

	/// Helper to navigate to parent directory of `path` and return mutable
	/// access to children.
	fn find_parent_and_name_mut<'a>(
		&'a mut self,
		path: &VfsPath,
	) -> VfsResult<(&'a mut BTreeMap<String, MemoryNode>, String)> {
		if path.is_root() {
			return Err(VfsError::AlreadyExists { path: path.as_str().to_owned() });
		}
		let file_name = path
			.file_name()
			.ok_or_else(|| VfsError::NotFound { path: path.as_str().to_owned() })?
			.to_owned();

		let mut current = &mut self.root;
		let parent_path = path.parent().unwrap_or_else(VfsPath::root);

		for comp in parent_path.components() {
			let path_so_far = comp.to_owned();
			match current {
				MemoryNode::Directory { children } => {
					current = children
						.get_mut(comp)
						.ok_or_else(|| VfsError::NotFound { path: path.as_str().to_owned() })?;
				},
				MemoryNode::File { .. } => {
					return Err(VfsError::NotADirectory { path: path_so_far });
				},
			}
		}

		match current {
			MemoryNode::Directory { children } => Ok((children, file_name)),
			MemoryNode::File { .. } => Err(VfsError::NotADirectory { path: parent_path.to_string() }),
		}
	}
}

impl FileSystem for MemoryFs {
	fn read(&self, path: &VfsPath) -> VfsResult<Vec<u8>> {
		let node = self
			.find_node(path)
			.ok_or_else(|| VfsError::NotFound { path: path.as_str().to_owned() })?;
		match node {
			MemoryNode::File { data } => Ok(data.clone()),
			MemoryNode::Directory { .. } => {
				Err(VfsError::IsADirectory { path: path.as_str().to_owned() })
			},
		}
	}

	fn write(&mut self, path: &VfsPath, data: &[u8]) -> VfsResult<usize> {
		if path.is_root() {
			return Err(VfsError::IsADirectory { path: path.as_str().to_owned() });
		}
		let (children, name) = self.find_parent_and_name_mut(path)?;
		if let Some(existing) = children.get(&name)
			&& existing.is_dir()
		{
			return Err(VfsError::IsADirectory { path: path.as_str().to_owned() });
		}
		children.insert(name, MemoryNode::new_file(data.to_vec()));
		Ok(data.len())
	}

	fn append(&mut self, path: &VfsPath, data: &[u8]) -> VfsResult<usize> {
		if path.is_root() {
			return Err(VfsError::IsADirectory { path: path.as_str().to_owned() });
		}
		let (children, name) = self.find_parent_and_name_mut(path)?;
		if let Some(existing) = children.get_mut(&name) {
			match existing {
				MemoryNode::File { data: existing_data } => {
					existing_data.extend_from_slice(data);
					Ok(data.len())
				},
				MemoryNode::Directory { .. } => {
					Err(VfsError::IsADirectory { path: path.as_str().to_owned() })
				},
			}
		} else {
			children.insert(name, MemoryNode::new_file(data.to_vec()));
			Ok(data.len())
		}
	}

	fn metadata(&self, path: &VfsPath) -> VfsResult<VfsMetadata> {
		let node = self
			.find_node(path)
			.ok_or_else(|| VfsError::NotFound { path: path.as_str().to_owned() })?;
		match node {
			MemoryNode::File { data } => Ok(VfsMetadata::file(data.len() as u64)),
			MemoryNode::Directory { .. } => Ok(VfsMetadata::directory()),
		}
	}

	fn create_dir_all(&mut self, path: &VfsPath) -> VfsResult<()> {
		if path.is_root() {
			return Ok(());
		}
		let mut current = &mut self.root;
		for comp in path.components() {
			match current {
				MemoryNode::Directory { children } => {
					if !children.contains_key(comp) {
						children.insert(comp.to_owned(), MemoryNode::new_directory());
					}
					let next = children.get_mut(comp).expect("inserted or exists");
					if !next.is_dir() {
						return Err(VfsError::NotADirectory { path: comp.to_owned() });
					}
					current = next;
				},
				MemoryNode::File { .. } => {
					return Err(VfsError::NotADirectory { path: path.as_str().to_owned() });
				},
			}
		}
		Ok(())
	}

	fn read_dir(&self, path: &VfsPath) -> VfsResult<Vec<VfsDirEntry>> {
		let node = self
			.find_node(path)
			.ok_or_else(|| VfsError::NotFound { path: path.as_str().to_owned() })?;
		match node {
			MemoryNode::Directory { children } => {
				let mut entries = Vec::with_capacity(children.len());
				for (name, child) in children {
					let child_path = path.join(name)?;
					let file_type = if child.is_dir() {
						VfsFileType::Directory
					} else {
						VfsFileType::File
					};
					entries.push(VfsDirEntry { path: child_path, name: name.clone(), file_type });
				}
				Ok(entries)
			},
			MemoryNode::File { .. } => Err(VfsError::NotADirectory { path: path.as_str().to_owned() }),
		}
	}

	fn remove_file(&mut self, path: &VfsPath) -> VfsResult<()> {
		if path.is_root() {
			return Err(VfsError::IsADirectory { path: "/".to_owned() });
		}
		let (children, name) = self.find_parent_and_name_mut(path)?;
		let node = children
			.get(&name)
			.ok_or_else(|| VfsError::NotFound { path: path.as_str().to_owned() })?;
		if node.is_dir() {
			return Err(VfsError::IsADirectory { path: path.as_str().to_owned() });
		}
		children.remove(&name);
		Ok(())
	}

	fn remove_dir_all(&mut self, path: &VfsPath) -> VfsResult<()> {
		if path.is_root() {
			self.root = MemoryNode::new_directory();
			return Ok(());
		}
		let (children, name) = self.find_parent_and_name_mut(path)?;
		let node = children
			.get(&name)
			.ok_or_else(|| VfsError::NotFound { path: path.as_str().to_owned() })?;
		if !node.is_dir() {
			return Err(VfsError::NotADirectory { path: path.as_str().to_owned() });
		}
		children.remove(&name);
		Ok(())
	}

	fn rename(&mut self, from: &VfsPath, to: &VfsPath) -> VfsResult<()> {
		if from.is_root() || to.is_root() {
			return Err(VfsError::AccessDenied { path: "/".to_owned() });
		}
		if from == to {
			if self.exists(from) {
				return Ok(());
			}
			return Err(VfsError::NotFound { path: from.as_str().to_owned() });
		}
		// First verify source exists
		let source_node = self
			.find_node(from)
			.ok_or_else(|| VfsError::NotFound { path: from.as_str().to_owned() })?
			.clone();

		// Check if destination exists
		if let Some(dest_node) = self.find_node(to) {
			if source_node.is_file() && dest_node.is_dir() {
				return Err(VfsError::IsADirectory { path: to.as_str().to_owned() });
			}
			if source_node.is_dir() && dest_node.is_file() {
				return Err(VfsError::NotADirectory { path: to.as_str().to_owned() });
			}
			if source_node.is_dir()
				&& let MemoryNode::Directory { children } = dest_node
				&& !children.is_empty()
			{
				return Err(VfsError::DirectoryNotEmpty { path: to.as_str().to_owned() });
			}
		}

		// Ensure parent of destination exists
		let dest_parent = to.parent().unwrap_or_else(VfsPath::root);
		if !self.exists(&dest_parent) {
			return Err(VfsError::NotFound { path: dest_parent.to_string() });
		}

		// Remove source and insert at destination
		self.remove_node_internal(from)?;
		let (dest_children, dest_name) = self.find_parent_and_name_mut(to)?;
		dest_children.insert(dest_name, source_node);
		Ok(())
	}
}

impl MemoryFs {
	fn remove_node_internal(&mut self, path: &VfsPath) -> VfsResult<MemoryNode> {
		let (children, name) = self.find_parent_and_name_mut(path)?;
		children
			.remove(&name)
			.ok_or_else(|| VfsError::NotFound { path: path.as_str().to_owned() })
	}
}
