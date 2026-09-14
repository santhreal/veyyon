//! Socket fixtures retain workspace-local scratch storage while keeping the
//! address passed to the kernel independent of checkout path length on Linux.

#[cfg(target_os = "linux")]
use std::{fs::File, os::fd::AsRawFd};
use std::{
	ops::Deref,
	path::{Path, PathBuf},
};

use veyyon_test_scratch::TempTree;

pub struct SocketTree {
	_tree:      TempTree,
	path:       PathBuf,
	#[cfg(target_os = "linux")]
	_directory: File,
}

impl SocketTree {
	pub fn path(&self) -> &Path {
		&self.path
	}
}

impl Deref for SocketTree {
	type Target = Path;

	fn deref(&self) -> &Path {
		self.path()
	}
}

impl AsRef<Path> for SocketTree {
	fn as_ref(&self) -> &Path {
		self.path()
	}
}

pub fn scratch_dir(label: &str) -> SocketTree {
	let tree = veyyon_test_scratch::scratch_dir(label);
	#[cfg(target_os = "linux")]
	{
		let directory = File::open(tree.path()).expect("open owned scratch directory");
		// The parent's descriptor remains open across child probes. Unlike
		// /proc/self/fd, this address means the same directory in every process.
		let path =
			PathBuf::from(format!("/proc/{}/fd/{}", std::process::id(), directory.as_raw_fd()));
		assert_eq!(
			path.canonicalize().expect("descriptor directory"),
			tree.path().canonicalize().expect("scratch directory")
		);
		SocketTree { _tree: tree, path, _directory: directory }
	}
	#[cfg(not(target_os = "linux"))]
	{
		let path = tree.path().to_path_buf();
		SocketTree { _tree: tree, path }
	}
}
