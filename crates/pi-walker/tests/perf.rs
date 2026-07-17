//! Ignored deterministic timing harness for pi-walker.
//!
//! Run with:
//! cargo test --profile ci -p pi-walker --test perf -- --ignored --nocapture
//! --test-threads=1

use std::{
	fmt::Write as _,
	fs,
	hint::black_box,
	path::{Path, PathBuf},
	sync::LazyLock,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use pi_walker::{WalkDetail, WalkOrder, WalkRequest};

const DIRECTORY_FANOUT: [usize; 5] = [5, 5, 5, 4, 2];
const CONTENT_FILE_COUNT: usize = 15_000;
const NODE_MODULES_PACKAGES: usize = 50;
const NODE_MODULES_FILES_PER_PACKAGE: usize = 10;
const MEASURED_ITERATIONS: usize = 5;

static SYNTHETIC_ROOT: LazyLock<PathBuf> = LazyLock::new(build_synthetic_tree);

/// Real-corpus twin of the synthetic benches: walks the tree named by
/// `PI_WALKER_PERF_ROOT` (e.g. a large repo with node_modules) so throughput
/// numbers reflect real directory shapes, not just the generated layout.
/// Skips LOUDLY when the variable is unset so the plain `--ignored` run still
/// passes without it.
#[test]
#[ignore = "run with: PI_WALKER_PERF_ROOT=/path/to/large/repo cargo test --profile ci -p \
            pi-walker --test perf -- --ignored --nocapture --test-threads=1"]
fn perf_walk_real_corpus() {
	let Some(root) = std::env::var_os("PI_WALKER_PERF_ROOT") else {
		println!("BENCH perf_walk_real_corpus: SKIPPED — set PI_WALKER_PERF_ROOT=/path/to/large/repo to run");
		return;
	};
	let root = PathBuf::from(root);
	assert!(root.is_dir(), "PI_WALKER_PERF_ROOT must name an existing directory: {}", root.display());
	for (name, gitignore) in [
		("perf_walk_real_corpus_unordered_gitignore", true),
		("perf_walk_real_corpus_unordered_raw", false),
	] {
		let mut count = 0usize;
		run_bench(name, || {
			let candidates = WalkRequest::new(&root)
				.hidden(true)
				.gitignore(gitignore)
				.skip_git(true)
				.skip_node_modules(true)
				.directory_errors(pi_walker::DirectoryErrorMode::SkipSkippable)
				.cache(false)
				.order(WalkOrder::Unordered)
				.collect_file_candidates()
				.expect("collect real-corpus candidates");
			count = candidates.len();
			count
		});
		println!("  ({count} files)");
	}
}

/// Isolates the per-entry `Gitignore::matched` cost that separates the
/// gitignore walk from the raw walk: matching with the walker's ABSOLUTE
/// paths (today's call shape — every call re-strips the matcher root and
/// rebuilds the candidate) vs matcher-root-RELATIVE paths.
#[test]
#[ignore = "run with: PI_WALKER_PERF_ROOT=/path/to/large/repo cargo test --profile ci -p \
            pi-walker --test perf -- --ignored --nocapture --test-threads=1"]
fn perf_gitignore_match_cost() {
	let root = match std::env::var_os("PI_WALKER_PERF_ROOT") {
		Some(root) => PathBuf::from(root),
		None => {
			println!("BENCH perf_gitignore_match_cost: SKIPPED — set PI_WALKER_PERF_ROOT to run");
			return;
		},
	};
	let mut builder = ignore::gitignore::GitignoreBuilder::new(&root);
	builder.add(root.join(".gitignore"));
	let matcher = builder.build().expect("build root gitignore");
	let absolutes = WalkRequest::new(&root)
		.hidden(true)
		.gitignore(false)
		.skip_git(true)
		.skip_node_modules(true)
		.order(WalkOrder::Unordered)
		.collect_file_candidates()
		.expect("collect candidates")
		.into_iter()
		.map(|c| c.path)
		.collect::<Vec<_>>();
	let relatives = absolutes
		.iter()
		.map(|p| p.strip_prefix(&root).expect("under root").to_path_buf())
		.collect::<Vec<_>>();
	println!("  matching {} files against {} root .gitignore globs", absolutes.len(), matcher.len());
	run_bench("perf_gitignore_match_absolute", || {
		absolutes
			.iter()
			.filter(|p| matcher.matched(p, false).is_ignore())
			.count()
	});
	run_bench("perf_gitignore_match_relative", || {
		relatives
			.iter()
			.filter(|p| matcher.matched(p, false).is_ignore())
			.count()
	});
	// The walk also matches every entry against every ANCESTOR repo matcher in
	// the chain (e.g. an outer monorepo .gitignore) and the global gitignore.
	let mut ancestor_matchers = Vec::new();
	let mut current = root.parent();
	while let Some(dir) = current {
		let file = dir.join(".gitignore");
		if file.is_file() {
			let mut builder = ignore::gitignore::GitignoreBuilder::new(dir);
			builder.add(&file);
			if let Ok(matcher) = builder.build()
				&& !matcher.is_empty()
			{
				ancestor_matchers.push((dir.to_path_buf(), matcher));
			}
		}
		if dir.join(".git").exists() || dir.join(".jj").exists() {
			break;
		}
		current = dir.parent();
	}
	for (dir, ancestor) in &ancestor_matchers {
		println!("  ancestor matcher {} ({} globs)", dir.display(), ancestor.len());
		run_bench("perf_gitignore_match_ancestor", || {
			absolutes
				.iter()
				.filter(|p| ancestor.matched(p, false).is_ignore())
				.count()
		});
	}
	let (global, _err) = ignore::gitignore::Gitignore::global();
	if !global.is_empty() {
		println!("  global gitignore ({} globs)", global.len());
		run_bench("perf_gitignore_match_global", || {
			absolutes
				.iter()
				.filter(|p| global.matched(p, false).is_ignore())
				.count()
		});
	}
}

/// Isolates the PER-WALK SETUP cost of the gitignore path: `Gitignore::global()`
/// (parses git config every walk) and ancestor-matcher construction
/// (`build_parents` compiles a GlobSet for every ancestor `.gitignore` between
/// the repo root above the walk root and the walk root — for a walk root nested
/// in an outer repo this recompiles the outer repo's full ignore file each walk).
#[test]
#[ignore = "run with: PI_WALKER_PERF_ROOT=/path/to/large/repo cargo test --profile ci -p \
            pi-walker --test perf -- --ignored --nocapture --test-threads=1"]
fn perf_gitignore_setup_cost() {
	let root = match std::env::var_os("PI_WALKER_PERF_ROOT") {
		Some(root) => PathBuf::from(root),
		None => {
			println!("BENCH perf_gitignore_setup_cost: SKIPPED — set PI_WALKER_PERF_ROOT to run");
			return;
		},
	};
	run_bench("perf_gitignore_setup_global", || {
		let (matcher, _err) = ignore::gitignore::Gitignore::global();
		usize::from(!matcher.is_empty())
	});
	// Ancestor `.gitignore` builds, mirroring IgnoreState::build_parents +
	// load_gitignore for every ancestor up to the outermost repo marker.
	let mut ancestors = Vec::new();
	let mut current = root.parent();
	let mut repo_start = None;
	while let Some(path) = current {
		ancestors.push(path.to_path_buf());
		if repo_start.is_none() && (path.join(".git").exists() || path.join(".jj").exists()) {
			repo_start = Some(ancestors.len() - 1);
		}
		current = path.parent();
	}
	let chain: Vec<PathBuf> = match repo_start {
		Some(repo_start) => ancestors[..=repo_start].to_vec(),
		None => Vec::new(),
	};
	println!("  ancestor chain above walk root: {} dirs", chain.len());
	run_bench("perf_gitignore_setup_ancestors", || {
		let mut built = 0usize;
		for dir in &chain {
			for file in [dir.join(".ignore"), dir.join(".gitignore"), dir.join(".git/info/exclude")] {
				if !file.is_file() {
					continue;
				}
				let mut builder = ignore::gitignore::GitignoreBuilder::new(dir);
				builder.add(&file);
				if builder.build().is_ok_and(|matcher| !matcher.is_empty()) {
					built += 1;
				}
			}
		}
		built
	});
	// The walk root's own matcher build (89-glob .gitignore for veyyon).
	run_bench("perf_gitignore_setup_root_build", || {
		let mut builder = ignore::gitignore::GitignoreBuilder::new(&root);
		builder.add(root.join(".gitignore"));
		builder.build().map(|matcher| matcher.len()).unwrap_or(0)
	});
}

#[test]
#[ignore = "run with: cargo test --profile ci -p pi-walker --test perf -- --ignored --nocapture \
            --test-threads=1"]
fn perf_walk_candidates_unordered_gitignore() {
	let root = SYNTHETIC_ROOT.as_path();
	run_bench("perf_walk_candidates_unordered_gitignore", || {
		let candidates = WalkRequest::new(root)
			.hidden(true)
			.gitignore(true)
			.skip_git(true)
			.skip_node_modules(true)
			.order(WalkOrder::Unordered)
			.collect_file_candidates()
			.expect("collect unordered gitignore candidates");
		let count = candidates.len();
		assert!(count > 14_000, "expected a full candidate set, got {count}");
		count
	});
}

#[test]
#[ignore = "run with: cargo test --profile ci -p pi-walker --test perf -- --ignored --nocapture \
            --test-threads=1"]
fn perf_walk_candidates_path_order_no_gitignore() {
	let root = SYNTHETIC_ROOT.as_path();
	run_bench("perf_walk_candidates_path_order_no_gitignore", || {
		let candidates = WalkRequest::new(root)
			.hidden(true)
			.gitignore(false)
			.skip_git(true)
			.skip_node_modules(true)
			.order(WalkOrder::Path)
			.collect_file_candidates()
			.expect("collect path-ordered candidates without gitignore");
		let count = candidates.len();
		assert!(count > 15_000, "expected unignored candidates, got {count}");
		count
	});
}

#[test]
#[ignore = "run with: cargo test --profile ci -p pi-walker --test perf -- --ignored --nocapture \
            --test-threads=1"]
fn perf_walk_collect_full_detail() {
	let root = SYNTHETIC_ROOT.as_path();
	run_bench("perf_walk_collect_full_detail", || {
		let outcome = WalkRequest::new(root)
			.hidden(true)
			.gitignore(true)
			.skip_git(true)
			.skip_node_modules(true)
			.order(WalkOrder::Unordered)
			.detail(WalkDetail::Full)
			.collect()
			.expect("collect full-detail entries");
		let count = outcome.entries.len();
		assert!(count > 15_000, "expected full-detail entries, got {count}");
		count
	});
}

fn run_bench(mut name: &str, mut run: impl FnMut() -> usize) {
	black_box(run());

	let mut timings = [Duration::ZERO; MEASURED_ITERATIONS];
	for timing in &mut timings {
		let started = Instant::now();
		let observed = run();
		let elapsed = started.elapsed();
		black_box(observed);
		*timing = elapsed;
	}

	timings.sort_unstable();
	let median_ms = timings[MEASURED_ITERATIONS / 2].as_secs_f64() * 1_000.0;
	name = black_box(name);
	println!("BENCH {name}: {median_ms:.3} ms");
}

fn build_synthetic_tree() -> PathBuf {
	let root = unique_temp_root("pi-walker-perf");
	fs::create_dir_all(&root).expect("create synthetic root");
	fs::create_dir_all(root.join(".git")).expect("create repo marker");

	let directories = create_directory_layout(&root);
	create_gitignores(&directories);
	create_content_files(&directories);
	create_node_modules(&root);

	root
}

fn unique_temp_root(prefix: &str) -> PathBuf {
	let timestamp = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.expect("system time is after UNIX_EPOCH")
		.as_nanos();
	let pid = std::process::id();
	std::env::temp_dir().join(format!("{prefix}-{pid}-{timestamp}"))
}

fn create_directory_layout(root: &Path) -> Vec<PathBuf> {
	let mut directories = Vec::with_capacity(1_700);
	directories.push(root.to_path_buf());

	let mut level = vec![root.to_path_buf()];
	for (depth, fanout) in DIRECTORY_FANOUT.into_iter().enumerate() {
		let mut next_level = Vec::with_capacity(level.len() * fanout);
		for (parent_index, parent) in level.iter().enumerate() {
			for child in 0..fanout {
				let directory = parent.join(format!("d{depth:02}-{parent_index:04}-{child:02}"));
				fs::create_dir_all(&directory).expect("create synthetic directory");
				directories.push(directory.clone());
				next_level.push(directory);
			}
		}
		level = next_level;
	}

	directories
}

fn create_gitignores(directories: &[PathBuf]) {
	for (directory_id, directory) in directories.iter().enumerate() {
		if directory_id.is_multiple_of(10) {
			let pattern = format!("/ignored-{directory_id:04}-*.txt\n");
			fs::write(directory.join(".gitignore"), pattern).expect("write synthetic gitignore");
		}
	}
}

fn create_content_files(directories: &[PathBuf]) {
	for file_index in 0..CONTENT_FILE_COUNT {
		let directory_id = file_index % directories.len();
		let local_index = file_index / directories.len();
		let file_name = if directory_id.is_multiple_of(10) && local_index == 0 {
			format!("ignored-{directory_id:04}-{local_index:03}.txt")
		} else {
			format!("file-{directory_id:04}-{local_index:03}.txt")
		};
		let path = directories[directory_id].join(file_name);
		fs::write(path, synthetic_content(file_index)).expect("write synthetic content file");
	}
}

fn create_node_modules(root: &Path) {
	let node_modules = root.join("node_modules");
	for package in 0..NODE_MODULES_PACKAGES {
		let package_dir = node_modules.join(format!("pkg-{package:02}"));
		fs::create_dir_all(&package_dir).expect("create synthetic node_modules package");
		for file in 0..NODE_MODULES_FILES_PER_PACKAGE {
			let content_index = CONTENT_FILE_COUNT + package * NODE_MODULES_FILES_PER_PACKAGE + file;
			let path = package_dir.join(format!("file-{file:02}.js"));
			fs::write(path, synthetic_content(content_index))
				.expect("write synthetic node_modules file");
		}
	}
}

fn synthetic_content(file_index: usize) -> String {
	let target_len = 512 + (file_index * 73) % 3_488;
	let has_common_token = (file_index * 37) % 100 < 60;
	let has_rare_token = file_index.is_multiple_of(100);
	let mut content = String::with_capacity(target_len + 96);

	if has_common_token {
		writeln!(content, "common token needle in file {file_index:05}").expect("write to String");
	} else {
		writeln!(content, "ordinary haystack line in file {file_index:05}").expect("write to String");
	}
	if has_rare_token {
		writeln!(content, "rare token NEEDLE_RARE in file {file_index:05}").expect("write to String");
	}

	let filler = format!("line {file_index:05} deterministic pi walker payload text\n");
	while content.len() < target_len {
		content.push_str(&filler);
	}

	content
}
