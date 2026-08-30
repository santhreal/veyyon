//! The behaviour lock: for a pattern both engines accept, both engines must
//! find the same matches.
//!
//! WHY THIS IS THE TEST THAT MATTERS. Every engine in this workspace can end up
//! on either regex engine for the same pattern, and none of them tells the
//! caller which one ran. The N-API `grep` tool tries the Rust engine, and on
//! failure tries PCRE2. `rg --engine auto` does the same. So the engine a
//! search runs on is decided by whether the Rust engine happened to accept the
//! pattern, which is a property of the PATTERN and not of anything the user
//! chose.
//!
//! That is fine only while the two engines agree. If they disagree about where
//! a match starts, about whether a match happens at all, or about what a
//! character is, then adding one lookahead to a working pattern silently
//! changes the results of every other part of it, and nothing reports a
//! problem: both engines return `Ok`, both return matches, and the counts
//! differ.
//!
//! So this file runs a corpus through BOTH arms of the shared matcher and pins
//! the offsets to each other. It is the differential half of the extraction;
//! the structural half is in `one_owner.rs`.
//!
//! ## What is deliberately not here
//!
//! Patterns only one engine accepts, since there is nothing to compare, and
//! patterns whose divergence is documented below as a known difference. A
//! divergence discovered later belongs in [`KNOWN_DIVERGENCES`] with its
//! reason, not deleted from the corpus.

use grep_matcher::Matcher;
use grep_pcre2::RegexMatcherBuilder as PcreMatcherBuilder;
use grep_regex::RegexMatcherBuilder;
use veyyon_grep_kernel::{CompiledMatcher, pcre_matcher_defaults};

/// Every match in `haystack`, as `(start, end)` pairs.
///
/// Written with `find_at` in a loop rather than with a convenience iterator
/// because `find_at` is the one method the shared `Matcher` impl forwards, so
/// this exercises the code under test rather than a default method built on it.
///
/// An empty match advances by one byte, which is what the searcher does and
/// what keeps a pattern like `a*` from looping forever.
fn all_matches(matcher: &CompiledMatcher, haystack: &[u8]) -> Vec<(usize, usize)> {
	let mut found = Vec::new();
	let mut at = 0;
	while at <= haystack.len() {
		match matcher.find_at(haystack, at) {
			Ok(Some(matched)) => {
				found.push((matched.start(), matched.end()));
				at = if matched.end() > matched.start() {
					matched.end()
				} else {
					matched.end() + 1
				};
			},
			Ok(None) => break,
			Err(error) => panic!("match-time failure on {haystack:?}: {error}"),
		}
	}
	found
}

/// The Rust engine, configured the way a caller who wants plain matching gets
/// it.
fn rust(pattern: &str) -> Option<CompiledMatcher> {
	RegexMatcherBuilder::new()
		.build(pattern)
		.ok()
		.map(CompiledMatcher::Rust)
}

/// PCRE2, through the shared defaults, which is the only way this workspace
/// builds it.
fn pcre(pattern: &str) -> Option<CompiledMatcher> {
	let mut builder = PcreMatcherBuilder::new();
	pcre_matcher_defaults(&mut builder);
	builder.build(pattern).ok().map(CompiledMatcher::Pcre)
}

/// The corpus. Each entry is a pattern and the haystacks it is run against.
///
/// Chosen to cover the shapes an agent actually sends to `grep`: identifiers,
/// call sites with parentheses, alternations, anchors, character classes,
/// quantifiers, and the byte sequences that break naive engines.
const CORPUS: &[(&str, &[&[u8]])] = &[
	("needle", &[b"needle", b"a needle here", b"no match", b"", b"needleneedle"]),
	("fetchProvider", &[b"await fetchProvider(x)", b"fetchProviderName"]),
	(r"fn\s+\w+", &[b"fn main() {}", b"pub fn  build_matcher(", b"fnord"]),
	(r"^use ", &[b"use std::fmt;", b"   use std::fmt;", b""]),
	(r"\d+", &[b"v1.0.37", b"no digits", b"0", b"123abc456"]),
	("a|bb|ccc", &[b"ccc bb a", b"aaa", b"xyz"]),
	(r"[A-Z][a-z]+", &[b"CompiledMatcher", b"lowercase only", b"AB Cd"]),
	(r"\.rs$", &[b"lib.rs", b"lib.rss", b"rs"]),
	("colou?r", &[b"color and colour", b"colr"]),
	(r"\(", &[b"call(arg)", b"no parens"]),
	// The bytes that separate a real engine from a toy one.
	("needle", &[b"\x00\x00needle", b"before\x00needle\x00after"]),
	("needle", &[b"\xff\xfe needle", b"needle \xc3\x28"]),
	("caf", &["café au lait".as_bytes(), "naïve caf".as_bytes()]),
	(r"\w+", &["héllo wörld".as_bytes(), b"ascii words here"]),
	// Anchored and multi-line shapes, which is where line terminators show up.
	(r"^\s*//", &[b"// comment", b"   // indented", b"code // trailing"]),
	("end$", &[b"the end", b"end of line", b"ending"]),
];

