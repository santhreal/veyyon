#![allow(
	clippy::tabs_in_doc_comments,
	reason = "the workspace sets hard_tabs, and rustfmt applies it inside doc-comment code blocks \
	          too, which is what this lint objects to. The two cannot both be satisfied by editing \
	          the examples, and the formatter is the enforced gate while this lint is style-only, \
	          so the formatter wins here rather than being fought in each doc example."
)]

//! The compiled pattern, owned once for every search engine in this workspace.
//!
//! Three engines in this repository compile a pattern and hand it to
//! `grep-searcher`: the N-API `grep` and `search` tools in `veyyon-natives`,
//! the `grep` shell builtin in `veyyon_uu_grep`, and the `rg` shell builtin in
//! the same crate. Each of them can end up on either of two regex engines. The
//! Rust engine (`grep-regex`) is the fast default, and PCRE2 (`grep-pcre2`) is
//! the one that understands lookaround and backreferences, which the Rust
//! engine deliberately omits.
//!
//! That gives every engine the same problem: a value that is one of two matcher
//! types, chosen at compile time of the pattern rather than at compile time of
//! the program. All three had solved it by declaring their own
//! `enum CompiledMatcher { Rust(..), Pcre(..) }`, three byte-identical copies
//! in three files. This crate owns that type, and the copies are gone.
//!
//! ```
//! use grep_matcher::Matcher;
//! use grep_pcre2::RegexMatcherBuilder as PcreMatcherBuilder;
//! use grep_regex::RegexMatcherBuilder;
//! use veyyon_grep_kernel::{CompiledMatcher, pcre_matcher_defaults};
//!
//! let rust = CompiledMatcher::Rust(RegexMatcherBuilder::new().build("wor.d")?);
//! assert!(rust.find_at(b"hello world", 0)?.is_some());
//!
//! // The same value, on the engine that can look behind.
//! let mut builder = PcreMatcherBuilder::new();
//! pcre_matcher_defaults(&mut builder);
//! let pcre = CompiledMatcher::Pcre(builder.build("(?<=hello )world")?);
//! assert!(pcre.find_at(b"hello world", 0)?.is_some());
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! ## Why the enum and not a trait object
//!
//! `grep_matcher::Matcher` has an associated `Captures` type and an associated
//! `Error` type, so it is not object safe: you cannot hold a
//! `Box<dyn Matcher>`. A two-variant enum is the shape the ripgrep libraries
//! themselves use for this, and it keeps the dispatch a predictable branch
//! rather than a virtual call.
//!
//! ## Two ways to use it, both supported on purpose
//!
//! [`CompiledMatcher`] implements [`Matcher`], so you can pass it straight to a
//! searcher and let each call take the branch. That is what the N-API tools do,
//! because they hold one matcher and search many files with it.
//!
//! The variants are also public, so you can match once at the top of a search
//! and pass the CONCRETE matcher down, which monomorphizes the whole search
//! path per engine and takes the branch out of the inner loop entirely. That is
//! what the two shell builtins do. Neither is wrong; they are different trades,
//! and sharing the type does not force either engine to change which one it
//! makes.

mod searcher;

use std::fmt;

use grep_matcher::{Match, Matcher, NoCaptures, NoError};
use grep_pcre2::{RegexMatcher as PcreMatcher, RegexMatcherBuilder as PcreMatcherBuilder};
use grep_regex::RegexMatcher;
pub use searcher::{SearcherSpec, build_searcher};

/// A pattern that has been compiled, on whichever engine accepted it.
///
/// The variants are public because a caller that knows it will search many
/// files is better off matching once and monomorphizing; see the crate docs.
pub enum CompiledMatcher {
	/// The Rust regex engine, `grep-regex`. Linear time, no lookaround.
	Rust(RegexMatcher),
	/// PCRE2, `grep-pcre2`. Understands lookaround and backreferences.
	Pcre(PcreMatcher),
}

