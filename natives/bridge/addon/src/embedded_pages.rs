//! Resident pages of the executable's embedded module graph.
//!
//! A compiled veyyon binary contains its JavaScript sources and their bytecode
//! in the `.bun` ELF section, mapped from the executable file. Loading a module
//! reads that module's bytecode, so every module a session has loaded keeps
//! its pages of the section resident: 85-90 MiB after an interactive startup,
//! while the engine holds the code it decoded from them on its own heap.
//!
//! [`release_embedded_module_pages`] unmaps the clean resident pages of the
//! section from the process with `MADV_DONTNEED`. The pages stay in the page
//! cache; a later read of one faults the same bytes back in without touching
//! the disk. Only pages the pagemap reports as present and file-backed are
//! released: a page this process wrote is a private anonymous copy, and
//! dropping it would lose the write.
//!
//! Linux only. Elsewhere the call releases nothing and returns 0: macOS does
//! not count clean file-backed pages in a process's memory footprint, and the
//! Windows binaries embed no bytecode.

use napi::Result;
use napi_derive::napi;

/// Unmaps the clean resident pages of the executable's `.bun` section and
/// returns the number of bytes released. Returns 0 when the executable has no
/// such section or the platform has no implementation.
#[napi]
pub fn release_embedded_module_pages() -> Result<f64> {
	#[cfg(target_os = "linux")]
	{
		linux::release(linux::EMBEDDED_SECTION)
			.map(|bytes| bytes as f64)
			.map_err(|err| {
				crate::napi_error::to_napi_with("Failed to release embedded module pages", err)
			})
	}
	#[cfg(not(target_os = "linux"))]
	{
		Ok(0.0)
	}
}

/// Page-index runs of clean resident file pages in a pagemap slice.
///
/// Each entry is one `/proc/<pid>/pagemap` word. A page qualifies when it is
/// present, not swapped, and file-backed; a private page this process wrote
/// is anonymous and never qualifies. Yields `(first, len)` pairs in order.
#[cfg(any(target_os = "linux", test))]
fn clean_file_page_runs(entries: &[u64]) -> impl Iterator<Item = (usize, usize)> + '_ {
	const PRESENT: u64 = 1 << 63;
	const SWAPPED: u64 = 1 << 62;
	const FILE: u64 = 1 << 61;
	let clean = |entry: u64| entry & (PRESENT | SWAPPED | FILE) == PRESENT | FILE;
	let mut at = 0;
	std::iter::from_fn(move || {
		while at < entries.len() && !clean(entries[at]) {
			at += 1;
		}
		if at == entries.len() {
			return None;
		}
		let first = at;
		while at < entries.len() && clean(entries[at]) {
			at += 1;
		}
		Some((first, at - first))
	})
}

#[cfg(target_os = "linux")]
mod linux {
	use std::{
		fs::File,
		io::{self, ErrorKind},
		os::unix::fs::FileExt,
	};

	/// The section Bun's standalone compiler writes the module graph into.
	pub const EMBEDDED_SECTION: &[u8] = b".bun";

	const PT_PHDR: u32 = 6;
	/// `sizeof(Elf64_Phdr)` and `sizeof(Elf64_Shdr)`: the smallest entry the
	/// fields read below fit in.
	const PROGRAM_HEADER_SIZE: usize = 56;
	const SECTION_HEADER_SIZE: usize = 64;
	/// Upper bound on a header table read from the executable, so a corrupt
	/// count cannot size an allocation.
	const MAX_TABLE_BYTES: usize = 1 << 20;

	fn invalid(what: &str) -> io::Error {
		io::Error::new(ErrorKind::InvalidData, format!("/proc/self/exe: {what}"))
	}

	fn bytes<const N: usize>(buf: &[u8], at: usize) -> io::Result<[u8; N]> {
		buf.get(at..at + N)
			.and_then(|slice| slice.try_into().ok())
			.ok_or_else(|| invalid("header field out of bounds"))
	}

	fn u16_at(buf: &[u8], at: usize) -> io::Result<usize> {
		Ok(u16::from_le_bytes(bytes(buf, at)?) as usize)
	}

