//! Free pages of the C allocator's heaps.
//!
//! Native work runs on the addon's worker threads: Rayon's global pool, the
//! walker pool, Tokio's workers and blocking pool, and the runtime's own work
//! pool. glibc gives each thread that calls `malloc` an arena of its own, up to
//! eight per core, and keeps the pages of every chunk freed in an arena mapped
//! until the top of that arena's heap is free. A search over a large tree
//! leaves most of its peak resident in the arenas of the threads that ran it:
//! four searches over a 200 000-match tree left 266 MiB resident in 36 thread
//! arenas after every result was dropped. `Bun.shrink()` releases the engine's
//! heaps and leaves the C allocator's untouched.
//!
//! [`release_free_heap_pages`] calls `malloc_trim(0)`, which walks every arena
//! and returns each whole free page to the kernel with `MADV_DONTNEED`. Live
//! allocations stay where they are; a later allocation faults fresh zeroed
//! pages back in. The same four searches drop to 54 MiB, in 11 ms.
//!
//! glibc Linux only. Elsewhere the call returns false: musl returns free pages
//! to the kernel when a chunk is freed, the macOS allocator releases emptied
//! regions on its own, and Windows heaps decommit free pages past a threshold.

use napi_derive::napi;

/// Returns the free pages of every C allocator arena to the kernel. Returns
/// true when any memory was released, and false when none was or the platform
/// allocator has no such call.
#[napi]
pub fn release_free_heap_pages() -> bool {
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	{
		// SAFETY: `malloc_trim` takes no pointers and locks each arena while it
		// walks it, so it is sound to call from any thread at any time.
		unsafe { libc::malloc_trim(0) != 0 }
	}
	#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
	{
		false
	}
}

/// Freed memory in a worker thread's arena stays resident until the release:
/// blocks below the mmap threshold come from the arena's heap, and a block
/// allocated after them keeps the heap top in use, so glibc trims none of
/// them on free. `mincore` reads the residency of the freed blocks' whole
/// pages directly, so allocation elsewhere in the process does not move it.
#[cfg(all(test, target_os = "linux", target_env = "gnu"))]
mod tests {
	use super::release_free_heap_pages;

	const BLOCK: usize = 64 * 1024;
	const BLOCKS: usize = 512;

	/// Resident and total whole pages inside each `(start, len)` range.
	fn residency(ranges: &[(usize, usize)]) -> (usize, usize) {
		// SAFETY: `sysconf` reads a constant.
		let page = usize::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).unwrap();
		let mut resident = 0;
		let mut total = 0;
		let mut vec = Vec::new();
		for &(start, len) in ranges {
			// The first page of a block holds the free chunk's header, which
			// free() writes; only the pages after it are measured.
			let first = (start + 1).next_multiple_of(page);
			let last = (start + len) / page * page;
			if last <= first {
				continue;
			}
			vec.clear();
			vec.resize((last - first) / page, 0u8);
			// SAFETY: `first..last` is page-aligned and lies inside a heap
			// mapping this process holds; `vec` has one byte per page.
			let rc =
				unsafe { libc::mincore(first as *mut libc::c_void, last - first, vec.as_mut_ptr()) };
			assert_eq!(rc, 0, "mincore failed: {}", std::io::Error::last_os_error());
			resident += vec.iter().filter(|&&flags| flags & 1 == 1).count();
			total += vec.len();
		}
		(resident, total)
	}

	#[test]
	fn the_release_returns_the_pages_a_worker_thread_freed() {
		std::thread::spawn(|| {
			let blocks: Vec<Vec<u8>> = (0..BLOCKS).map(|_| vec![1u8; BLOCK]).collect();
			let pin = vec![1u8; BLOCK];
			let ranges: Vec<(usize, usize)> = blocks
				.iter()
				.map(|b| (b.as_ptr() as usize, b.len()))
				.collect();
			drop(blocks);

			let (before, total) = residency(&ranges);
			assert!(total > BLOCKS * 8, "measured {total} pages of {BLOCKS} freed blocks");
			assert!(
				before * 10 >= total * 9,
				"freed blocks must stay resident before the release: {before} of {total} pages"
			);

			assert!(release_free_heap_pages(), "the release reported nothing released");
			let (after, total) = residency(&ranges);
			assert!(
				after * 10 <= total,
				"freed blocks stayed resident after the release: {after} of {total} pages"
			);
			drop(pin);
		})
		.join()
		.unwrap();
	}
}