/// A failure from whichever engine the pattern compiled on.
///
/// The Rust engine's error type is [`NoError`], the uninhabited type: it cannot
/// fail at match time, only at compile time. PCRE2 can fail at match time, for
/// instance when a pathological pattern exhausts its backtracking limit.
/// Keeping both in one enum means a caller handles "the search failed" once
/// instead of once per engine.
#[derive(Debug)]
pub enum CompiledMatcherError {
	/// From the Rust engine. Uninhabited in practice, kept so the enum mirrors
	/// the matcher it belongs to.
	Rust(NoError),
	/// From PCRE2. Reachable: match limits and recursion limits surface here.
	Pcre(grep_pcre2::Error),
}

impl fmt::Display for CompiledMatcherError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Rust(err) => err.fmt(formatter),
			Self::Pcre(err) => err.fmt(formatter),
		}
	}
}

impl std::error::Error for CompiledMatcherError {}

impl Matcher for CompiledMatcher {
	type Captures = NoCaptures;
	type Error = CompiledMatcherError;

	fn find_at(&self, haystack: &[u8], at: usize) -> Result<Option<Match>, Self::Error> {
		match self {
			Self::Rust(matcher) => matcher
				.find_at(haystack, at)
				.map_err(CompiledMatcherError::Rust),
			Self::Pcre(matcher) => matcher
				.find_at(haystack, at)
				.map_err(CompiledMatcherError::Pcre),
		}
	}

	fn new_captures(&self) -> Result<Self::Captures, Self::Error> {
		Ok(NoCaptures::new())
	}
}

impl CompiledMatcher {
	/// Which engine compiled the pattern.
	///
	/// For diagnostics and for tests that need to assert an engine was chosen,
	/// not merely that a match was found. A pattern silently landing on the
	/// other engine changes both its performance and which syntax it accepts,
	/// so this is a fact worth being able to assert.
	#[must_use]
	pub const fn engine(&self) -> MatcherEngine {
		match self {
			Self::Rust(_) => MatcherEngine::Rust,
			Self::Pcre(_) => MatcherEngine::Pcre,
		}
	}
}

/// Which of the two regex engines a pattern compiled on.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MatcherEngine {
	/// `grep-regex`.
	Rust,
	/// `grep-pcre2`.
	Pcre,
}

/// The three PCRE2 settings every engine in this workspace wants, applied once.
///
/// `utf` and `ucp` together are what make PCRE2 agree with the Rust engine
/// about what a character is: without them `\w` and `.` are byte-oriented, so
/// the same pattern silently matches differently depending only on which engine
/// happened to accept it. `jit_if_available` compiles the pattern to machine
/// code when the platform supports it and is a no-op when it does not.
///
/// This does NOT set case, word, whole-line or multiline options. Those differ
/// legitimately between the three call sites, since each derives them from its
/// own flag surface, and folding them in here would mean a caller could not
/// tell which of its flags this function had already decided for it.
pub fn pcre_matcher_defaults(builder: &mut PcreMatcherBuilder) -> &mut PcreMatcherBuilder {
	builder.utf(true).ucp(true).jit_if_available(true)
}

/// Escape a pattern so it matches its own bytes: the one owner of literal
/// escaping.
///
/// This is what `-F`/`--fixed-strings` needs, and what a literal DEMOTION needs
/// when a pattern is malformed as a regex and the engine falls back to
/// searching its text.
///
/// WHY IT LIVES HERE. There were two spellings. `veyyon-natives` called
/// `regex::escape`, and the `grep` builtin hand-rolled a `const META: &[char]`
/// list with a comment saying it mirrored `regex::escape`. It did, character
/// for character, and that is precisely the problem: nothing kept it mirroring.
/// `regex-syntax` has added meta characters before, and the day it adds another
/// the hand-rolled copy stops escaping it, so a `-F` search for text containing
/// that character silently becomes a REGEX search. That is recall loss
/// with no error, in the one mode whose entire promise is that the pattern is
/// not a regex.
///
/// The escaping rule is not ours to own, so this delegates to
/// `regex_syntax::escape`, which is where `regex::escape` gets it from. The
/// function exists so there is one name to import and one place the reason is
/// written down, not to add a rule of its own.
#[must_use]
pub fn escape_literal_pattern(pattern: &str) -> String {
	regex_syntax::escape(pattern)
}