	fn u32_at(buf: &[u8], at: usize) -> io::Result<u32> {
		Ok(u32::from_le_bytes(bytes(buf, at)?))
	}

	fn u64_at(buf: &[u8], at: usize) -> io::Result<u64> {
		Ok(u64::from_le_bytes(bytes(buf, at)?))
	}

	fn table(
		exe: &File,
		offset: u64,
		entry_size: usize,
		min_entry_size: usize,
		count: usize,
	) -> io::Result<Vec<u8>> {
		if entry_size < min_entry_size {
			return Err(invalid("header entry smaller than the ELF64 layout"));
		}
		let len = entry_size
			.checked_mul(count)
			.filter(|len| *len <= MAX_TABLE_BYTES)
			.ok_or_else(|| invalid("header table too large"))?;
		let mut buf = vec![0; len];
		exe.read_exact_at(&mut buf, offset)?;
		Ok(buf)
	}

	/// Run-time address range `[start, end)` of the named section of the
	/// running executable, or `None` when it has no such section.
	///
	/// The load bias is where the program headers sit at run time
	/// (`AT_PHDR`) minus where the file says they sit, so the result holds
	/// for a position-dependent executable (bias 0) and a PIE alike.
	pub fn section_range(name: &[u8]) -> io::Result<Option<(u64, u64)>> {
		let exe = File::open("/proc/self/exe")?;
		let mut header = [0u8; 64];
		exe.read_exact_at(&mut header, 0)?;
		// ELF magic, 64-bit class, little-endian data.
		if header[..4] != *b"\x7fELF" || header[4] != 2 || header[5] != 1 {
			return Ok(None);
		}
		let phoff = u64_at(&header, 0x20)?;
		let shoff = u64_at(&header, 0x28)?;
		let phentsize = u16_at(&header, 0x36)?;
		let phnum = u16_at(&header, 0x38)?;
		let shentsize = u16_at(&header, 0x3a)?;
		let shnum = u16_at(&header, 0x3c)?;
		let shstrndx = u16_at(&header, 0x3e)?;

		let programs = table(&exe, phoff, phentsize, PROGRAM_HEADER_SIZE, phnum)?;
		let mut phdr_vaddr = None;
		for entry in programs.chunks_exact(phentsize) {
			if u32_at(entry, 0)? == PT_PHDR {
				phdr_vaddr = Some(u64_at(entry, 16)?);
				break;
			}
		}
		let Some(phdr_vaddr) = phdr_vaddr else {
			return Err(invalid("no PT_PHDR program header"));
		};
		// SAFETY: getauxval reads the process's auxiliary vector and has no
		// preconditions.
		let phdr_runtime = unsafe { libc::getauxval(libc::AT_PHDR) };
		let bias = phdr_runtime.wrapping_sub(phdr_vaddr);

		let sections = table(&exe, shoff, shentsize, SECTION_HEADER_SIZE, shnum)?;
		let names_entry = sections
			.get(shstrndx * shentsize..)
			.ok_or_else(|| invalid("section name table index out of bounds"))?;
		let names_len = usize::try_from(u64_at(names_entry, 0x20)?)
			.ok()
			.filter(|len| *len <= MAX_TABLE_BYTES)
			.ok_or_else(|| invalid("section name table too large"))?;
		let mut names = vec![0; names_len];
		exe.read_exact_at(&mut names, u64_at(names_entry, 0x18)?)?;

		for entry in sections.chunks_exact(shentsize) {
			let at = u32_at(entry, 0)? as usize;
			let matches =
				names.get(at..at + name.len()) == Some(name) && names.get(at + name.len()) == Some(&0);
			if matches {
				let start = u64_at(entry, 0x10)?.wrapping_add(bias);
				let end = start
					.checked_add(u64_at(entry, 0x20)?)
					.ok_or_else(|| invalid("section ends past the address space"))?;
				return Ok(Some((start, end)));
			}
		}
		Ok(None)
	}

