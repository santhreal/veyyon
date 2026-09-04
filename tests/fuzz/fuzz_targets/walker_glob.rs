#![no_main]

//! Fuzzes glob compilation and matching in `veyyon-walker`.
//!
//! WHAT IS UNDER TEST. `CompiledWalkGlob::new` compiles caller-supplied
//! patterns and is declared infallible-or-`Err`: every malformed pattern must
//! come back as `globset::Error`, never as a panic. Patterns reach it from user
//! config and from tool arguments the agent writes, so "the pattern was
//! nonsense" has to be a returned error the caller can report, not a process
//! abort.
//!
//! `is_match` is fuzzed against the same compiled set because the matcher is a
//! separate machine from the parser: a pattern can compile and still drive the
//! matcher into an index it did not expect on some particular subject string.
//!
//! WHY THE EQUALITY PROPERTY IS HERE TOO. `CompiledWalkGlob` implements `Eq`
//! and `Hash` over the pattern list only, deliberately, so it can key a
//! traversal policy cache. That is only sound if equal pattern lists really do
//! behave identically. If they ever diverge, the cache serves one filter's
//! results for another's query and the walk silently returns the wrong files,
//! which is the kind of bug that never produces a stack trace.

use std::{
	collections::hash_map::DefaultHasher,
	hash::{Hash, Hasher},
};

use libfuzzer_sys::fuzz_target;
use veyyon_fuzz::PathLike;
use veyyon_walker::CompiledWalkGlob;

/// Cap on pattern count. Globset compiles each pattern into a regex, so an
/// unbounded list is a timeout report rather than a bug report.
const MAX_PATTERNS: usize = 8;

fn hash_of(glob: &CompiledWalkGlob) -> u64 {
	let mut hasher = DefaultHasher::new();
	glob.hash(&mut hasher);
	hasher.finish()
}

fuzz_target!(|input: (Vec<PathLike>, Vec<PathLike>)| {
	let (patterns, subjects) = input;
	if patterns.len() > MAX_PATTERNS || subjects.len() > MAX_PATTERNS {
		return;
	}
	let patterns: Vec<String> = patterns.into_iter().map(|pattern| pattern.0).collect();

	// A malformed pattern is an `Err`, and that is the entire contract. Reaching
	// the `Ok` arm at all is what the rest of this target needs.
	let Ok(compiled) = CompiledWalkGlob::new(patterns.clone()) else {
		return;
	};

	// The accessor must hand back what went in, unchanged and in order. It is the
	// only way a caller can report which pattern it is filtering on, and the
	// cache key above is derived from it.
	assert_eq!(compiled.patterns(), patterns.as_slice());

	// Matching must not panic for any subject, including empty, separator-only,
	// and multi-byte ones.
	for subject in &subjects {
		let _ = compiled.is_match(&subject.0);
	}
	let _ = compiled.is_match("");

	// Compiling the same list twice gives two values that are `Eq`, hash alike,
	// and agree on every subject. The third of those is the one that matters:
	// `Eq` and `Hash` ignore the compiled matcher, so this is what justifies
	// using the value as a cache key at all.
	let Ok(recompiled) = CompiledWalkGlob::new(patterns) else {
		panic!("a pattern list that compiled once failed to compile again");
	};
	assert_eq!(compiled, recompiled);
	assert_eq!(hash_of(&compiled), hash_of(&recompiled));
	for subject in &subjects {
		assert_eq!(
			compiled.is_match(&subject.0),
			recompiled.is_match(&subject.0),
			"two equal CompiledWalkGlob values disagree on {:?}",
			subject.0,
		);
	}
});
