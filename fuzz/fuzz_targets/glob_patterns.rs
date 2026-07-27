#![no_main]

//! Fuzzes glob normalization and matching in `veyyon-glob`.
//!
//! WHAT IS UNDER TEST. Every file the agent reads through the glob, grep, and
//! ast-grep tools is selected by this code. `build_glob_pattern` rewrites the
//! pattern the model wrote (separators, a `**/` prefix, unclosed braces),
//! `compile_glob` turns the result into a matcher, and `CompiledGlob::is_match`
//! answers per path with a hand-written fast path in front of the glob engine.
//!
//! THE PROPERTY THAT MATTERS MOST IS NOT "IT DID NOT PANIC". It is that the fast
//! path agrees with the engine. `classify_fast_path` recognizes six shapes and
//! answers them with string comparisons instead of running `globset`, so a shape
//! it recognizes but answers differently silently includes or excludes files.
//! Nothing downstream reports that: the tool returns a shorter list and the agent
//! believes it. `is_match_via_engine` exists so this target can ask both and
//! compare, which is the only way that class of bug is visible at all.
//!
//! THE SECOND PROPERTY IS THE WALK BOUND. `walk_depth_bound` tells the directory
//! walker how deep it needs to descend, and the walker prunes at that depth. If
//! the bound is ever smaller than the depth of a path the pattern actually
//! matches, files below it are never even offered to the matcher. That is the
//! same silent-loss shape as above, one layer earlier, so it is checked directly
//! rather than inferred.

use libfuzzer_sys::fuzz_target;
use veyyon_fuzz::{GlobLike, PathLike};
use veyyon_glob::{build_glob_pattern, compile_glob, walk_depth_bound};

/// Cap on how many paths one input is matched against, so an execution stays
/// well inside libFuzzer's per-input budget.
const MAX_PATHS: usize = 16;

fuzz_target!(|input: (GlobLike, bool, Vec<PathLike>)| {
	let (GlobLike(glob), recursive, paths) = input;
	if paths.len() > MAX_PATHS {
		return;
	}

	// Normalization must never panic, whatever the pattern.
	let pattern = build_glob_pattern(&glob, recursive);

	// Braces are balanced afterwards, which is the entire contract of the
	// unclosed-brace repair. An unbalanced result would be handed straight to the
	// glob engine and rejected, turning a repairable pattern into a tool error.
	let opens = pattern.chars().filter(|&ch| ch == '{').count();
	let closes = pattern.chars().filter(|&ch| ch == '}').count();
	assert!(
		opens <= closes,
		"{glob:?} normalized to {pattern:?} with {opens} unclosed braces against {closes} closes",
	);

	// Normalizing an already-normalized pattern must be a no-op. The glob tool
	// normalizes at the tool boundary and again inside `compile_glob`, so a
	// pattern that changed on the second pass would mean the two callers were
	// matching against different patterns.
	assert_eq!(
		build_glob_pattern(&pattern, recursive),
		pattern,
		"{glob:?} is not a fixed point after one normalization",
	);

	// Backslashes are path separators on Windows and are rewritten, so none may
	// survive normalization.
	assert!(
		!pattern.contains('\\'),
		"{glob:?} normalized to {pattern:?}, which still contains a backslash",
	);

	let bound = walk_depth_bound(&pattern);
	assert!(bound >= 1, "{pattern:?} claims a walk depth bound of {bound}");

	// A pattern the engine refuses is a tool error, which is the correct outcome
	// and not interesting past this point.
	let Ok(compiled) = compile_glob(&glob, recursive) else {
		return;
	};

	for PathLike(path) in &paths {
		let fast = compiled.is_match(path);
		let engine = compiled.is_match_via_engine(path);

		// The fast path is an optimization and must be indistinguishable from the
		// thing it optimizes.
		assert_eq!(
			fast, engine,
			"{glob:?} (normalized {pattern:?}, {compiled:?}) answers {fast} for {path:?} but the \
			 glob engine answers {engine}",
		);

		// The walk bound must never prune away a path that matches. Components are
		// counted the same way `walk_depth_bound` counts pattern segments, so the
		// two are comparable.
		if fast && bound != usize::MAX {
			let depth = path.split('/').filter(|seg| !seg.is_empty()).count().max(1);
			assert!(
				depth <= bound,
				"{pattern:?} matches {path:?} at depth {depth} but bounds the walk at {bound}, so \
				 the walker would never reach it",
			);
		}

		// Matching is a pure function of the path, and the walker calls it once per
		// entry while caching decisions per directory.
		assert_eq!(compiled.is_match(path), fast, "is_match is not deterministic for {path:?}");
	}
});