	/// The named section's whole pages as `(page size, first page index,
	/// pagemap words)`, or `None` when it has no whole page.
	pub fn section_pages(name: &[u8]) -> io::Result<Option<(u64, u64, Vec<u64>)>> {
		// SAFETY: sysconf has no preconditions.
		let page = u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) })
			.map_err(|_| io::Error::last_os_error())?;
		let Some((start, end)) = section_range(name)? else {
			return Ok(None);
		};
		// Whole pages only: a page the section shares with its neighbours may
		// hold data the process writes.
		let first_page = start.div_ceil(page);
		let end_page = end / page;
		if end_page <= first_page {
			return Ok(None);
		}
		let count =
			usize::try_from(end_page - first_page).map_err(|_| invalid("section too large"))?;
		let mut raw = vec![0u8; count * 8];
		File::open("/proc/self/pagemap")?.read_exact_at(&mut raw, first_page * 8)?;
		let entries = raw
			.chunks_exact(8)
			.map(|word| {
				let mut bytes = [0u8; 8];
				bytes.copy_from_slice(word);
				u64::from_le_bytes(bytes)
			})
			.collect();
		Ok(Some((page, first_page, entries)))
	}

	/// Unmaps the clean resident pages of the named section; returns bytes
	/// released.
	pub fn release(name: &[u8]) -> io::Result<u64> {
		let Some((page, first_page, entries)) = section_pages(name)? else {
			return Ok(0);
		};
		let mut released = 0;
		for (first, len) in super::clean_file_page_runs(&entries) {
			let addr = (first_page + first as u64) * page;
			let bytes = len as u64 * page;
			// SAFETY: the range lies inside the executable's own mapping of the
			// section, and the pagemap reported every page in it present and
			// file-backed, so no page holds a private write. MADV_DONTNEED
			// drops the mapping; the next access faults the same file bytes back
			// from the page cache. Nothing in the process writes the section.
			let rc = unsafe {
				libc::madvise(addr as *mut libc::c_void, bytes as usize, libc::MADV_DONTNEED)
			};
			if rc != 0 {
				return Err(io::Error::last_os_error());
			}
			released += bytes;
		}
		Ok(released)
	}
}

/// Defects these close: a page holding a private write, a swapped page or an
/// absent page counted as releasable (the first loses data under
/// `MADV_DONTNEED`); a section range computed without the load bias, which
/// would advise addresses outside the section; a prefix of a section name
/// matching the section; and a release that reports bytes without unmapping
/// them.
///
/// Not caught: a write into the section between the pagemap read and the
/// `madvise`. Nothing in the process writes the section.
#[cfg(test)]
mod tests {
	use super::clean_file_page_runs;

	const PRESENT: u64 = 1 << 63;
	const SWAPPED: u64 = 1 << 62;
	const FILE: u64 = 1 << 61;
	const CLEAN: u64 = PRESENT | FILE;
	/// A private page the process wrote: present, anonymous.
	const WRITTEN: u64 = PRESENT;
	const ABSENT: u64 = 0;

	fn runs(entries: &[u64]) -> Vec<(usize, usize)> {
		clean_file_page_runs(entries).collect()
	}

	/// Whether `addr` lies inside a mapping of the running executable's file,
	/// per `/proc/self/maps`. Checked before a test dereferences a section
	/// address, so a wrong range fails an assertion instead of faulting.
	#[cfg(target_os = "linux")]
	fn mapped_from_the_executable(addr: u64) -> bool {
		let exe = std::fs::read_link("/proc/self/exe").expect("read /proc/self/exe");
		let maps = std::fs::read_to_string("/proc/self/maps").expect("read /proc/self/maps");
		maps.lines().any(|line| {
			let mut fields = line.split_whitespace();
			let range = fields.next().unwrap_or_default();
			let path = fields.nth(4).unwrap_or_default();
			let Some((lo, hi)) = range.split_once('-') else {
				return false;
			};
			let (Ok(lo), Ok(hi)) = (u64::from_str_radix(lo, 16), u64::from_str_radix(hi, 16)) else {
				return false;
			};
			std::path::Path::new(path) == exe && (lo..hi).contains(&addr)
		})
	}

