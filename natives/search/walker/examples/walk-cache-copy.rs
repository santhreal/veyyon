//! What does the scan cache cost, and what does a hit on it save?
//!
//! Run it: `cargo run -p veyyon-walker --release --example walk-cache-copy`.
//!
//! Environment:
//!
//! - `WALK_CACHE_FILES=100000`   files in the generated tree
//! - `WALK_CACHE_PATH_LEN=80`    length of every relative path
//! - `WALK_CACHE_SAMPLES=5`      timed passes per arm
//! - `WALK_CACHE_DIR=<path>`     where the tree lives (default: XDG cache)
//! - `WALK_CACHE_REGENERATE=1`   rewrite the tree even when it already matches
//! - `FS_SCAN_CACHE_TTL_MS`      must exceed the whole run, or a "hit" arm
//!   misses
//!
//! Three arms, because the row this answers asks three separate questions:
//!
//! - `uncached` is one required output materialization: the walk with the cache
//!   switched off. Every other arm is measured against it.
//! - `cold-fill` is the same walk with the cache on and empty, so its extra
//!   cost over `uncached` is the cache's bookkeeping: today that is a second
//!   deep copy of every entry, one for the caller and one for the map.
//! - `hit` is a read inside the TTL, which copies the retained entries again.
//!
//! Timing alone cannot see a copy that the allocator absorbs into a page it
//! already had, so the counting allocator below reports allocation count,
//! allocated bytes and peak live bytes per arm, and Linux's `VmHWM` is read for
//! the process peak. A cache whose hit allocates as much as a cold walk is not
//! saving what it claims to.

use std::{
	alloc::{GlobalAlloc, Layout, System},
	env, fs,
	io::Write as _,
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
	time::Instant,
};

use veyyon_walker::{
	CollectedEntry, CompiledWalkGlob, FileType, WalkDetail, WalkFilter, WalkOptions, WalkRequest,
	collect_entries_without_heartbeat, invalidate_all,
};

/// Allocation accounting for one arm.
struct Counters {
	allocations: AtomicU64,
	bytes:       AtomicU64,
	live:        AtomicU64,
	peak:        AtomicU64,
}

static COUNTERS: Counters = Counters {
	allocations: AtomicU64::new(0),
	bytes:       AtomicU64::new(0),
	live:        AtomicU64::new(0),
	peak:        AtomicU64::new(0),
};

/// The system allocator, counted.
///
/// Peak live bytes is what distinguishes "allocated a lot and freed it" from
/// "held two copies at once", which is the whole question about a cache fill.
struct Counting;

// SAFETY: every method forwards to the system allocator with the same layout
// and pointer it was given; the counters are plain atomics and allocate nothing
// themselves.
unsafe impl GlobalAlloc for Counting {
	unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
		// SAFETY: the layout is the caller's, forwarded unchanged to the system
		// allocator.
		let pointer = unsafe { System.alloc(layout) };
		if !pointer.is_null() {
			record_alloc(layout.size() as u64);
		}
		pointer
	}

	unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
		COUNTERS
			.live
			.fetch_sub(layout.size() as u64, Ordering::Relaxed);
		// SAFETY: pointer and layout are the pair this allocator handed out.
		unsafe { System.dealloc(pointer, layout) };
	}

	unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
		// SAFETY: pointer and layout are the pair this allocator handed out, and
		// new_size is the caller's.
		let moved = unsafe { System.realloc(pointer, layout, new_size) };
		if !moved.is_null() {
			COUNTERS
				.live
				.fetch_sub(layout.size() as u64, Ordering::Relaxed);
			record_alloc(new_size as u64);
		}
		moved
	}
}

