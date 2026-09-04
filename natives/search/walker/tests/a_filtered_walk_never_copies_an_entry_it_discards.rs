//! WHY: a filtered walk used to be served by copying every cached entry and
//! then dropping the ones the filter rejected, so a glob that kept ten entries
//! out of a hundred thousand still allocated a hundred thousand owned paths
//! (measured at 13.8MiB and 101,373 allocations per hit by
//! `examples/walk-cache-copy.rs`). The filter now runs where the entries live —
//! inside the cache entry, or inside the fresh scan — and only a survivor is
//! cloned.
//!
//! The class this closes is wider than that one measurement: any path that
//! materializes entries before deciding whether they are wanted. The allocation
//! rows below are the fence, because they fail on a copy that no returned value
//! can show. The equivalence rows pin that filtering earlier changed no
//! observable answer: same entries, same order, same metadata, same statistics,
//! same limit interaction, same empty-recheck behaviour, same caller ownership.
//! The filter shapes are enumerated so that a shape nobody exercised does not
//! exist rather than being forgotten.
//!
//! What it does not catch: a copy made further out, in a caller that takes
//! these entries and rebuilds them (the N-API conversion in `veyyon-natives`
//! has its own instrument); the streaming walk, which never builds an owned
//! entry at all; and cache-age reporting below one millisecond, which rounds to
//! zero and is therefore asserted nowhere here.

use std::{
	alloc::{GlobalAlloc, Layout, System},
	fs,
	path::Path,
	sync::{
		LazyLock, Mutex, MutexGuard, PoisonError,
		atomic::{AtomicU64, Ordering},
	},
	thread,
	time::Duration,
};

use veyyon_test_scratch::{TempTree, scratch_dir};
use veyyon_walker::{
	CollectedEntry, CompiledWalkGlob, EmptyRecheck, FileType, WalkBackend, WalkDetail, WalkFilter,
	WalkOptions, WalkOverridePattern, WalkOverrides, WalkRequest, collect_entries_without_heartbeat,
	invalidate_all,
};

/// Bytes this test binary has allocated, so a copy can be observed rather than
/// assumed.
static ALLOCATED: AtomicU64 = AtomicU64::new(0);

/// The system allocator with a byte counter in front of it.
struct Counting;

// SAFETY: every method forwards to the system allocator with the pointer and
// layout it was given, and the counter is an atomic that allocates nothing
// itself.
unsafe impl GlobalAlloc for Counting {
	unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
		ALLOCATED.fetch_add(layout.size() as u64, Ordering::Relaxed);
		// SAFETY: the layout is the caller's, forwarded unchanged.
		unsafe { System.alloc(layout) }
	}

	unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
		// SAFETY: pointer and layout are the pair this allocator handed out.
		unsafe { System.dealloc(pointer, layout) };
	}

	unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
		ALLOCATED.fetch_add(new_size as u64, Ordering::Relaxed);
		// SAFETY: pointer and layout are the pair this allocator handed out, and
		// `new_size` is the caller's.
		unsafe { System.realloc(pointer, layout, new_size) }
	}
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// A cache TTL long enough that a prime and a read in the same test always hit.
///
/// The walker reads this once per process through a `LazyLock`, so it has to be
/// set before the first cache access anywhere in this binary. Every test forces
/// this static first, which is what orders the write ahead of that read.
static LONG_TTL: LazyLock<()> = LazyLock::new(|| {
	// SAFETY: this body runs once, inside `LazyLock`, before any test in this
	// binary has reached the cache, so no other thread is reading the environment
	// while it writes.
	unsafe { std::env::set_var("FS_SCAN_CACHE_TTL_MS", "600000") };
});

/// One test at a time in this binary; see [`ready`].
static SERIAL: Mutex<()> = Mutex::new(());