#[cfg(test)]
mod tests {
	use grep_regex::RegexMatcherBuilder;

	use super::*;

	fn rust(pattern: &str) -> CompiledMatcher {
		CompiledMatcher::Rust(
			RegexMatcherBuilder::new()
				.build(pattern)
				.expect("valid pattern"),
		)
	}

	fn pcre(pattern: &str) -> CompiledMatcher {
		let mut builder = PcreMatcherBuilder::new();
		pcre_matcher_defaults(&mut builder);
		CompiledMatcher::Pcre(builder.build(pattern).expect("valid pattern"))
	}

	/// The whole point of the enum: one value, either engine, one `Matcher`
	/// impl. If dispatch ever went to the wrong arm this is what would catch
	/// it, so the two arms are given patterns that produce DIFFERENT offsets
	/// rather than the same answer twice.
	#[test]
	fn both_variants_dispatch_to_their_own_engine() {
		let haystack = b"alpha beta gamma";

		let rust_match = rust("beta").find_at(haystack, 0).expect("no match error");
		assert_eq!(rust_match.map(|m| (m.start(), m.end())), Some((6, 10)));

		let pcre_match = pcre("gamma").find_at(haystack, 0).expect("no match error");
		assert_eq!(pcre_match.map(|m| (m.start(), m.end())), Some((11, 16)));
	}

	/// `find_at` starts AT an offset rather than searching a slice, which is how
	/// the searcher walks a line for a second match. Getting this wrong shows up
	/// as duplicate matches at the same column, so the offset is asserted
	/// exactly.
	#[test]
	fn find_at_resumes_from_the_offset_it_is_given() {
		let haystack = b"ab ab ab";

		for matcher in [rust("ab"), pcre("ab")] {
			let first = matcher
				.find_at(haystack, 0)
				.expect("no match error")
				.expect("a match");
			assert_eq!((first.start(), first.end()), (0, 2));

			let second = matcher
				.find_at(haystack, 2)
				.expect("no match error")
				.expect("a match");
			assert_eq!((second.start(), second.end()), (3, 5));

			let last = matcher
				.find_at(haystack, 5)
				.expect("no match error")
				.expect("a match");
			assert_eq!((last.start(), last.end()), (6, 8));

			assert!(
				matcher
					.find_at(haystack, 8)
					.expect("no match error")
					.is_none()
			);
		}
	}

	/// A miss is `Ok(None)`, not an error. A caller that treated a miss as a
	/// failure would abort a whole directory walk on the first file without a
	/// match, so both engines are pinned to the same shape.
	#[test]
	fn a_miss_is_not_an_error_on_either_engine() {
		for matcher in [rust("needle"), pcre("needle")] {
			assert!(
				matcher
					.find_at(b"haystack", 0)
					.expect("no match error")
					.is_none()
			);
		}
	}

	/// The reason PCRE2 is here at all. Lookbehind is the canonical case the
	/// Rust engine rejects by design, so this test is also the proof that the
	/// PCRE arm is not decorative: delete the arm and this fails to compile a
	/// pattern.
	#[test]
	fn pcre_accepts_the_syntax_the_rust_engine_refuses() {
		assert!(RegexMatcherBuilder::new().build("(?<=foo)bar").is_err());

		let matched = pcre("(?<=foo)bar")
			.find_at(b"foobar", 0)
			.expect("no match error");
		assert_eq!(matched.map(|m| (m.start(), m.end())), Some((3, 6)));
	}

