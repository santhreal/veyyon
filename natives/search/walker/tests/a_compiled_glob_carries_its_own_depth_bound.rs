//! A compiled glob and the depth it can reach are one thing, so callers cannot
//! take one without the other.
//!
//! A walk-relative glob compiles with `literal_separator(true)`, so `*`, `?`,
//! and `[...]` never cross a `/`. A pattern with two segments therefore cannot
//! match anything three components deep, and descending past two components is
//! work whose every result is thrown away by the filter.
//!
//! THAT KNOWLEDGE USED TO LIVE AT THE CALL SITE, AND ONLY ONE CALLER HAD IT.
//! Three tools walked with a glob, and each one hand-assembled the same
//! sequence: normalize the pattern, compile it, choose a depth. The glob tool
//! passed `walk_depth_bound(pattern)`. The grep and ast-grep tools passed
//! `usize::MAX`, so `--glob 'src/*.ts'` walked every directory in the
//! repository and filtered everything below depth two back out. Nothing
//! reported it: the results were correct, they just cost a full traversal.
//!
//! `CompiledWalkGlob::compile` is the one entry point now, and `depth_bound()`
//! comes from the glob rather than from whatever the caller remembered to
//! compute. This suite pins both halves of the contract: the bound is small
//! enough to prune, and it never prunes a match.

use std::{collections::BTreeSet, fs, path::Path};

use veyyon_test_scratch::{TempTree, scratch_dir};
use veyyon_walker::{
	CompiledWalkGlob, Entry, EntryVisitor, FollowLinks, WalkControl, WalkFilter, WalkRequest,
};

/// A tree with a matching `.ts` file at every depth from one to four.
///
/// Every case below is about which of these four the walk reaches, so the file
/// names carry their depth and a failure names the depth that went wrong.
fn tree() -> TempTree {
	let scratch = scratch_dir("walker-glob-depth-bound");
	for relative in [
		"one.ts",
		"src/two.ts",
		"src/deep/three.ts",
		"src/deep/deeper/four.ts",
		"src/deep/deeper/four.txt",
	] {
		write_file(&scratch.path().join(relative));
	}
	scratch
}

fn write_file(path: &Path) {
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent).expect("parent directory should be created");
	}
	fs::write(path, b"x").expect("file should be written");
}

/// The request every case walks, differing only in the depth it is given.
fn request(root: &Path, glob: Option<CompiledWalkGlob>, max_depth: usize) -> WalkRequest {
	let mut filter = WalkFilter::files_only();
	if let Some(glob) = glob {
		filter = filter.glob(glob);
	}
	WalkRequest::new(root)
		.hidden(true)
		.gitignore(false)
		.follow_links(FollowLinks::Never)
		.emit_root(false)
		.depth(1, max_depth)
		.filter(filter)
}

fn matched_paths(request: &WalkRequest) -> BTreeSet<String> {
	request
		.collect_files()
		.expect("the walk should succeed")
		.into_iter()
		.map(|entry| entry.path)
		.collect()
}

fn paths(values: &[&str]) -> BTreeSet<String> {
	values.iter().map(|value| (*value).to_string()).collect()
}

/// Records every entry the walk hands it, so a test can say what was traversed
/// rather than only what was returned.
#[derive(Default)]
struct Recorder {
	seen: BTreeSet<String>,
}

impl EntryVisitor for Recorder {
	type Error = std::convert::Infallible;

	fn visit(&mut self, entry: Entry<'_>) -> Result<WalkControl, Self::Error> {
		self.seen.insert(entry.relative.to_string());
		Ok(WalkControl::Continue)
	}
}

fn traversed(request: &WalkRequest) -> BTreeSet<String> {
	let mut recorder = Recorder::default();
	request
		.stream(&mut recorder)
		.expect("the walk should succeed");
	recorder.seen
}

/// The bound the three call sites disagreed about, read off the pattern each
/// tool actually compiles.
///
/// `compile` applies the recursive rewrite before measuring, which is why the
/// same `*.ts` is bounded for ast-grep (non-recursive) and unbounded for grep
/// (recursive): the second one is `**/*.ts` by the time it is measured. A bound
/// computed from the raw string instead of the normalized one would answer 1
/// for both and prune away every nested match.
#[test]
fn the_bound_is_measured_after_normalization() {
	assert_eq!(
		CompiledWalkGlob::compile("*.ts", false)
			.expect("valid")
			.depth_bound(),
		1
	);
	assert_eq!(
		CompiledWalkGlob::compile("*.ts", true)
			.expect("valid")
			.depth_bound(),
		usize::MAX
	);
	assert_eq!(
		CompiledWalkGlob::compile("src/*.ts", true)
			.expect("valid")
			.depth_bound(),
		2
	);
	assert_eq!(
		CompiledWalkGlob::compile("a/b/c.ts", false)
			.expect("valid")
			.depth_bound(),
		3
	);
}

/// `**` and `{...}` disable the bound, because neither has a segment count.
///
/// This is the case where being wrong loses results rather than time, so the
/// unbounded answer is the safe one and it has to survive the new entry point.
#[test]
fn a_recursive_or_alternating_pattern_is_unbounded() {
	for pattern in ["**/*.ts", "src/**/*.ts", "{a/b,c}/d.ts", "src/[!x]/a.ts"] {
		assert_eq!(
			CompiledWalkGlob::compile(pattern, false)
				.expect("valid")
				.depth_bound(),
			usize::MAX,
			"{pattern} should not bound the walk"
		);
	}
}

