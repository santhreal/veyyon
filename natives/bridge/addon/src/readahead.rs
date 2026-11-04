//! Opening files ahead of reading them.
//!
//! A tree search is bound by disk latency when its files are not in the page
//! cache, and the walker pool has few threads. A thread that opens a batch of
//! files and asks the system to read each one ahead before it reads the first
//! keeps the whole batch's reads in flight: the disk serves
//! [`PREFETCH_BATCH`] requests per thread at once instead of one.

use std::{fs::File, io, path::Path};

/// Files a search thread opens, and asks the system to read ahead, before it
/// reads the first of them.
pub const PREFETCH_BATCH: usize = 32;

/// Open `path` and ask the system to start reading it into the page cache
/// without waiting for it: its first `len` bytes, or the whole file when `len`
/// is `None`. A read that takes less than the whole file passes its length, so
/// a large file is not read in past what the read uses.
///
/// The advice changes no result: when it fails, the read that follows waits
/// for the disk as it would have.
pub fn open_ahead(path: &Path, len: Option<u64>) -> io::Result<File> {
	let file = File::open(path)?;
	#[cfg(target_os = "linux")]
	advise_will_read(&file, 0, len);
	#[cfg(not(target_os = "linux"))]
	let _ = len;
	Ok(file)
}

/// Ask the system to start reading `len` bytes of `file` from `offset` into
/// the page cache without waiting for them. Like [`open_ahead`]'s advice, it
/// changes no result.
pub fn read_ahead(file: &File, offset: u64, len: u64) {
	#[cfg(target_os = "linux")]
	advise_will_read(file, offset, Some(len));
	#[cfg(not(target_os = "linux"))]
	let _ = (file, offset, len);
}

#[cfg(target_os = "linux")]
fn advise_will_read(file: &File, offset: u64, len: Option<u64>) {
	use std::os::fd::AsRawFd;
	// `posix_fadvise` reads a length of zero as "to the end of the file", so a
	// read of nothing asks for nothing.
	let len = match len {
		Some(0) => return,
		Some(len) => libc::off_t::try_from(len).unwrap_or(libc::off_t::MAX),
		None => 0,
	};
	let offset = libc::off_t::try_from(offset).unwrap_or(libc::off_t::MAX);
	// SAFETY: `file` holds the descriptor open for the call, and the advice reads
	// and writes no memory of this process.
	unsafe {
		libc::posix_fadvise(file.as_raw_fd(), offset, len, libc::POSIX_FADV_WILLNEED);
	}
}