	/// `ucp` is what makes `\w` mean "a word character" rather than "an ASCII
	/// word character" on PCRE2. Without it this pattern misses, and a user's
	/// search would silently return fewer results on one engine than the other:
	/// the exact recall difference `pcre_matcher_defaults` exists to prevent.
	#[test]
	fn the_pcre_defaults_make_unicode_classes_agree_with_the_rust_engine() {
		let haystack = "naïve".as_bytes();

		let with_defaults = pcre(r"\w+").find_at(haystack, 0).expect("no match error");
		assert_eq!(with_defaults.map(|m| (m.start(), m.end())), Some((0, haystack.len())));

		let rust_answer = rust(r"\w+").find_at(haystack, 0).expect("no match error");
		assert_eq!(rust_answer.map(|m| (m.start(), m.end())), Some((0, haystack.len())));

		// The control: the same pattern WITHOUT the defaults stops at the `ï`,
		// which is the divergence this helper closes.
		let bare = CompiledMatcher::Pcre(
			PcreMatcherBuilder::new()
				.build(r"\w+")
				.expect("valid pattern"),
		);
		let bare_answer = bare
			.find_at(haystack, 0)
			.expect("no match error")
			.expect("a match");
		assert_eq!((bare_answer.start(), bare_answer.end()), (0, 2));
	}

	/// `engine()` reports the arm rather than guessing from behaviour. Callers
	/// use it to tell an operator which engine ran, and a wrong answer there is
	/// a misleading diagnostic rather than a wrong search, which is why it is
	/// pinned separately from matching.
	#[test]
	fn engine_reports_the_variant_that_was_built() {
		assert_eq!(rust("a").engine(), MatcherEngine::Rust);
		assert_eq!(pcre("a").engine(), MatcherEngine::Pcre);
	}

	/// Invalid UTF-8 in the haystack is SEARCHED, not rejected, and both engines
	/// return the same answer.
	///
	/// This is the fact worth pinning about `utf(true)`. Enabling UTF mode used
	/// to mean PCRE2 validated every subject, so a byte of invalid UTF-8, which
	/// is to say any binary file, turned a search into a match-time error. PCRE2
	/// 10.34 added `PCRE2_MATCH_INVALID_UTF` and `grep-pcre2` always sets it, so
	/// the search runs and finds what the Rust engine finds.
	///
	/// It is pinned because it is the exact property `pcre_matcher_defaults`
	/// could take away: if the shared defaults ever moved to a configuration
	/// without that behaviour, grep would start reporting errors on binary files
	/// only when the pattern happened to land on PCRE2, which is a difference no
	/// caller could predict from the pattern it wrote.
	#[test]
	fn invalid_utf8_is_searched_rather_than_rejected_on_both_engines() {
		let haystack = b"\xff\xfe needle";

		let pcre_answer = pcre("needle")
			.find_at(haystack, 0)
			.expect("not a match-time error");
		assert_eq!(pcre_answer.map(|m| (m.start(), m.end())), Some((3, 9)));

		let rust_answer = rust("needle").find_at(haystack, 0).expect("no match error");
		assert_eq!(rust_answer.map(|m| (m.start(), m.end())), Some((3, 9)));
	}

	/// The error type is printable and is a real `std::error::Error`, which is
	/// what lets a caller report a failed search with `?` instead of matching on
	/// the engine.
	///
	/// Asserted at COMPILE time rather than by producing an error, and the
	/// reason is worth being honest about: neither arm can be reached from this
	/// crate. The Rust arm holds [`NoError`], which is uninhabited by
	/// construction, and PCRE2's reachable match-time failures are resource
	/// limits that `grep-pcre2` exposes no way to lower. A test that faked one
	/// would be testing the fake. What CAN break here is the impl being
	/// dropped, and that is what this catches.
	#[test]
	fn the_error_type_is_a_printable_std_error() {
		fn assert_usable<E: std::error::Error + fmt::Display + fmt::Debug>() {}
		assert_usable::<CompiledMatcherError>();
	}

	/// `new_captures` is `NoCaptures` on both arms, which is what lets the
	/// searcher treat the two engines identically. It is asserted because the
	/// `Matcher` trait would happily let one arm return real captures, and a
	/// caller that got them from one engine and not the other would be a
	/// difference invisible until a replacement pattern ran.
	#[test]
	fn neither_arm_offers_captures() {
		for matcher in [rust("(a)(b)"), pcre("(a)(b)")] {
			assert!(matcher.new_captures().is_ok());
			assert_eq!(matcher.capture_count(), 0);
		}
	}
}