/// Take the whole binary for this test.
///
/// The allocation counter and the walker's scan cache are both process-wide: a
/// concurrent test's allocations land in a measurement here, and its cache
/// inserts evict this test's entry once the sixteen-entry cache is full. Both
/// were observed.
fn ready() -> MutexGuard<'static, ()> {
	LazyLock::force(&LONG_TTL);
	let guard = SERIAL.lock().unwrap_or_else(PoisonError::into_inner);
	invalidate_all();
	guard
}

fn temp_tree(name: &str) -> TempTree {
	scratch_dir(&format!("walker-filtered-copy-{name}"))
}

fn write_file(path: impl AsRef<Path>) {
	let path = path.as_ref();
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent).expect("parent directory should be created");
	}
	fs::write(path, b"x").expect("file should be written");
}

/// A tree of `files` files under `src/`, spread a hundred per directory.
fn write_tree(root: &Path, files: usize) {
	for index in 0..files {
		write_file(
			root
				.join("src")
				.join(format!("d{:03}", index / 100))
				.join(format!("f{index:05}.txt")),
		);
	}
}

fn options(cache: bool) -> WalkOptions {
	WalkOptions { detail: WalkDetail::Full, cache, ..WalkOptions::default() }
}

fn glob(pattern: &str) -> CompiledWalkGlob {
	CompiledWalkGlob::new([pattern]).expect("test glob should compile")
}

/// Every entry the walk sees, unfiltered and uncached: the reference answer.
fn reference(root: &Path) -> Vec<CollectedEntry> {
	collect_entries_without_heartbeat(root, options(false))
		.expect("reference walk should succeed")
		.entries
}

fn paths(entries: &[CollectedEntry]) -> Vec<String> {
	entries.iter().map(|entry| entry.path.clone()).collect()
}

/// Bytes allocated while `body` ran.
fn allocated_during<R>(body: impl FnOnce() -> R) -> (R, u64) {
	let before = ALLOCATED.load(Ordering::Relaxed);
	let value = body();
	(value, ALLOCATED.load(Ordering::Relaxed) - before)
}

#[test]
fn a_narrow_filter_on_a_cache_hit_allocates_for_the_survivors_only() {
	let _serial = ready();
	let tree = temp_tree("narrow-allocation");
	write_tree(tree.path(), 5_000);

	let narrow = WalkRequest::from_options(tree.path(), options(true))
		.filter(WalkFilter::files_only().glob(glob("**/f0000*.txt")))
		.empty_recheck(EmptyRecheck::Never);
	let unfiltered =
		WalkRequest::from_options(tree.path(), options(true)).empty_recheck(EmptyRecheck::Never);

	// Prime the cache so both measured reads are hits on the same cache entry: a
	// glob is not part of the cache key, which is why a filtered request can be
	// served by the unfiltered scan at all.
	let primed = unfiltered.collect().expect("prime should succeed");
	assert!(primed.entries.len() >= 5_000, "the tree should hold every written file");

	let (wide, wide_bytes) = allocated_during(|| unfiltered.collect().expect("wide hit"));
	let (kept, narrow_bytes) = allocated_during(|| narrow.collect().expect("narrow hit"));

	assert_eq!(kept.entries.len(), 10, "the glob matches f00000..f00009");
	assert_eq!(kept.stats.scanned_entries, wide.entries.len(), "both hits read one cache entry");
	assert_eq!(kept.stats.filtered_entries, wide.entries.len() - 10);

	// The wide read is the control. It must be expensive, or the narrow bound below
	// would pass for a reason other than the one it claims.
	assert!(
		wide_bytes > 100 * 1024,
		"an unfiltered hit copies every entry, which cannot cost only {wide_bytes} bytes"
	);
	// Ten survivors cost ten paths and ten entry slots. Together with the survivor
	// bitmask (one bit per scanned entry) that cannot reach 64KiB on a 5,000-entry
	// tree; copying first cost ~400KiB here and 13.8MiB at a hundred thousand
	// entries.
	assert!(
		narrow_bytes < 64 * 1024,
		"a hit keeping 10 of {} entries allocated {narrow_bytes} bytes, so it copied entries it \
		 then discarded",
		wide.entries.len()
	);
}