	#[test]
	fn only_present_file_pages_are_released() {
		assert_eq!(runs(&[CLEAN]), [(0, 1)]);
		assert_eq!(runs(&[WRITTEN]), []);
		assert_eq!(runs(&[ABSENT]), []);
		assert_eq!(runs(&[FILE]), [], "a file page that is not present is not resident");
		assert_eq!(runs(&[SWAPPED | FILE]), []);
		assert_eq!(runs(&[PRESENT | SWAPPED | FILE]), []);
	}

	#[test]
	fn a_written_page_splits_the_run_around_it() {
		assert_eq!(runs(&[CLEAN, CLEAN, WRITTEN, CLEAN, ABSENT, CLEAN, CLEAN, CLEAN]), [
			(0, 2),
			(3, 1),
			(5, 3)
		]);
	}

	#[test]
	fn runs_reach_both_ends_of_the_slice() {
		assert_eq!(runs(&[]), []);
		assert_eq!(runs(&[CLEAN, CLEAN, CLEAN]), [(0, 3)]);
		assert_eq!(runs(&[WRITTEN, CLEAN, CLEAN]), [(1, 2)]);
		assert_eq!(runs(&[CLEAN, CLEAN, WRITTEN]), [(0, 2)]);
	}

	#[test]
	fn soft_dirty_and_exclusive_bits_do_not_disqualify_a_clean_page() {
		const SOFT_DIRTY: u64 = 1 << 55;
		const EXCLUSIVE: u64 = 1 << 56;
		assert_eq!(runs(&[CLEAN | SOFT_DIRTY | EXCLUSIVE | 0x1234]), [(0, 1)]);
	}

	/// The section lookup resolves run-time addresses: this function's own
	/// code lies inside `.text` as the lookup reports it, which holds only if
	/// the load bias is right (test binaries are position-independent).
	#[cfg(target_os = "linux")]
	#[test]
	fn the_section_range_contains_code_the_process_is_running() {
		let (start, end) = super::linux::section_range(b".text")
			.expect("read /proc/self/exe")
			.expect("the test binary has a .text section");
		let here =
			the_section_range_contains_code_the_process_is_running as *const () as usize as u64;
		assert!((start..end).contains(&here), "{here:#x} outside .text {start:#x}..{end:#x}");
		assert!(mapped_from_the_executable(start) && mapped_from_the_executable(end - 1));
		assert_eq!(super::linux::section_range(b".no-such-section").expect("read"), None);
		assert_eq!(
			super::linux::section_range(b".tex").expect("read"),
			None,
			"a prefix of a section name is not that section"
		);
	}

	/// Releasing a section this process has read unmaps its resident clean
	/// pages, and the bytes read back unchanged afterwards.
	#[cfg(target_os = "linux")]
	#[test]
	fn released_pages_leave_the_mapping_and_read_back_unchanged() {
		let (start, end) = super::linux::section_range(b".rodata")
			.expect("read /proc/self/exe")
			.expect("the test binary has a .rodata section");
		let resident = || -> usize {
			let (_, _, entries) = super::linux::section_pages(b".rodata")
				.expect("read pagemap")
				.expect(".rodata spans whole pages");
			clean_file_page_runs(&entries).map(|(_, len)| len).sum()
		};
		assert!(
			mapped_from_the_executable(start) && mapped_from_the_executable(end - 1),
			".rodata {start:#x}..{end:#x} is not inside the executable's mapping"
		);
		// SAFETY: .rodata is mapped read-only for the life of the process, and
		// the range was just checked to lie inside that mapping.
		let bytes = unsafe { std::slice::from_raw_parts(start as *const u8, (end - start) as usize) };
		let before: u64 = bytes.iter().map(|b| u64::from(*b)).sum();
		let resident_before = resident();
		let released = super::linux::release(b".rodata").expect("release .rodata");
		let resident_after = resident();
		assert!(released > 0, "reading .rodata left no resident page to release");
		// Other tests run on other threads and may fault a few pages back in.
		assert!(
			resident_after * 2 < resident_before,
			"{resident_after} of {resident_before} pages still mapped after releasing {released} \
			 bytes"
		);
		let after: u64 = bytes.iter().map(|b| u64::from(*b)).sum();
		assert_eq!(before, after);
	}
}