fn record_alloc(size: u64) {
	COUNTERS.allocations.fetch_add(1, Ordering::Relaxed);
	COUNTERS.bytes.fetch_add(size, Ordering::Relaxed);
	let live = COUNTERS.live.fetch_add(size, Ordering::Relaxed) + size;
	COUNTERS.peak.fetch_max(live, Ordering::Relaxed);
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// Counter values at one instant.
#[derive(Clone, Copy)]
struct Snapshot {
	allocations: u64,
	bytes:       u64,
	live:        u64,
	peak:        u64,
}

fn snapshot() -> Snapshot {
	Snapshot {
		allocations: COUNTERS.allocations.load(Ordering::Relaxed),
		bytes:       COUNTERS.bytes.load(Ordering::Relaxed),
		live:        COUNTERS.live.load(Ordering::Relaxed),
		peak:        COUNTERS.peak.load(Ordering::Relaxed),
	}
}

/// One arm's measurement.
struct Arm {
	name:        &'static str,
	millis:      Vec<f64>,
	allocations: u64,
	bytes:       u64,
	/// Peak live bytes above the level the arm started at.
	peak_growth: u64,
	entries:     usize,
	digest:      u64,
}

impl Arm {
	fn p50(&self) -> f64 {
		percentile(&self.millis, 0.50)
	}

	fn p95(&self) -> f64 {
		percentile(&self.millis, 0.95)
	}
}

fn percentile(samples: &[f64], quantile: f64) -> f64 {
	if samples.is_empty() {
		return f64::NAN;
	}
	let mut sorted = samples.to_vec();
	sorted.sort_by(f64::total_cmp);
	let rank = ((sorted.len() - 1) as f64 * quantile).round() as usize;
	sorted[rank]
}

fn env_usize(name: &str, default: usize) -> usize {
	env::var(name)
		.ok()
		.and_then(|value| value.parse().ok())
		.unwrap_or(default)
}

/// A cheap order-sensitive digest of the entries, so two arms can be compared.
fn digest(entries: &[CollectedEntry]) -> u64 {
	let mut hash = 0xcbf2_9ce4_8422_2325_u64;
	for entry in entries {
		for byte in entry.path.as_bytes() {
			hash ^= u64::from(*byte);
			hash = hash.wrapping_mul(0x100_0000_01b3);
		}
		hash ^= entry.file_type as u64;
		hash = hash.wrapping_mul(0x100_0000_01b3);
	}
	hash
}

/// Peak resident set size of this process, in bytes.
fn peak_rss_bytes() -> Option<u64> {
	let status = fs::read_to_string("/proc/self/status").ok()?;
	for line in status.lines() {
		if let Some(rest) = line.strip_prefix("VmHWM:") {
			let kib: u64 = rest.split_whitespace().next()?.parse().ok()?;
			return Some(kib * 1024);
		}
	}
	None
}

fn corpus_dir(files: usize, path_len: usize) -> PathBuf {
	if let Ok(explicit) = env::var("WALK_CACHE_DIR") {
		return PathBuf::from(explicit);
	}
	let cache_home = env::var("XDG_CACHE_HOME").map_or_else(
		|_| {
			let home = env::var("HOME").unwrap_or_else(|_| ".".to_owned());
			Path::new(&home).join(".cache")
		},
		PathBuf::from,
	);
	cache_home
		.join("veyyon")
		.join("walk-cache-copy")
		.join(format!("v1-{files}x{path_len}"))
}

/// Write a tree of `files` files whose relative paths are all `path_len` bytes
/// long.
///
/// The tree is reused when a manifest of the same shape is already there,
/// because the arms are only comparable across runs when the bytes they walk
/// are the same.
fn generate_tree(root: &Path, files: usize, path_len: usize) -> std::io::Result<bool> {
	let manifest = root.join("manifest.txt");
	let expected = format!("v1 {files} {path_len}\n");
	if env::var("WALK_CACHE_REGENERATE").is_err()
		&& fs::read_to_string(&manifest).is_ok_and(|found| found == expected)
	{
		return Ok(true);
	}
	if root.exists() {
		fs::remove_dir_all(root)?;
	}
	fs::create_dir_all(root)?;

	// "src/dNN/sNN/<name>.txt": the directory prefix is fixed width, so padding the
	// name is what fixes the total length.
	let prefix_len = "src/d00/s00/".len();
	let suffix_len = ".txt".len();
	let name_len = path_len.saturating_sub(prefix_len + suffix_len).max(1);
	let mut last_dir = PathBuf::new();
	for index in 0..files {
		let dir = root
			.join("src")
			.join(format!("d{:02}", index / 1000 % 100))
			.join(format!("s{:02}", index / 100 % 10));
		if dir != last_dir {
			fs::create_dir_all(&dir)?;
			last_dir.clone_from(&dir);
		}
		let mut name = format!("{index:0name_len$}");
		name.truncate(name_len);
		let mut file = fs::File::create(dir.join(format!("{name}.txt")))?;
		file.write_all(b"x")?;
	}
	fs::write(&manifest, expected)?;
	Ok(false)
}

fn options(cache: bool) -> WalkOptions {
	WalkOptions { detail: WalkDetail::Full, cache, ..WalkOptions::default() }
}

/// One walk, as an arm runs it: the entry count and an order-sensitive digest.
struct Pass {
	entries: usize,
	digest:  u64,
}

/// Measure one arm. `cold` empties the cache before every timed pass.
fn measure(name: &'static str, samples: usize, cold: bool, walk: &dyn Fn() -> Pass) -> Arm {
	let mut millis = Vec::with_capacity(samples);
	let mut last = Pass { entries: 0, digest: 0 };
	// One untimed pass, so the page cache and the walker's pool are warm for every
	// arm.
	if cold {
		invalidate_all();
	}
	walk();

	// Peak live bytes is monotonic, so an arm can only report its own peak if the
	// counter starts again from what is live right now.
	COUNTERS
		.peak
		.store(COUNTERS.live.load(Ordering::Relaxed), Ordering::Relaxed);
	let start = snapshot();
	for _ in 0..samples {
		if cold {
			invalidate_all();
		}
		let started = Instant::now();
		last = walk();
		millis.push(started.elapsed().as_secs_f64() * 1000.0);
	}
	let end = snapshot();

	Arm {
		name,
		millis,
		allocations: (end.allocations - start.allocations) / samples as u64,
		bytes: (end.bytes - start.bytes) / samples as u64,
		peak_growth: end.peak.saturating_sub(start.live),
		entries: last.entries,
		digest: last.digest,
	}
}

fn main() {
	let files = env_usize("WALK_CACHE_FILES", 100_000);
	let path_len = env_usize("WALK_CACHE_PATH_LEN", 80);
	let samples = env_usize("WALK_CACHE_SAMPLES", 5);
	let root = corpus_dir(files, path_len);

	let reused = generate_tree(&root, files, path_len).expect("tree should be written");
	println!(
		"tree {} files, {path_len}-byte paths, {} at {}",
		files,
		if reused { "reused" } else { "generated" },
		root.display()
	);
	println!(
		"cache ttl {}ms, walk workers {}\n",
		veyyon_walker::cache_ttl_ms(),
		veyyon_walker::walk_workers()
	);

	let collect = |cache: bool| {
		let collected =
			collect_entries_without_heartbeat(&root, options(cache)).expect("walk should succeed");
		Pass { entries: collected.entries.len(), digest: digest(&collected.entries) }
	};
	// The product reaches the cache through a request, which filters, ranks and
	// truncates the entries it was handed. Those arms are what show a copy paid for
	// an entry that is then discarded.
	// What the request used to do: take the cache's copy of every entry, then
	// filter it. Kept as an arm so the differential is visible on every run rather
	// than remembered.
	let filter_after_copy = |pattern: &str| {
		let compiled = CompiledWalkGlob::new([pattern]).expect("glob should compile");
		let collected =
			collect_entries_without_heartbeat(&root, options(true)).expect("walk should succeed");
		let mut entries = collected.entries;
		entries.retain(|entry| entry.file_type == FileType::File && compiled.is_match(&entry.path));
		Pass { entries: entries.len(), digest: digest(&entries) }
	};
	let request = |glob: Option<&str>, limit: Option<usize>| {
		let mut request = WalkRequest::from_options(&root, options(true));
		if let Some(pattern) = glob {
			let compiled = CompiledWalkGlob::new([pattern]).expect("glob should compile");
			request = request.filter(WalkFilter::files_only().glob(compiled));
		}
		if let Some(limit) = limit {
			request = request.limit(limit);
		}
		let outcome = request.collect().expect("walk should succeed");
		Pass { entries: outcome.entries.len(), digest: digest(&outcome.entries) }
	};

	let arms = vec![
		measure("uncached", samples, false, &|| collect(false)),
		measure("cold-fill", samples, true, &|| collect(true)),
		measure("hit", samples, false, &|| collect(true)),
		measure("hit+request", samples, false, &|| request(None, None)),
		measure("hit+glob", samples, false, &|| request(Some("**/*0000.txt"), None)),
		measure("hit+glob+limit", samples, false, &|| request(Some("**/*0000.txt"), Some(100))),
		measure("cold+glob", samples, true, &|| request(Some("**/*0000.txt"), None)),
		measure("hit+glob (filter after copy)", samples, false, &|| {
			filter_after_copy("**/*0000.txt")
		}),
		measure("cold+glob (filter after copy)", samples, true, &|| {
			filter_after_copy("**/*0000.txt")
		}),
	];

	for arm in &arms {
		println!(
			"{:>28}  p50 {:>8.2}ms  p95 {:>8.2}ms  allocs {:>10}  alloc_mib {:>8.1}  peak_growth_mib \
			 {:>7.1}  entries {}",
			arm.name,
			arm.p50(),
			arm.p95(),
			arm.allocations,
			arm.bytes as f64 / 1024.0 / 1024.0,
			arm.peak_growth as f64 / 1024.0 / 1024.0,
			arm.entries,
		);
	}

	// The first four arms answer the same question and must agree; the glob arms
	// deliberately return fewer entries.
	let first = &arms[0];
	for arm in &arms[1..4] {
		assert!(
			arm.digest == first.digest && arm.entries == first.entries,
			"arm {} disagreed with {}: the arms must walk the same tree",
			arm.name,
			first.name
		);
	}
	println!("\nparity: 4 unfiltered arms agree, {} entries each", first.entries);

	let uncached = first;
	let cold = &arms[1];
	let hit = &arms[2];
	println!(
		"bookkeeping: cold-fill costs {:+.1}% wall and {:+.1}% allocated bytes over one uncached \
		 walk",
		(cold.p50() / uncached.p50() - 1.0) * 100.0,
		(cold.bytes as f64 / uncached.bytes as f64 - 1.0) * 100.0,
	);
	println!(
		"hit: p95 {:.1}% of cold p95, {:.1}% of cold allocated bytes",
		hit.p95() / cold.p95() * 100.0,
		hit.bytes as f64 / cold.bytes as f64 * 100.0,
	);
	let narrow = &arms[4];
	println!(
		"discarded work: a hit that keeps {} of {} entries still allocates {:.1}MiB, {:.1}% of the \
		 unfiltered hit",
		narrow.entries,
		first.entries,
		narrow.bytes as f64 / 1024.0 / 1024.0,
		narrow.bytes as f64 / hit.bytes as f64 * 100.0,
	);
	match peak_rss_bytes() {
		Some(peak) => println!("process peak rss {:.1}MiB", peak as f64 / 1024.0 / 1024.0),
		None => println!("process peak rss unavailable"),
	}
}