#[test]
fn a_narrow_filter_on_a_cold_scan_pays_for_the_survivors_only() {
	let _serial = ready();
	// The cold lane fills the cache and answers the caller from the same scan, so a
	// copy made there is invisible in the returned values and shows up only as
	// bytes.
	let tree = temp_tree("cold-allocation");
	write_tree(tree.path(), 5_000);

	let narrow = WalkRequest::from_options(tree.path(), options(true))
		.filter(WalkFilter::files_only().glob(glob("**/f0000*.txt")))
		.empty_recheck(EmptyRecheck::Never);
	let unfiltered =
		WalkRequest::from_options(tree.path(), options(true)).empty_recheck(EmptyRecheck::Never);

	// Warm the page cache and the walker's thread pool, so the two measured scans
	// differ in the filter and not in first-run setup.
	unfiltered.collect().expect("warmup");
	invalidate_all();
	let (wide, wide_bytes) = allocated_during(|| unfiltered.collect().expect("wide cold scan"));
	invalidate_all();
	let (kept, narrow_bytes) = allocated_during(|| narrow.collect().expect("narrow cold scan"));
	invalidate_all();

	assert_eq!(kept.entries.len(), 10, "the glob matches f00000..f00009");
	assert_eq!(kept.backend, WalkBackend::Fresh, "both reads are cold");
	assert_eq!(kept.stats.scanned_entries, wide.entries.len());

	// Both scans walk the tree and retain one copy in the cache, so the only
	// difference between them is the copy delivered to the caller: 5,051 entries
	// for the wide read and 10 for the narrow one. Copying first and filtering
	// afterwards puts the wide read's copy back into the narrow read, which this
	// catches with most of a full copy (~340KiB here) to spare.
	let saved = wide_bytes.saturating_sub(narrow_bytes);
	assert!(
		saved > 150 * 1024,
		"a cold scan keeping 10 of {} entries allocated {narrow_bytes} bytes against the wide \
		 read's {wide_bytes}, which is not a copy less",
		wide.entries.len()
	);
}