/// Pattern and haystack pairs where the two engines are KNOWN to differ, each
/// with the reason.
///
/// Empty today. It exists so that a future divergence is recorded as a fact
/// with an explanation rather than quietly dropped from the corpus, which is
/// the only way a differential test stays honest as it ages.
const KNOWN_DIVERGENCES: &[(&str, &[u8], &str)] = &[];

fn is_known_divergence(pattern: &str, haystack: &[u8]) -> bool {
	KNOWN_DIVERGENCES
		.iter()
		.any(|(p, h, _)| *p == pattern && *h == haystack)
}

/// The differential itself.
///
/// Every pair is asserted as the FULL list of offsets rather than as a count,
/// because the failure that matters is the two engines finding the same NUMBER
/// of matches in different places: a count-only assertion passes straight
/// through it.
#[test]
fn both_engines_find_the_same_matches_across_the_corpus() {
	let mut compared = 0;

	for (pattern, haystacks) in CORPUS {
		let (Some(rust_matcher), Some(pcre_matcher)) = (rust(pattern), pcre(pattern)) else {
			continue;
		};

		for haystack in *haystacks {
			if is_known_divergence(pattern, haystack) {
				continue;
			}
			let from_rust = all_matches(&rust_matcher, haystack);
			let from_pcre = all_matches(&pcre_matcher, haystack);

			assert_eq!(
				from_rust, from_pcre,
				"pattern {pattern:?} disagrees on {haystack:?}: the Rust engine says {from_rust:?}, \
				 PCRE2 says {from_pcre:?}. A pattern that falls back from one engine to the other \
				 would change its own results.",
			);
			compared += 1;
		}
	}

	// NON-VACUITY. Every assertion above is inside two loops that a filter could
	// empty, and an empty corpus proves nothing at all.
	assert!(compared >= 40, "only {compared} pattern/haystack pairs were compared");
}

/// The corpus is not accidentally trivial: enough of it MATCHES.
///
/// Two engines that both find nothing agree perfectly, so a corpus of patterns
/// that miss everywhere would pass the differential while testing nothing. This
/// pins that most of the corpus produces real matches on the Rust engine.
#[test]
fn the_corpus_actually_matches_things() {
	let mut with_matches = 0;
	let mut total = 0;

	for (pattern, haystacks) in CORPUS {
		let Some(matcher) = rust(pattern) else {
			continue;
		};
		for haystack in *haystacks {
			total += 1;
			if !all_matches(&matcher, haystack).is_empty() {
				with_matches += 1;
			}
		}
	}

	assert!(total >= 40, "the corpus shrank to {total} pairs");
	assert!(
		with_matches * 2 > total,
		"only {with_matches} of {total} pairs match anything; the differential is comparing misses",
	);
}

/// Both engines must survive a haystack that is not text.
///
/// A binary file reaching the matcher is normal: binary DETECTION lives in the
/// searcher, and the searcher only consults it after the matcher has been
/// built. A panic or a match-time error here would take down a directory walk
/// on the first `.png` it met, which is why the bytes are asserted rather than
/// assumed.
#[test]
fn neither_engine_fails_on_binary_input() {
	let binary: Vec<u8> = (0u8..=255).cycle().take(4096).collect();

	for pattern in ["needle", r"\w+", r"\d", "a|b"] {
		let (Some(rust_matcher), Some(pcre_matcher)) = (rust(pattern), pcre(pattern)) else {
			panic!("{pattern} should compile on both engines");
		};

		// Not `all_matches`: this asserts only that the call returns rather than
		// that the two agree, since the byte soup contains invalid UTF-8 and the
		// engines are entitled to differ about what a character is inside it.
		assert!(rust_matcher.find_at(&binary, 0).is_ok(), "the Rust engine failed on binary input");
		assert!(pcre_matcher.find_at(&binary, 0).is_ok(), "PCRE2 failed on binary input");
	}
}

/// An empty haystack is a miss on both engines, not an error and not a match.
///
/// It gets its own test because an empty file is the most common input in any
/// real tree and because `find_at(haystack, 0)` with `haystack.len() == 0` is
/// the boundary where an off-by-one in the loop above would show up first.
#[test]
fn an_empty_haystack_is_a_miss_on_both_engines() {
	for pattern in ["needle", r"\d+", "^end$"] {
		let (Some(rust_matcher), Some(pcre_matcher)) = (rust(pattern), pcre(pattern)) else {
			panic!("{pattern} should compile on both engines");
		};

		assert_eq!(all_matches(&rust_matcher, b""), Vec::new());
		assert_eq!(all_matches(&pcre_matcher, b""), Vec::new());
	}
}