/// A set reaches as deep as its deepest member.
///
/// `CompiledWalkGlob::new` takes a list, and a set matches when ANY pattern
/// matches, so taking the minimum or the first would prune the tree out from
/// under the deeper patterns.
#[test]
fn a_pattern_set_takes_the_deepest_bound() {
	let glob = CompiledWalkGlob::new(["*.ts", "a/b/c.ts"]).expect("valid");

	assert_eq!(glob.depth_bound(), 3);
}

/// An empty set matches nothing, and answers unbounded anyway.
///
/// Any bound is equally correct when nothing can match, and the conservative
/// answer is the one that can never remove a result if a later change makes an
/// empty set mean something else.
#[test]
fn an_empty_pattern_set_is_unbounded() {
	let glob = CompiledWalkGlob::new(Vec::<String>::new()).expect("valid");

	assert_eq!(glob.depth_bound(), usize::MAX);
	assert!(!glob.is_match("anything.ts"));
}

/// `compile` is exactly `new` on the normalized pattern, cache key included.
///
/// [`WalkFilter`] is hashed and compared as static traversal policy, so a
/// second way to build the same filter that did not compare equal to the first
/// would silently split the cache. The bound is derived from the patterns, so
/// equal values must also agree on it.
#[test]
fn compiling_a_raw_pattern_equals_compiling_the_normalized_one() {
	let compiled = CompiledWalkGlob::compile("*.ts", true).expect("valid");
	let normalized = CompiledWalkGlob::new(["**/*.ts"]).expect("valid");

	assert_eq!(compiled, normalized);
	assert_eq!(compiled.patterns(), normalized.patterns());
	assert_eq!(compiled.depth_bound(), normalized.depth_bound());
}

/// The normalization the shared crate owns still happens through this door.
///
/// Backslashes, the recursive prefix, and the unclosed `{` an LLM writes are
/// `veyyon-glob`'s rules. `compile` exists so a caller gets them without
/// naming that crate, which only works if it really applies them.
#[test]
fn compile_applies_the_shared_normalization() {
	let recursive = CompiledWalkGlob::compile("*.ts", true).expect("valid");
	assert!(recursive.is_match("src/deep/a.ts"));
	assert!(recursive.is_match("a.ts"));
	assert!(!recursive.is_match("a.tsx"));

	let rooted = CompiledWalkGlob::compile("*.ts", false).expect("valid");
	assert!(rooted.is_match("a.ts"));
	assert!(!rooted.is_match("src/a.ts"));

	let windows = CompiledWalkGlob::compile("src\\deep\\*.ts", false).expect("valid");
	assert!(windows.is_match("src/deep/three.ts"));

	let unclosed = CompiledWalkGlob::compile("*.{ts,tsx", true).expect("valid");
	assert!(unclosed.is_match("src/a.tsx"));
	assert_eq!(unclosed.patterns(), ["**/*.{ts,tsx}"]);
}

/// An invalid pattern is still an error, and it is the glob engine's error.
///
/// The new entry point must not swallow a bad pattern into an empty filter,
/// which would turn a typo into a silently empty result set.
#[test]
fn an_invalid_pattern_is_refused() {
	let error = CompiledWalkGlob::compile("[", false).expect_err("an unclosed class is not a glob");

	assert!(!error.to_string().is_empty());
}

/// The property the bound exists for: bounding the walk changes nothing.
///
/// Each pattern is walked twice, once at its own bound and once unbounded, and
/// the two must return the same files. This is the assertion that fails if a
/// bound is ever computed one component too small, which is the failure mode
/// that loses results silently.
#[test]
fn a_bounded_walk_returns_what_an_unbounded_one_returns() {
	let scratch = tree();
	let root = scratch.path();

	for (pattern, recursive, expected) in [
		("*.ts", false, paths(&["one.ts"])),
		("src/*.ts", true, paths(&["src/two.ts"])),
		("src/deep/*.ts", true, paths(&["src/deep/three.ts"])),
		(
			"*.ts",
			true,
			paths(&["one.ts", "src/two.ts", "src/deep/three.ts", "src/deep/deeper/four.ts"]),
		),
	] {
		let glob = CompiledWalkGlob::compile(pattern, recursive).expect("valid");
		let bound = glob.depth_bound();
		let bounded = matched_paths(&request(root, Some(glob), bound));
		let unbounded = matched_paths(&request(
			root,
			Some(CompiledWalkGlob::compile(pattern, recursive).expect("valid")),
			usize::MAX,
		));

		assert_eq!(bounded, expected, "{pattern} at its bound");
		assert_eq!(bounded, unbounded, "{pattern} lost a match to its bound");
	}
}

/// And the other half: the bound really does stop the walk.
///
/// The assertion above passes just as well against a bound of `usize::MAX`, so
/// on its own it proves nothing about cost. This one walks the same tree with
/// no glob filter at all, so every entry the walk reaches is reported, and
/// shows the depth the tools now pass is the difference between visiting four
/// levels and visiting two.
#[test]
fn the_bound_stops_the_walk_from_descending() {
	let scratch = tree();
	let root = scratch.path();

	let bound = CompiledWalkGlob::compile("src/*.ts", true)
		.expect("valid")
		.depth_bound();
	let bounded = traversed(&request(root, None, bound));
	let unbounded = traversed(&request(root, None, usize::MAX));

	assert!(bounded.contains("src/two.ts"), "the bound must keep what it can match: {bounded:?}");
	assert!(
		!bounded.contains("src/deep/three.ts"),
		"depth 3 is past the bound and must not be visited: {bounded:?}"
	);
	assert!(
		!bounded.contains("src/deep/deeper/four.ts"),
		"depth 4 is past the bound and must not be visited: {bounded:?}"
	);
	assert!(
		unbounded.contains("src/deep/deeper/four.ts"),
		"the unbounded walk is the control and must reach depth 4: {unbounded:?}"
	);
}