#[test]
fn filtering_at_the_source_returns_what_filtering_after_the_copy_returned() {
	let _serial = ready();
	let tree = temp_tree("equivalence");
	write_tree(tree.path(), 300);
	let big = tree.path().join("src/d000/big.txt");
	fs::write(&big, vec![b'x'; 4096]).expect("big file should be written");

	let reference_entries = reference(tree.path());
	assert!(reference_entries.len() > 300, "the reference walk should see files and directories");

	// Every shape the collected-entry filter can take: entry kind, glob, size
	// bound, and a combination, so an unexercised shape does not exist rather than
	// being forgotten.
	#[expect(
		clippy::type_complexity,
		reason = "a filter paired with the same rule written independently in test words"
	)]
	let shapes: Vec<(&str, WalkFilter, Box<dyn Fn(&CollectedEntry) -> bool>)> = vec![
		("all", WalkFilter::all(), Box::new(|_: &CollectedEntry| true)),
		(
			"files-only",
			WalkFilter::files_only(),
			Box::new(|entry: &CollectedEntry| entry.file_type == FileType::File),
		),
		(
			"dirs-only",
			WalkFilter::dirs_only(),
			Box::new(|entry: &CollectedEntry| entry.file_type == FileType::Dir),
		),
		(
			"glob",
			WalkFilter::all().glob(glob("**/f001*.txt")),
			Box::new(|entry: &CollectedEntry| glob("**/f001*.txt").is_match(&entry.path)),
		),
		(
			"files-only + glob",
			WalkFilter::files_only().glob(glob("**/f002*.txt")),
			Box::new(|entry: &CollectedEntry| {
				entry.file_type == FileType::File && glob("**/f002*.txt").is_match(&entry.path)
			}),
		),
		(
			"max-file-size",
			WalkFilter::files_only().max_file_size(1024),
			Box::new(|entry: &CollectedEntry| {
				entry.file_type == FileType::File && !entry.size.is_some_and(|size| size > 1024.0)
			}),
		),
	];

	for (name, filter, accept) in shapes {
		let expected: Vec<CollectedEntry> = reference_entries
			.iter()
			.filter(|entry| accept(entry))
			.cloned()
			.collect();
		assert!(
			!expected.is_empty(),
			"{name} should keep something for the comparison to mean anything"
		);

		for cached in [false, true] {
			invalidate_all();
			let request = WalkRequest::from_options(tree.path(), options(cached))
				.filter(filter.clone())
				.empty_recheck(EmptyRecheck::Never);
			// A cold read, then a second read that is served by the cache when caching
			// is on and repeats the walk when it is off.
			let cold = request.collect().expect("cold walk should succeed");
			let warm = request.collect().expect("second walk should succeed");

			assert_eq!(cold.entries, expected, "{name} cold entries, cached={cached}");
			assert_eq!(warm.entries, expected, "{name} warm entries, cached={cached}");
			assert_eq!(paths(&warm.entries), paths(&expected), "{name} order, cached={cached}");
			assert_eq!(
				cold.stats.scanned_entries,
				reference_entries.len(),
				"{name} scanned count, cached={cached}"
			);
			assert_eq!(
				warm.stats.scanned_entries,
				reference_entries.len(),
				"{name} scanned count on the second read, cached={cached}"
			);
			assert_eq!(
				cold.stats.filtered_entries,
				reference_entries.len() - expected.len(),
				"{name} filtered count, cached={cached}"
			);
			assert_eq!(
				warm.stats.filtered_entries,
				reference_entries.len() - expected.len(),
				"{name} filtered count on the second read, cached={cached}"
			);
			assert_eq!(cold.stats.limited_entries, 0, "{name} nothing was limited, cached={cached}");
			assert_eq!(
				cold.backend,
				WalkBackend::Fresh,
				"{name} a cold read is fresh, cached={cached}"
			);
			assert_eq!(cold.stats.cache_age_ms, 0, "{name} a cold read has no age, cached={cached}");
		}
	}
}

#[test]
fn a_cache_hit_serves_the_filtered_answer_out_of_the_cached_scan() {
	let _serial = ready();
	let tree = temp_tree("hit-is-a-hit");
	write_tree(tree.path(), 40);

	let request = WalkRequest::from_options(tree.path(), options(true))
		.filter(WalkFilter::files_only().glob(glob("**/*.txt")))
		.empty_recheck(EmptyRecheck::Never);
	let cold = request.collect().expect("cold walk should succeed");
	assert_eq!(cold.entries.len(), 40);

	// A file that appears after the fill is the discriminator: a fresh walk would
	// return it, and a read served out of the cached scan cannot.
	write_file(tree.path().join("src/d000/appeared-later.txt"));
	let warm = request.collect().expect("second walk should succeed");
	assert_eq!(paths(&warm.entries), paths(&cold.entries), "the second read was not a cache hit");
	assert_eq!(warm.stats.scanned_entries, cold.stats.scanned_entries);
	assert_eq!(warm.stats.filtered_entries, cold.stats.filtered_entries);
}

#[test]
fn a_limit_truncates_what_the_filter_kept_and_never_what_it_rejected() {
	let _serial = ready();
	let tree = temp_tree("limit-after-filter");
	write_tree(tree.path(), 300);

	let request = WalkRequest::from_options(tree.path(), options(true))
		.filter(WalkFilter::files_only().glob(glob("**/f000*.txt")))
		.empty_recheck(EmptyRecheck::Never);
	let all = request.collect().expect("unlimited walk should succeed");
	assert_eq!(all.entries.len(), 100, "f00000..f00099 match");

	let limited = request
		.limit(7)
		.collect()
		.expect("limited walk should succeed");
	assert_eq!(paths(&limited.entries), paths(&all.entries)[..7], "the first seven survivors");
	assert_eq!(limited.stats.limited_entries, 93);
	assert_eq!(
		limited.stats.filtered_entries, all.stats.filtered_entries,
		"a limit is not a filter"
	);
	assert_eq!(limited.stats.scanned_entries, all.stats.scanned_entries);
}

