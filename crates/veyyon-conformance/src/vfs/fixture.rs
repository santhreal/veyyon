//! Content-addressed fixture tree population and digest verification.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::{
	error::{VfsError, VfsResult},
	path::VfsPath,
	traits::FileSystem,
};
use crate::corpus::FixtureRef;

/// A structured representation of a filesystem fixture tree.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FixtureTree {
	/// Explicit directories to create.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub directories: Vec<String>,
	/// Map of normalized virtual path string to byte content.
	#[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
	pub files:       BTreeMap<String, Vec<u8>>,
}

impl FixtureTree {
	/// Creates a new, empty fixture tree.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Adds an explicit directory path to the fixture.
	pub fn add_dir(&mut self, path: impl Into<String>) {
		self.directories.push(path.into());
	}

	/// Adds a file entry with byte contents to the fixture.
	pub fn add_file(&mut self, path: impl Into<String>, data: impl Into<Vec<u8>>) {
		self.files.insert(path.into(), data.into());
	}

	/// Serializes the fixture tree to canonical JSON bytes.
	///
	/// # Errors
	/// Returns [`VfsError::InvalidFixturePayload`] if serialization fails.
	pub fn to_bytes(&self) -> VfsResult<Vec<u8>> {
		serde_json::to_vec(self)
			.map_err(|e| VfsError::InvalidFixturePayload { detail: e.to_string() })
	}

	/// Computes the [`FixtureRef`] for this tree's canonical serialization.
	///
	/// # Errors
	/// Returns [`VfsError::InvalidFixturePayload`] if serialization fails.
	pub fn fixture_ref(&self) -> VfsResult<FixtureRef> {
		let bytes = self.to_bytes()?;
		Ok(FixtureRef::of(&bytes))
	}

	/// Deserializes a fixture tree from raw bytes.
	///
	/// # Errors
	/// Returns [`VfsError::InvalidFixturePayload`] if JSON decoding fails.
	pub fn from_bytes(bytes: &[u8]) -> VfsResult<Self> {
		serde_json::from_slice(bytes)
			.map_err(|e| VfsError::InvalidFixturePayload { detail: e.to_string() })
	}
}

/// Populates a [`FileSystem`] from a content-addressed fixture, verifying
/// digest integrity.
///
/// # Errors
/// - Returns [`VfsError::FixtureDigestMismatch`] if the BLAKE3 digest of
///   `bytes` does not match `fixture_ref`.
/// - Returns [`VfsError::InvalidFixturePayload`] if `bytes` cannot be
///   deserialized as a [`FixtureTree`].
/// - Returns filesystem errors if creating paths or writing files fails.
pub fn populate_from_fixture(
	fs: &mut impl FileSystem,
	fixture_ref: &FixtureRef,
	bytes: &[u8],
) -> VfsResult<()> {
	let computed = FixtureRef::of(bytes);
	if computed.as_str() != fixture_ref.as_str() {
		return Err(VfsError::FixtureDigestMismatch {
			expected: fixture_ref.as_str().to_owned(),
			actual:   computed.as_str().to_owned(),
		});
	}

	let tree = FixtureTree::from_bytes(bytes)?;

	// Create directories
	for dir_str in &tree.directories {
		let vpath = VfsPath::new(dir_str)?;
		fs.create_dir_all(&vpath)?;
	}

	// Create files
	for (path_str, data) in &tree.files {
		let vpath = VfsPath::new(path_str)?;
		if let Some(parent) = vpath.parent()
			&& !parent.is_root()
		{
			fs.create_dir_all(&parent)?;
		}
		fs.write(&vpath, data)?;
	}

	Ok(())
}