#[test]
fn the_survivor_marks_land_on_the_right_entries_across_a_word_boundary() {
	let _serial = ready();
	// Survivors are marked in a bitmask of 64-bit words, so an index folded into
	// the wrong word or the wrong bit only shows up at a boundary. Every other
	// entry is accepted at 63, 64 and 65 entries, plus the all-accepted and
	// none-accepted ends where the fast paths live.
	for count in [1_usize, 63, 64, 65, 127, 128, 129] {
		let tree = temp_tree(&format!("bitmask-{count}"));
		for index in 0..count {
			let parity = if index % 2 == 0 { "even" } else { "odd" };
			write_file(tree.path().join(format!("{parity}-{index:04}.txt")));
		}
		invalidate_all();

		let root = tree.path();
		let expected_alternating: Vec<String> = reference(root)
			.into_iter()
			.filter(|entry| entry.path.starts_with("even-"))
			.map(|entry| entry.path)
			.collect();
		assert_eq!(expected_alternating.len(), count.div_ceil(2), "{count} entries, half accepted");

		let alternating = WalkRequest::from_options(root, options(true))
			.filter(WalkFilter::files_only().glob(glob("even-*.txt")))
			.empty_recheck(EmptyRecheck::Never);
		// The cold read fills the cache; the second read takes the filtered path over
		// the cached scan, which is where the mask runs.
		assert_eq!(paths(&alternating.collect().expect("cold").entries), expected_alternating);
		assert_eq!(paths(&alternating.collect().expect("warm").entries), expected_alternating);

		let everything = WalkRequest::from_options(root, options(true))
			.filter(WalkFilter::files_only())
			.empty_recheck(EmptyRecheck::Never);
		assert_eq!(everything.collect().expect("all cold").entries.len(), count);
		assert_eq!(everything.collect().expect("all warm").entries.len(), count);

		let nothing = WalkRequest::from_options(root, options(true))
			.filter(WalkFilter::files_only().glob(glob("absent-*.txt")))
			.empty_recheck(EmptyRecheck::Never);
		assert!(nothing.collect().expect("none cold").entries.is_empty());
		assert!(nothing.collect().expect("none warm").entries.is_empty());
	}
}

#[test]
fn the_entries_a_caller_receives_are_its_own() {
	let _serial = ready();
	let tree = temp_tree("ownership");
	write_tree(tree.path(), 40);

	let request = WalkRequest::from_options(tree.path(), options(true))
		.filter(WalkFilter::files_only())
		.empty_recheck(EmptyRecheck::Never);
	let mut first = request.collect().expect("cold walk should succeed").entries;
	let expected = paths(&first);

	// A caller that rewrites, drains or extends its own result must not reach the
	// entries the cache is still serving.
	for entry in &mut first {
		entry.path = format!("rewritten/{}", entry.path);
		entry.size = Some(0.0);
	}
	first.truncate(1);
	first.push(CollectedEntry {
		path:      "injected.txt".to_owned(),
		file_type: FileType::File,
		mtime:     None,
		size:      None,
	});

	let second = request.collect().expect("second walk should succeed");
	assert_eq!(paths(&second.entries), expected, "the cache served a caller-mutated entry");
}

#[test]
fn an_empty_filtered_result_still_obeys_the_recheck_policy() {
	let _serial = ready();
	let tree = temp_tree("empty-recheck");
	write_file(tree.path().join("src/keep.log"));

	let never = WalkRequest::from_options(tree.path(), options(true))
		.filter(WalkFilter::files_only().glob(glob("**/*.txt")))
		.empty_recheck(EmptyRecheck::Never);
	assert!(never.collect().expect("cold").entries.is_empty(), "no .txt exists yet");

	write_file(tree.path().join("src/added.txt"));
	// A recheck is only considered for a cache entry with a reported age, and the
	// age is reported in whole milliseconds.
	thread::sleep(Duration::from_millis(3));
	assert!(
		never.collect().expect("warm").entries.is_empty(),
		"EmptyRecheck::Never must serve the cached empty answer even once a match exists"
	);

	let rechecking = WalkRequest::from_options(tree.path(), options(true))
		.filter(WalkFilter::files_only().glob(glob("**/*.txt")))
		.empty_recheck(EmptyRecheck::AfterMillis(1));
	let rechecked = rechecking.collect().expect("recheck");
	assert_eq!(
		paths(&rechecked.entries),
		vec!["src/added.txt".to_owned()],
		"an empty filtered result at or past the threshold must rescan"
	);
	assert_eq!(rechecked.backend, WalkBackend::Fresh, "a recheck reports a fresh read");
	assert_eq!(rechecked.stats.cache_age_ms, 0, "a recheck reports no cache age");
	assert_eq!(rechecked.stats.scanned_entries, 3, "src, src/keep.log, src/added.txt");
	assert_eq!(rechecked.stats.filtered_entries, 2);
}

#[test]
fn an_uncached_filtered_walk_returns_the_same_answer_as_a_cached_one() {
	let _serial = ready();
	let tree = temp_tree("cache-parity");
	write_tree(tree.path(), 120);

	let filter = WalkFilter::files_only().glob(glob("**/f0001*.txt"));
	let cached = WalkRequest::from_options(tree.path(), options(true))
		.filter(filter.clone())
		.empty_recheck(EmptyRecheck::Never);
	let uncached = WalkRequest::from_options(tree.path(), options(false))
		.filter(filter)
		.empty_recheck(EmptyRecheck::Never);

	let cold = cached.collect().expect("cold cached walk");
	let hit = cached.collect().expect("cached hit");
	let fresh = uncached.collect().expect("uncached walk");

	assert_eq!(fresh.entries.len(), 10, "f00010..f00019 match");
	assert_eq!(cold.entries, fresh.entries);
	assert_eq!(hit.entries, fresh.entries);
	assert_eq!(hit.stats.scanned_entries, fresh.stats.scanned_entries);
	assert_eq!(hit.stats.filtered_entries, fresh.stats.filtered_entries);
	assert_eq!(fresh.stats.cache_age_ms, 0, "an uncached walk reports no age");
	assert_eq!(fresh.backend, WalkBackend::Fresh);
}

#[test]
fn caller_named_globs_still_have_their_own_filter_applied() {
	let _serial = ready();
	// Caller-named globs bypass the cache entirely (they are not part of the cache
	// key), so they are a third lane with its own filtering step. A filter that
	// stopped running here would return the override's whole result.
	let tree = temp_tree("overrides");
	write_tree(tree.path(), 40);
	write_file(tree.path().join("src/d000/notes.log"));

	let overrides = WalkOverrides::new(tree.path(), [WalkOverridePattern::new("*.txt")])
		.expect("override globs should compile");
	let outcome = WalkRequest::from_options(tree.path(), options(true))
		.overrides(overrides)
		.filter(WalkFilter::files_only().glob(glob("**/f0000*.txt")))
		.collect()
		.expect("override walk should succeed");

	assert_eq!(outcome.entries.len(), 10, "f00000..f00009, and never the .log");
	let mut kept = paths(&outcome.entries);
	kept.sort_unstable();
	let expected: Vec<String> = (0..10)
		.map(|index| format!("src/d000/f{index:05}.txt"))
		.collect();
	assert_eq!(kept, expected, "the request's own filter must still run over an override result");
	assert_eq!(outcome.stats.filtered_entries, outcome.stats.scanned_entries - 10);
	assert_eq!(outcome.backend, WalkBackend::Fresh, "an override request is never cached");
	assert_eq!(outcome.stats.cache_age_ms, 0);
}
